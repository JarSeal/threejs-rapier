import * as THREE from 'three/webgpu';
import { type ListBladeApi, type Pane } from 'tweakpane';
import type { BladeController, View } from '@tweakpane/core';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { llog } from '../../utils/Logger';
import { textureMapKeys } from '../../utils/constants';
import { CMP, type TCMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowCmp,
} from '../UI/DraggableWindow';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { getGeometryRegistry } from '../Geometry';
import { getTextureRegistry } from '../Texture';
import { getMaterialRegistry } from '../Material';
import { getCurrentSceneId, getGeneratedAppData, getGeneratedSceneData } from '../Scene';
import { getImportedAsset } from '../Import/ImportRegistry';
import { getAssetOwner } from '../Assets/AssetOwners';
import { DEBUG_ASSETS_BOOT_LS_KEY } from '../Config';
import {
  getAssetLoadReport,
  getAssetsWorkerInfo,
  getAssetsWorkerTarget,
} from '../Assets/AssetsAPI';
import type { AssetLoadReport, AssetsWorkerTarget } from '../Assets/AssetsAPITypes';
import type { ImportedGeometryInfo } from '../Import/ImportTypes';
import {
  computeUniqueEdgeCount,
  describeTexture,
  formatBytes,
  formatNumber,
  getFileType,
  getGeometryByteSize,
  getTextureImageSrc,
  getTriangleCount,
  getVertexCount,
  UNIQUE_EDGES_MAX_ENTRIES,
} from './_dbg__AssetStats';

type AssetKind = 'texture' | 'geometry';
type AssetRow = {
  kind: AssetKind;
  id: string;
  name: string;
  description?: string;
  /** Owner scene id (see AssetOwners). */
  owner?: string;
};
type Scope = 'SCENE' | 'ALL';

const UI_LS_KEY = 'AEK_debugAssetsUI';
const INFO_WIN_ID = 'assetsInfoWindow';

let uiState: { scope: Scope; loadingFolderExpanded: boolean } = {
  scope: 'SCENE',
  loadingFolderExpanded: false,
};
let listCmp: TCMP | null = null;
let lastListSignature = '';
let infoWindowCmp: TCMP | null = null;

const persistUIState = () => lsSetItem(UI_LS_KEY, uiState);

const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );

const rowKey = (kind: AssetKind, id: string) => `${kind}:${id}`;

// --- Generated data (declared assets, baked file sizes) ---

type DeclaredFile = {
  id?: string;
  fileName?: string | string[];
  path?: string;
  __fileSize?: number;
};
type GeneratedData = {
  textures?: Record<string, DeclaredFile>;
  importedAssets?: Record<string, DeclaredFile>;
  scenes: Record<
    string,
    { textures?: (string | DeclaredFile)[]; importedAssets?: (string | DeclaredFile)[] }
  >;
};

const getGeneratedData = () => getGeneratedAppData() as unknown as GeneratedData;

/** A texture's or import's declaration: the dev registry, else any scene's resolved entry (a
 * production-gathered build only keeps the scenes). */
const findDeclaration = (kind: 'textures' | 'importedAssets', id: string) => {
  const data = getGeneratedData();
  if (data[kind]?.[id]) return data[kind]![id];
  for (const scene of Object.values(data.scenes)) {
    const found = scene[kind]?.find((entry) => typeof entry !== 'string' && entry.id === id);
    if (found && typeof found !== 'string') return found;
  }
  return undefined;
};

const toIds = (entries?: (string | { id?: string })[]) =>
  (entries || []).map((entry) => (typeof entry === 'string' ? entry : entry.id)).filter(Boolean);

/** Assets the current scene's JSON declares: its textures, geometries, and the
 * geometries/textures its imported assets registered. */
const getSceneDeclaredKeys = () => {
  const keys = new Set<string>();
  const sceneId = getCurrentSceneId();
  const sceneData = sceneId ? getGeneratedSceneData(sceneId) : undefined;
  if (!sceneData) return keys;
  for (const id of toIds(sceneData.textures as (string | { id?: string })[])) {
    keys.add(rowKey('texture', id as string));
  }
  for (const id of toIds(sceneData.geometries as (string | { id?: string })[])) {
    keys.add(rowKey('geometry', id as string));
  }
  for (const importId of toIds(sceneData.importedAssets as (string | { id?: string })[])) {
    const manifest = getImportedAsset(importId as string);
    manifest?.geometries.forEach((g) => keys.add(rowKey('geometry', g.geometryId)));
    manifest?.textureIds.forEach((id) => keys.add(rowKey('texture', id)));
  }
  return keys;
};

// --- List ---

const getAllRows = (): AssetRow[] => {
  const rows: AssetRow[] = [];
  for (const [id, entry] of Object.entries(getTextureRegistry())) {
    const t = entry.resource;
    rows.push({
      kind: 'texture',
      id,
      name: (t.userData.name as string) || t.name || id,
      description: t.userData.description as string | undefined,
      owner: getAssetOwner(t),
    });
  }
  for (const [id, entry] of Object.entries(getGeometryRegistry())) {
    rows.push({
      kind: 'geometry',
      id,
      name: entry.debugData?.name || id,
      description: entry.debugData?.description,
      owner: getAssetOwner(entry.resource),
    });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
};

/** In this scene: declared by its JSON, or owned by it (registered or reused by its code too). */
const getListState = () => {
  const all = getAllRows();
  const declared = getSceneDeclaredKeys();
  const sceneId = getCurrentSceneId();
  const inScene = all.filter(
    (row) => declared.has(rowKey(row.kind, row.id)) || (sceneId && row.owner === sceneId)
  );
  const rows = uiState.scope === 'ALL' ? all : inScene;
  return { rows, notInSceneCount: all.length - inScene.length };
};

const updateSelectedClass = (key: string | null) => {
  const ulElem = listCmp?.elem.getElementsByTagName('ul')[0];
  if (!ulElem) return;
  for (const child of ulElem.children) {
    child.classList.toggle('selected', key !== null && child.getAttribute('data-key') === key);
  }
};

const openInfoWindow = (row: AssetRow) => {
  const key = rowKey(row.kind, row.id);
  const winState = getDraggableWindow(INFO_WIN_ID);
  if (winState?.isOpen && winState.data?.key === key) {
    closeDraggableWindow(INFO_WIN_ID);
    return;
  }
  openDraggableWindow({
    id: INFO_WIN_ID,
    position: { x: 110, y: 60 },
    size: { w: 420, h: 520 },
    saveToLS: true,
    title: `${row.kind === 'texture' ? 'Texture' : 'Geometry'}: ${row.name}`,
    isDebugWindow: true,
    content: createInfoContent,
    data: { key, kind: row.kind, id: row.id },
    onClose: () => updateSelectedClass(null),
  });
  updateSelectedClass(key);
};

const createListHtml = () => {
  const { rows, notInSceneCount } = getListState();
  const isAll = uiState.scope === 'ALL';
  const scopeButton =
    isAll || notInSceneCount
      ? CMP({
          onClick: () => {
            uiState.scope = isAll ? 'SCENE' : 'ALL';
            persistUIState();
            refreshList(true);
          },
          html: `<button class="debuggerSmallButton" title="${isAll ? "List only the current scene's assets (declared in its JSON, or owned by it)" : 'Also list the loaded assets the current scene neither declares nor owns (eg. registered at boot or left by a previous scene)'}">${
            isAll
              ? "Show only this scene's assets"
              : `+${notInSceneCount} loaded asset${notInSceneCount === 1 ? '' : 's'} not in this scene`
          }</button>`,
        })
      : '';

  let html = `<div><h3 class="listItemCount">${rows.length} ${isAll ? 'loaded assets' : 'assets in this scene'}:</h3>`;
  html += `<div style="margin: -0.8rem 0 1.2rem">${scopeButton}</div>`;
  html += '<ul class="ulList">';
  for (const row of rows) {
    const button = CMP({
      onClick: () => openInfoWindow(row),
      html: `<button class="listItemWithId" title="${esc(row.id)}">
  <span class="itemId">${esc(row.id)}</span>
  ${getSvgIcon(row.kind === 'texture' ? 'texture' : 'geometry', 'small')}
  <span><h4>${esc(row.name)}</h4>${row.description ? `<span style="opacity:0.7">${esc(row.description)}</span>` : ''}</span>
</button>`,
    });
    html += `<li data-key="${esc(rowKey(row.kind, row.id))}">${button}</li>`;
  }
  if (!rows.length) html += '<li class="emptyState">No loaded assets..</li>';
  html += '</ul></div>';
  return html;
};

const refreshList = (force?: boolean) => {
  const { rows, notInSceneCount } = getListState();
  const signature = `${uiState.scope}|${getCurrentSceneId()}|${notInSceneCount}|${rows
    .map((row) => `${row.kind}:${row.id}:${row.name}:${row.description || ''}`)
    .join(',')}`;
  if (!force && signature === lastListSignature) return;
  lastListSignature = signature;
  listCmp?.update({ html: createListHtml });
  const winState = getDraggableWindow(INFO_WIN_ID);
  if (winState?.isOpen && typeof winState.data?.key === 'string') {
    updateSelectedClass(winState.data.key);
  }
};

// --- Asset loading (assets worker) ---

/** Debug-only boot-time overrides, applied by loadConfig() on the next reload. */
type DebugAssetsBoot = {
  workerTarget?: AssetsWorkerTarget;
  gltfWorkerTarget?: AssetsWorkerTarget;
  textureWorkerTarget?: AssetsWorkerTarget;
};

const getBootOverrides = () => lsGetItem(DEBUG_ASSETS_BOOT_LS_KEY, {}) as DebugAssetsBoot;
/** The overrides this page load booted with (nothing else writes the key before this tab). */
let bootedOverrides: DebugAssetsBoot = {};

const THREAD_TEXT: Record<AssetsWorkerTarget, string> = {
  MAIN_THREAD: 'Main thread',
  WORKER_THREAD: 'Worker thread',
};

const describeWorkerStatus = () => {
  const info = getAssetsWorkerInfo();
  const caps = info.capabilities;
  const fallbacks = Object.entries(info.fallbackCounts)
    .filter(([, count]) => count > 0)
    .map(([cause, count]) => `${cause} ×${count}`);
  const last = info.lastFallback;
  return {
    status:
      info.status === 'FAILED'
        ? `FAILED: ${info.failReason}`
        : info.status === 'NOT_STARTED'
          ? 'NOT_STARTED (starts on the first worker-targeted load)'
          : info.status,
    capabilities: caps
      ? Object.entries(caps)
          .map(([name, isSupported]) => `${name} ${isSupported ? 'yes' : 'NO'}`)
          .join('\n')
      : '—',
    requests: `${info.inFlight} in flight, ${info.queued} queued`,
    fallbacks: fallbacks.length
      ? `${fallbacks.join(', ')}\nlast: ${last?.kind}, ${last?.detail}`
      : 'none',
  };
};

/** Where an asset was loaded, from its load report. */
const describeLoadReport = (report?: AssetLoadReport) => {
  if (!report) return { loadedOn: '— (not loaded through the assets API)', duration: '—' };
  const loadedOn = report.fallbackCause
    ? `${THREAD_TEXT[report.loadedOn]} (worker fallback: ${report.fallbackCause}, ${report.fallbackDetail})`
    : THREAD_TEXT[report.loadedOn];
  return { loadedOn, duration: `${report.durationMs.toFixed(1)} ms` };
};

const addLoadingFolder = (debugGUI: Pane) => {
  const folder = debugGUI.addFolder({
    title: 'Asset loading',
    expanded: uiState.loadingFolderExpanded,
  });
  folder.on('fold', (e) => {
    uiState.loadingFolderExpanded = e.expanded;
    persistUIState();
  });

  // Boot-time targets: written to LS here, applied by loadConfig() on the next reload
  const overrides = getBootOverrides();
  let updateReloadButton = () => {};
  const addTargetDropDown = (key: keyof DebugAssetsBoot, label: string) => {
    const dropDown = folder.addBlade({
      view: 'list',
      label,
      options: [
        { value: '', text: 'No override' },
        { value: 'MAIN_THREAD', text: THREAD_TEXT.MAIN_THREAD },
        { value: 'WORKER_THREAD', text: THREAD_TEXT.WORKER_THREAD },
      ],
      value: overrides[key] || '',
    }) as ListBladeApi<BladeController<View>>;
    dropDown.on('change', (e) => {
      const next = { ...getBootOverrides() };
      const value = e.value as unknown as AssetsWorkerTarget | '';
      if (value) next[key] = value;
      else delete next[key];
      lsSetItem(DEBUG_ASSETS_BOOT_LS_KEY, next);
      updateReloadButton();
    });
    return dropDown;
  };
  addTargetDropDown('workerTarget', 'Default target (boot)');
  addTargetDropDown('gltfWorkerTarget', 'GLTF target (boot)');
  addTargetDropDown('textureWorkerTarget', 'Texture target (boot)');
  // Enabled while the saved overrides differ from the ones this page load booted with
  const reloadButton = folder.addButton({ title: 'Reload to apply' });
  reloadButton.on('click', () => location.reload());
  updateReloadButton = () => {
    reloadButton.disabled = JSON.stringify(getBootOverrides()) === JSON.stringify(bootedOverrides);
  };
  updateReloadButton();

  const resolved = {
    current: `GLTF: ${THREAD_TEXT[getAssetsWorkerTarget('GLTF')]}\nTextures: ${THREAD_TEXT[getAssetsWorkerTarget('TEXTURE')]}`,
  };
  folder.addBinding(resolved, 'current', {
    label: 'Resolved targets',
    readonly: true,
    multiline: true,
    rows: 2,
  });

  // Live worker status (read-only, polled by Tweakpane)
  const status = describeWorkerStatus();
  folder.addBinding(status, 'status', { label: 'Worker status', readonly: true });
  folder.addBinding(status, 'capabilities', {
    label: 'Capabilities',
    readonly: true,
    multiline: true,
    rows: 3,
  });
  folder.addBinding(status, 'requests', { label: 'Requests', readonly: true });
  folder.addBinding(status, 'fallbacks', {
    label: 'Fallbacks',
    readonly: true,
    multiline: true,
    rows: 3,
  });
  return () => Object.assign(status, describeWorkerStatus());
};

// --- Info window ---

const field = (label: string, value: unknown) =>
  `<div><span class="winSmallLabel">${esc(label)}:</span> ${esc(value)}</div>`;

const section = (title: string, body: string) =>
  `<h4 style="margin: 1.6rem 0 0.4rem">${esc(title)}</h4>${body}`;

const vec = (v: { x: number; y: number; z: number; w?: number }) =>
  [v.x, v.y, v.z, ...(v.w !== undefined ? [v.w] : [])].map((n) => +n.toFixed(3)).join(', ');

const toUrls = (fileName?: string | string[], urlPath?: string) =>
  (Array.isArray(fileName) ? fileName : fileName ? [fileName] : []).map(
    (name) => new URL(`${urlPath || ''}${name}`, document.baseURI).href
  );

/** Sum of the content-length of HEAD requests to the URLs, or undefined if any is unknown. */
const measureFileSize = async (urls: string[]) => {
  let total = 0;
  for (const url of urls) {
    const response = await fetch(url, { method: 'HEAD' });
    const length = Number(response.headers.get('content-length'));
    if (!response.ok || !length) return undefined;
    total += length;
  }
  return total;
};

/** File size text: the size baked in by gatherAppData, else a "Measure" button (HEAD request). */
const createFileSizeCmp = (bakedSize: number | undefined, urls: string[]) => {
  if (bakedSize !== undefined) return CMP({ tag: 'span', text: formatBytes(bakedSize) });
  if (!urls.length) return CMP({ tag: 'span', text: '—' });
  const cmp: TCMP = CMP({
    tag: 'span',
    // Wrapped, so updating the text replaces the button instead of relabeling it
    html: `<span><button class="debuggerSmallButton" title="HEAD request for the content-length">Measure</button></span>`,
    onClick: async () => {
      cmp.update({ text: 'Measuring…' });
      const size = await measureFileSize(urls).catch(() => undefined);
      cmp.update({ text: size === undefined ? 'unknown (no content-length)' : formatBytes(size) });
    },
  });
  return cmp;
};

const describeOwner = (asset: object) =>
  getAssetOwner(asset) ?? '— (registered before the first scene load)';

const getTextureMaterialUsers = (texture: THREE.Texture, id: string) => {
  let users = 0;
  for (const entry of Object.values(getMaterialRegistry())) {
    const material = entry.resource as unknown as Record<string, unknown>;
    const uses = textureMapKeys.some((key) => {
      const t = material[key] as THREE.Texture | undefined;
      return t && (t === texture || t.userData?.id === id);
    });
    if (uses) users++;
  }
  return users;
};

const createTextureContent = (id: string) => {
  const entry = getTextureRegistry()[id];
  const texture = entry.resource;
  const importId = texture.userData.importId as string | undefined;
  const declared = findDeclaration('textures', id);
  const importDeclaration = importId ? findDeclaration('importedAssets', importId) : undefined;
  const importFile = importId ? getImportedAsset(importId)?.fileName : undefined;
  const report = getAssetLoadReport(importId ? `import:${importId}` : `texture:${id}`);

  let file = '—';
  let urls: string[] = [];
  if (declared?.fileName) {
    file = [declared.path, [declared.fileName].flat().join(', ')].filter(Boolean).join('');
    urls = toUrls(declared.fileName, declared.path);
  } else if (importFile) {
    file = `embedded in ${importFile}`;
  } else {
    // An <img> knows its URL; an ImageBitmap (assets worker) or HDR data doesn't, but the load
    // report does
    urls = getTextureImageSrc(texture) || (report?.sourceUrl ? [report.sourceUrl] : []);
    if (urls.length) file = urls.join(', ');
  }
  const fileType = importFile
    ? (texture.userData.mimeType as string | undefined) ?? '—'
    : getFileType(urls[0] || file);
  const fileSizeCmp = createFileSizeCmp(
    declared?.__fileSize ?? (importFile ? importDeclaration?.__fileSize : undefined),
    importFile ? toUrls(importFile) : urls
  );
  const users = getTextureMaterialUsers(texture, id);
  const d = describeTexture(texture);
  const load = describeLoadReport(report);

  const html = () => `<div>
${field('Type', d.kind)}
${field('Id', id)}
${field('File', file)}
${field('File type', fileType)}
<div><span class="winSmallLabel">${importFile ? 'Source file size' : 'File size'}:</span> ${fileSizeCmp}</div>
${field('Loaded on', load.loadedOn)}
${field(importId ? 'Load duration (whole import)' : 'Load duration', load.duration)}
${field('Used by materials', `${users} (texture ref counts aren't tracked)`)}
${field('Persistent', entry.persistent ? 'yes' : 'no')}
${field('Owner scene', describeOwner(texture))}
${section(
  'Texture',
  [
    field('Dimensions', d.dimensions),
    field('Color space', d.colorSpace),
    field('Format / type', `${d.format} / ${d.type}`),
    field('Mipmaps', d.mipmaps),
    field('Filtering', d.filtering),
    field('Wrap', d.wrap),
    field('Anisotropy', d.anisotropy),
    field('flipY', d.flipY),
    field('Est. GPU memory', d.gpuMemory),
  ].join('')
)}
${
  importId
    ? section(
        'Import',
        [
          field('Import id', importId),
          field('glTF slots', ((texture.userData.gltfSlots as string[]) || []).join(', ') || '—'),
        ].join('')
      )
    : ''
}
</div>`;
  return { html, log: () => llog('TEXTURE:***************', { id, texture, entry }) };
};

const createGeometryContent = (id: string) => {
  const entry = getGeometryRegistry()[id];
  const geometry = entry.resource;
  const importInfo = geometry.userData.importInfo as ImportedGeometryInfo | undefined;
  const manifest = importInfo ? getImportedAsset(importInfo.importId) : undefined;
  const importDeclaration = importInfo
    ? findDeclaration('importedAssets', importInfo.importId)
    : undefined;
  const generatorType = (geometry.userData.props as { type?: string } | undefined)?.type;
  const sourceFile = manifest?.fileName ?? importDeclaration?.fileName;
  const triangles = getTriangleCount(geometry);
  const load = importInfo
    ? describeLoadReport(getAssetLoadReport(`import:${importInfo.importId}`))
    : undefined;

  const fileSizeCmp = createFileSizeCmp(
    importDeclaration?.__fileSize,
    typeof sourceFile === 'string' ? toUrls(sourceFile) : []
  );
  const uniqueEdgesCmp: TCMP = geometry.index
    ? CMP({
        tag: 'span',
        html:
          geometry.index.count > UNIQUE_EDGES_MAX_ENTRIES
            ? `too large to compute (over ${formatNumber(UNIQUE_EDGES_MAX_ENTRIES)} indices)`
            : '<span><button class="debuggerSmallButton">Compute unique edges</button></span>',
        onClick: () => {
          if (!geometry.index || geometry.index.count > UNIQUE_EDGES_MAX_ENTRIES) return;
          uniqueEdgesCmp.update({
            text: formatNumber(computeUniqueEdgeCount(geometry) ?? undefined),
          });
        },
      })
    : CMP({ tag: 'span', text: '— (not indexed: every triangle has its own edges)' });

  const p = importInfo?.customProps;
  const html = () => `<div>
${field('Type', importInfo ? 'Imported geometry' : generatorType ? `${generatorType} (generated)` : geometry.type)}
${field('Id', id)}
${field('File', typeof sourceFile === 'string' ? sourceFile : '—')}
${field('File type', typeof sourceFile === 'string' ? getFileType(sourceFile) : '—')}
<div><span class="winSmallLabel">${importInfo ? 'Source file size' : 'File size'}:</span> ${fileSizeCmp}</div>
${load ? field('Loaded on', load.loadedOn) : ''}
${load ? field('Load duration (whole import)', load.duration) : ''}
${field('Ref count', entry.count)}
${field('Persistent', entry.persistent ? 'yes' : 'no')}
${field('Owner scene', describeOwner(geometry))}
${section(
  'Geometry',
  [
    field('Vertices', formatNumber(getVertexCount(geometry))),
    field('Triangles', formatNumber(triangles)),
    field('Edge instances (3 × triangles)', formatNumber(triangles * 3)),
    `<div><span class="winSmallLabel">Unique edges:</span> ${uniqueEdgesCmp}</div>`,
    field('Indexed', geometry.index ? 'yes' : 'no'),
    field('Attributes', Object.keys(geometry.attributes).join(', ')),
    field('Est. VRAM (buffers)', formatBytes(getGeometryByteSize(geometry))),
  ].join('')
)}
${
  importInfo && p
    ? section(
        'Import',
        [
          field('Import id', importInfo.importId),
          field('Node', [...importInfo.parentPath, importInfo.nodeName].join(' / ')),
          field('Position', vec(importInfo.transform.position)),
          field('Quaternion', vec(importInfo.transform.quaternion)),
          field('Scale', vec(importInfo.transform.scale)),
          field('DRACO-compressed', importInfo.isDracoCompressed ? 'yes' : 'no'),
          importInfo.textureSlots
            ? field(
                'Texture slots',
                Object.entries(importInfo.textureSlots)
                  .map(([slot, texId]) => `${slot}: ${texId}`)
                  .join(', ') || '—'
              )
            : '',
        ].join('')
      ) +
      section(
        'Custom props',
        [
          field('isPhysObj', p.isPhysObj),
          p.isPhysObj ? field('keepMesh', p.keepMesh) : '',
          p.rigidType ? field('rigidType', p.rigidType) : '',
          p.colliderParams ? field('Collider', p.colliderParams.type) : '',
          p.index !== undefined ? field('Compound index', p.index) : '',
          p.id !== undefined ? field('id', p.id) : '',
          p.rigidBodyUserData
            ? field('Rigid body userData', JSON.stringify(p.rigidBodyUserData))
            : '',
          p.warnings.length
            ? `<div class="debuggerWarningText"><span class="winSmallLabel">Warnings:</span> ${esc(p.warnings.join(' '))}</div>`
            : field('Warnings', 'none'),
          `<pre style="white-space:pre-wrap;font-size:1rem;opacity:0.8">${esc(JSON.stringify(p.raw, null, 1))}</pre>`,
        ].join('')
      )
    : ''
}
</div>`;
  return { html, log: () => llog('GEOMETRY:***************', { id, geometry, entry }) };
};

const createInfoContent = (data?: { [key: string]: unknown }) => {
  const d = data as { key: string; kind: AssetKind; id: string };
  infoWindowCmp?.remove();

  const isLoaded =
    d.kind === 'texture'
      ? Boolean(getTextureRegistry()[d.id])
      : Boolean(getGeometryRegistry()[d.id]);
  addOnCloseToWindow(INFO_WIN_ID, () => updateSelectedClass(null));
  updateSelectedClass(d.key);
  if (!isLoaded) {
    infoWindowCmp = CMP({
      class: 'winPaddedContent',
      html: `<div>${esc(d.kind)} "${esc(d.id)}" is not loaded (any more).</div>`,
    });
    return infoWindowCmp;
  }

  const content = d.kind === 'texture' ? createTextureContent(d.id) : createGeometryContent(d.id);
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this ${d.kind} to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: content.log,
  });
  infoWindowCmp = CMP({
    class: ['winPaddedContent'],
    html: () => `<div>
<div style="float:right">${logButton}</div>
${content.html()}
</div>`,
    onRemoveCmp: () => {
      infoWindowCmp = null;
    },
  });
  return infoWindowCmp;
};

export const _createAssetsDebugGUI = () => {
  uiState = { ...uiState, ...(lsGetItem(UI_LS_KEY, uiState) as typeof uiState) };
  bootedOverrides = getBootOverrides();

  const icon = getSvgIcon('assets');
  createDebuggerTab({
    id: 'assetsControls',
    buttonText: icon,
    title: 'Assets',
    orderNr: 8,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(UI_LS_KEY),
        onClear: () => lsRemoveItem(UI_LS_KEY),
        watchKey: UI_LS_KEY,
      });
      const { container, debugGUI } = createNewDebuggerPane('assets', `${icon} Assets`, [
        clearTabBtn,
      ]);
      const updateWorkerStatus = addLoadingFolder(debugGUI);

      // No registry change hooks to subscribe to: poll, rebuilding only when the listed rows (or
      // the scope/scene) changed, like the Physics API tab's entity list
      lastListSignature = '';
      const intervalId = setInterval(() => {
        refreshList();
        updateWorkerStatus();
      }, 500);
      listCmp = CMP({
        id: 'debuggerAssetsList',
        html: createListHtml,
        onRemoveCmp: () => clearInterval(intervalId),
      });
      container.add(listCmp);
      return container;
    },
  });

  // The window's `content` function can't survive DraggableWindow's JSON persistence: re-attach
  // it at boot so a window left open survives a reload (same as _dbg__PhysicsAPI.ts)
  setTimeout(() => {
    const winState = getDraggableWindow(INFO_WIN_ID);
    if (winState && !winState.content) {
      registerDraggableWindowCmp(INFO_WIN_ID, {
        content: createInfoContent,
        onClose: () => updateSelectedClass(null),
      });
    }
  }, 0);
};
