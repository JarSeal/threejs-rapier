import * as THREE from 'three/webgpu';
import {
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { llog } from '../../utils/Logger';
import { textureMapKeys } from '../../utils/constants';
import { CMP, type TCMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import {
  getDraggableWindowsOfKind,
  getKindWindowId,
  registerDraggableWindowKind,
  toggleDraggableWindow,
  updateDraggableWindow,
} from '../UI/DraggableWindow';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { getGeometryRegistry } from '../Geometry';
import { getTextureRegistry } from '../Texture';
import { getMaterialRegistry } from '../Material';
import { getCurrentSceneId, getGeneratedAppData, getGeneratedSceneData } from '../Scene';
import { getImportedAsset } from '../Import/ImportRegistry';
import { getAssetOwner } from '../Assets/AssetOwners';
import { isLoadingSourceFiles, toAppUrl } from '../Assets/AssetUrl';
import { DEBUG_ASSETS_BOOT_LS_KEY } from '../Config';
import {
  getAssetLoadReport,
  getAssetsWorkerInfo,
  getAssetsWorkerTarget,
} from '../Assets/AssetsAPI';
import type { AssetLoadReport, AssetsWorkerTarget } from '../Assets/AssetsAPITypes';
import type { ImportedGeometryInfo } from '../Import/ImportTypes';
import {
  generateLodChain,
  getLodChain,
  getLodChainOfLevel,
  isLodChainPending,
  releaseLodChain,
  type LodChain,
  type LodLevelVertices,
} from '../Lod/LodChains';
import type { GeneratedAssetFields } from '../../schemas/assetsConfigSchema';
import type { TextureAtlasSlotInfo } from '../../schemas/textureAtlasSchema';
import { getTextureArrayInfo } from '../TextureArray';
import { getTextureAtlasInfo } from '../TextureAtlas';
import {
  computeUniqueEdgeCount,
  describeTexture,
  formatBytes,
  formatNumber,
  getFileType,
  getGeometryByteSize,
  getTextureDepth,
  getTextureImageSrc,
  getTriangleCount,
  getVertexCount,
  UNIQUE_EDGES_MAX_ENTRIES,
} from './_dbg__AssetStats';
import { createTexturePreviewCmp, forgetTexturePreviewState } from './_dbg__AssetsPreview';
import styles from './Assets.module.scss';

type AssetKind = 'texture' | 'geometry';
type AssetRow = {
  kind: AssetKind;
  id: string;
  name: string;
  description?: string;
  /** What kind of texture, when the id doesn't say (an array, an atlas slot) */
  variant?: string;
  /** Owner scene id (see AssetOwners). */
  owner?: string;
};
type Scope = 'SCENE' | 'ALL';

/** The tab's UI key: the list scope (module-owned) next to the tab's folder states. */
const UI_LS_KEY = 'AEK_debugAssetsUI';
const TAB_ID = 'assetsControls';
/** The info windows' kind: one window per asset, keyed by its row key (`kind:id`) */
const INFO_WIN_ID = 'assetsInfoWindow';

const uiState: { scope: Scope } = { scope: 'SCENE' };

/** Merged, so the tab's folder states in the same key are kept. */
const persistUIState = () =>
  lsSetItem(UI_LS_KEY, { ...(lsGetItem(UI_LS_KEY, {}) as object), scope: uiState.scope });
const refreshAssetsTab = () => updateDebuggerTab(TAB_ID);

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
  /** The asset JSON's path (dev data) */
  __sourcePath?: string;
  /** A texture array asset's layer sources as its JSON lists them (dev data) */
  layers?: string[];
  /** A texture array asset's layer names */
  __layers?: string[];
  /** A texture atlas slot's layout and cell table */
  __atlas?: TextureAtlasSlotInfo;
} & GeneratedAssetFields;
type GeneratedData = {
  textures?: Record<string, DeclaredFile>;
  importedAssets?: Record<string, DeclaredFile>;
  scenes: Record<
    string,
    { textures?: (string | DeclaredFile)[]; importedAssets?: (string | DeclaredFile)[] }
  >;
};

const getGeneratedData = () => getGeneratedAppData() as unknown as GeneratedData;

/** A texture's or import's declaration: the current scene's resolved entry (a scene's save
 * entry can point the asset at another file, with its own pipeline output), else the dev registry,
 * else any scene's entry (a production-gathered build only keeps the scenes). */
const findDeclaration = (kind: 'textures' | 'importedAssets', id: string) => {
  const data = getGeneratedData();
  const findInScene = (scene?: GeneratedData['scenes'][string]) => {
    const found = scene?.[kind]?.find((entry) => typeof entry !== 'string' && entry.id === id);
    return found && typeof found !== 'string' ? found : undefined;
  };
  const sceneId = getCurrentSceneId();
  const inCurrentScene = sceneId ? findInScene(data.scenes[sceneId]) : undefined;
  if (inCurrentScene) return inCurrentScene;
  if (data[kind]?.[id]) return data[kind]![id];
  for (const scene of Object.values(data.scenes)) {
    const found = findInScene(scene);
    if (found) return found;
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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "array, 3 layers", "atlas slot, 6 cells": what a texture is when its id doesn't say. */
const getTextureVariant = (texture: THREE.Texture) => {
  const atlas = getTextureAtlasInfo(texture);
  if (atlas) return `atlas slot, ${plural(Object.keys(atlas.cells).length, 'cell')}`;
  const depth = getTextureDepth(texture);
  if (getTextureArrayInfo(texture) || depth > 1) return `array, ${plural(depth, 'layer')}`;
  return undefined;
};

const getAllRows = (): AssetRow[] => {
  const rows: AssetRow[] = [];
  for (const [id, entry] of Object.entries(getTextureRegistry())) {
    const t = entry.resource;
    rows.push({
      kind: 'texture',
      id,
      name: (t.userData.name as string) || t.name || id,
      description: t.userData.description as string | undefined,
      variant: getTextureVariant(t),
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

/** List row click: opens the asset's window, brings it to the front, or closes it when on top. */
const openInfoWindow = (key: string) => {
  const row = getAllRows().find((r) => rowKey(r.kind, r.id) === key);
  if (!row) return;
  toggleDraggableWindow({
    id: getKindWindowId(INFO_WIN_ID, key),
    kind: INFO_WIN_ID,
    position: { x: 110, y: 60 },
    size: { w: 420, h: 520 },
    saveToLS: true,
    title: `${row.kind === 'texture' ? 'Texture' : 'Geometry'}: ${row.name}`,
    isDebugWindow: true,
    data: { key, kind: row.kind, id: row.id },
    closeOnSceneChange: true,
  });
};

/** The list's count heading and its scope switch button. */
const getListHeadingHtml = () => {
  const { rows, notInSceneCount } = getListState();
  const isAll = uiState.scope === 'ALL';
  const scopeButton =
    isAll || notInSceneCount
      ? `<button class="debuggerSmallButton" title="${isAll ? "List only the current scene's assets (declared in its JSON, or owned by it)" : 'Also list the loaded assets the current scene neither declares nor owns (eg. registered at boot or left by a previous scene)'}">${
          isAll
            ? "Show only this scene's assets"
            : `+${notInSceneCount} loaded asset${notInSceneCount === 1 ? '' : 's'} not in this scene`
        }</button>`
      : '';
  return `<div><h3 class="listItemCount">${rows.length} ${isAll ? 'loaded assets' : 'assets in this scene'}:</h3>
<div style="margin: -0.8rem 0 1.2rem">${scopeButton}</div></div>`;
};

const getAssetsListData = (): DebuggerListItem[] =>
  getListState().rows.map((row) => ({
    itemId: rowKey(row.kind, row.id),
    title: row.name,
    subTitle: row.variant ? `${row.id} (${row.variant})` : row.id,
    tooltip: row.id,
    icon: row.kind === 'texture' ? 'texture' : 'geometry',
    ...(row.description ? { description: row.description } : {}),
  }));

// --- Asset loading (assets worker) ---

/** Debug-only boot-time overrides, applied on the next reload: the worker targets by
 * loadConfig(), `loadSourceFiles` by the asset URL resolution (isLoadingSourceFiles). */
type DebugAssetsBoot = {
  workerTarget?: AssetsWorkerTarget;
  gltfWorkerTarget?: AssetsWorkerTarget;
  textureWorkerTarget?: AssetsWorkerTarget;
  simplifyWorkerTarget?: AssetsWorkerTarget;
  /** Load the asset pipeline's source files instead of its outputs (p300 DD8 level 3) */
  loadSourceFiles?: boolean;
};
type WorkerTargetKey =
  | 'workerTarget'
  | 'gltfWorkerTarget'
  | 'textureWorkerTarget'
  | 'simplifyWorkerTarget';

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

/** Live worker status (read-only, polled by Tweakpane), synced on every tab refresh. */
const workerStatus = { status: '', capabilities: '', requests: '', fallbacks: '' };

const getLoadingFolder = (): DebuggerPaneItem => {
  // Boot-time targets: written to LS here, applied by loadConfig() on the next reload
  const overrides = getBootOverrides();
  const targetsProxy: Record<WorkerTargetKey, AssetsWorkerTarget | ''> = {
    workerTarget: overrides.workerTarget || '',
    gltfWorkerTarget: overrides.gltfWorkerTarget || '',
    textureWorkerTarget: overrides.textureWorkerTarget || '',
    simplifyWorkerTarget: overrides.simplifyWorkerTarget || '',
  };
  const targetDropDown = (key: WorkerTargetKey, label: string): DebuggerPaneItem => ({
    key,
    target: targetsProxy,
    label,
    options: [
      { value: '', text: 'No override' },
      { value: 'MAIN_THREAD', text: THREAD_TEXT.MAIN_THREAD },
      { value: 'WORKER_THREAD', text: THREAD_TEXT.WORKER_THREAD },
    ],
    onChange: (value) => {
      const next = { ...getBootOverrides() };
      if (value) next[key] = value as AssetsWorkerTarget;
      else delete next[key];
      lsSetItem(DEBUG_ASSETS_BOOT_LS_KEY, next);
      // Re-evaluates the reload button's disabled state
      refreshAssetsTab();
    },
  });
  const sourceFilesProxy = { loadSourceFiles: Boolean(overrides.loadSourceFiles) };
  const filesText = isLoadingSourceFiles()
    ? 'Source files (override)'
    : bootedOverrides.loadSourceFiles && !import.meta.env.DEV
      ? 'Pipeline outputs (override ignored: a production build has no sources)'
      : 'Pipeline outputs';
  const resolved = {
    current: `GLTF: ${THREAD_TEXT[getAssetsWorkerTarget('GLTF')]}\nTextures: ${THREAD_TEXT[getAssetsWorkerTarget('TEXTURE')]}\nLOD chains: ${THREAD_TEXT[getAssetsWorkerTarget('SIMPLIFY')]}\nFiles: ${filesText}`,
  };

  return {
    type: 'folder',
    id: 'loading',
    title: 'Asset loading',
    expanded: false,
    content: [
      targetDropDown('workerTarget', 'Default target (boot)'),
      targetDropDown('gltfWorkerTarget', 'GLTF target (boot)'),
      targetDropDown('textureWorkerTarget', 'Texture target (boot)'),
      targetDropDown('simplifyWorkerTarget', 'LOD chain target (boot)'),
      {
        // p300 DD8 level 3: A/B the asset pipeline's outputs against their sources. Only the dev
        // server serves the sources (src/ is the Vite root); a production build ignores it.
        key: 'loadSourceFiles',
        target: sourceFilesProxy,
        label: 'Load source files (boot)',
        onChange: (value) => {
          const next = { ...getBootOverrides() };
          if (value) next.loadSourceFiles = true;
          else delete next.loadSourceFiles;
          lsSetItem(DEBUG_ASSETS_BOOT_LS_KEY, next);
          refreshAssetsTab();
        },
      },
      {
        type: 'button',
        title: 'Reload to apply',
        // Enabled while the saved overrides differ from the ones this page load booted with
        disabled: () => JSON.stringify(getBootOverrides()) === JSON.stringify(bootedOverrides),
        onClick: () => location.reload(),
      },
      {
        key: 'current',
        target: resolved,
        label: 'Resolved',
        readonly: true,
        multiline: true,
        rows: 4,
      },
      { key: 'status', target: workerStatus, label: 'Worker status', readonly: true },
      {
        key: 'capabilities',
        target: workerStatus,
        label: 'Capabilities',
        readonly: true,
        multiline: true,
        rows: 3,
      },
      { key: 'requests', target: workerStatus, label: 'Requests', readonly: true },
      {
        key: 'fallbacks',
        target: workerStatus,
        label: 'Fallbacks',
        readonly: true,
        multiline: true,
        rows: 3,
      },
    ],
  };
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

const formatInOut = (bytes?: { in: number; out: number }) => {
  if (!bytes) return undefined;
  const change = bytes.in ? Math.round((bytes.out / bytes.in - 1) * 100) : 0;
  return `${formatBytes(bytes.in)} → ${formatBytes(bytes.out)} (${change > 0 ? '+' : ''}${change}%)`;
};

/**
 * The asset pipeline's side of a declared asset (p300): the file this page load loaded (the
 * pipeline's output, or its source with the "Load source files" override or without an output)
 * and the pipeline's figures. Undefined for an asset without pipeline data.
 * @param declared the asset's generated data
 * @param report its load report, whose `sourceUrl` is the URL it was loaded from
 * @param isImport whether the figures are a whole import's (shown for one of its parts)
 */
const describePipelineFile = (
  declared: DeclaredFile | undefined,
  report?: AssetLoadReport,
  isImport?: boolean
) => {
  if (!declared?.__url && !declared?.__sourceUrl) return undefined;
  const { __url, __sourceUrl, __bytes, __vramBytes, __codec } = declared;
  const isPacked = !declared.fileName;
  // Built from many files: no single source stands in for it (p299)
  const composedText = declared.__layers
    ? `a texture array of ${plural(declared.__layers.length, 'layer')}`
    : declared.__atlas
      ? 'an atlas slot, composed from its cells'
      : undefined;
  const loadedUrl = report?.sourceUrl;
  const isOutput = Boolean(loadedUrl && __url && loadedUrl === toAppUrl(__url));
  const isSource =
    !isOutput && Boolean(loadedUrl && __sourceUrl && loadedUrl === toAppUrl(__sourceUrl));

  let loadedAs = 'not the pipeline’s output or source';
  if (isOutput) {
    loadedAs =
      __url === __sourceUrl
        ? 'the source, passed through as is'
        : isPacked && isLoadingSourceFiles()
          ? composedText
            ? 'pipeline output: no single source file'
            : 'pipeline output: packed, no source file'
          : 'pipeline output';
  } else if (isSource) {
    loadedAs = __url
      ? 'source file, "Load source files" override'
      : 'source file: no pipeline output';
  }
  const loadedText = loadedUrl
    ? `${new URL(loadedUrl).pathname} (${loadedAs})`
    : '— (no load report)';
  const loadedBytes = isOutput
    ? __bytes?.out
    : isSource
      ? __bytes?.in ?? declared.__fileSize
      : undefined;

  const sectionHtml = section(
    isImport ? 'Asset pipeline (whole import)' : 'Asset pipeline',
    [
      field('Output', __url ?? '— (none: encoder missing, the encode failed, or not built yet)'),
      field(
        'Source',
        __sourceUrl ??
          (composedText
            ? `— (${composedText})`
            : isPacked
              ? '— (packed from several files)'
              : '— (not in production data)')
      ),
      __codec ? field('Codec', __codec) : '',
      field('Download', formatInOut(__bytes) ?? '—'),
      field(
        'Est. GPU memory',
        formatInOut(__vramBytes) ?? '— (not optimized: the pipeline doesn’t read the image)'
      ),
    ].join('')
  );
  return { loadedUrl, loadedText, loadedBytes, sectionHtml };
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

const table = (head: string[], rows: string[]) =>
  `<table class="${styles.assetsTable}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

const ARRAY_ORIGIN_TEXT = {
  RUNTIME: 'runtime (buildTextureArray)',
  BUILD: 'build time (a texture array asset, *.textureArray.json)',
};

/** The info window's array section (p299 D6): what it was built from and its layers.
 * @param registered the array asset's dev data registry entry (its JSON's layer list) */
const describeTextureArray = (texture: THREE.Texture, registered?: DeclaredFile) => {
  const info = getTextureArrayInfo(texture);
  if (!info) {
    return section(
      'Texture array',
      field('Layers', getTextureDepth(texture)) +
        field(
          'Members',
          '— (no member list: neither built by buildTextureArray nor a texture array asset)'
        )
    );
  }
  const isCompressed = info.kind === 'COMPRESSED';
  // The JSON's layer list (a texture id or a file), in dev data
  const sources = info.origin === 'BUILD' ? registered?.layers : undefined;
  const cpuCopy = info.cpuDataReleased
    ? 'released after the upload (not swappable): its byte sizes come from its layer size'
    : info.swappable
      ? 'kept, for setTextureArrayLayer'
      : info.origin === 'BUILD'
        ? 'kept, like every loaded KTX2 texture'
        : 'kept until its first upload (not swappable)';
  const rows = info.members.map(
    (member, i) =>
      `<tr><td class="${styles.assetsTableNumber}">${i}</td><td>${esc(member)}</td>${sources ? `<td>${esc(sources[i] ?? '—')}</td>` : ''}</tr>`
  );
  return section(
    'Texture array',
    [
      field('Origin', ARRAY_ORIGIN_TEXT[info.origin]),
      field(
        'Kind',
        isCompressed
          ? 'KTX2 layers (CompressedArrayTexture)'
          : 'image layers (DataArrayTexture, mipmaps generated on the GPU)'
      ),
      field('Layers', info.members.length),
      field(
        'Layer size',
        `${info.width} × ${info.height}, ${isCompressed ? plural(info.levels, 'mip level') : 'mipmaps generated on the GPU'}`
      ),
      field(
        'Bytes per layer',
        `${formatBytes(info.layerBytes)}${isCompressed ? ', every level' : ', level 0'}`
      ),
      field(
        'Swappable',
        info.swappable
          ? 'yes (setTextureArrayLayer)'
          : info.origin === 'BUILD'
            ? 'no (its layers are in its file)'
            : 'no'
      ),
      field('CPU copy', cpuCopy),
      table(
        ['#', info.origin === 'BUILD' ? 'Layer' : 'Member', ...(sources ? ['Source (JSON)'] : [])],
        rows
      ),
    ].join('')
  );
};

/** The info window's atlas section (p299 D6): the layout and the cell table. */
const describeTextureAtlas = (texture: THREE.Texture) => {
  const info = getTextureAtlasInfo(texture);
  if (!info) return '';
  const [layoutW, layoutH] = info.size;
  const dropped = Math.round(Math.log2(layoutW / info.width));
  const lastLevel = info.levels - 1;
  const loadedSlots = Object.values(getTextureRegistry())
    .map(({ resource }) => getTextureAtlasInfo(resource))
    .filter((slotInfo) => slotInfo?.id === info.id)
    .map((slotInfo) => slotInfo!.slot)
    .sort();
  const rows = Object.entries(info.cells).map(([cellId, cell]) => {
    const [u0, , , v1] = cell.uv;
    const [w, h] = cell.size;
    // Image px from the top left, like the JSON's rects (the UVs are v up)
    const x = Math.round(u0 * layoutW);
    const y = Math.round((1 - v1) * layoutH);
    const uv = cell.uv.map((n) => +n.toFixed(4)).join(', ');
    const dataRow = cell.data
      ? `<tr><td></td><td colspan="3" class="${styles.assetsTableSub}">data: ${esc(JSON.stringify(cell.data))}</td></tr>`
      : '';
    return `<tr><td>${esc(cellId)}</td><td class="${styles.assetsTableNumber}">${x}, ${y}</td><td class="${styles.assetsTableNumber}">${w} × ${h}</td><td>${uv}</td></tr>${dataRow}`;
  });
  return section(
    'Texture atlas',
    [
      field('Atlas', info.id),
      field('Slot', info.slot),
      field('Loaded slots', loadedSlots.join(', ')),
      field('Layout', `${layoutW} × ${layoutH} px, ${info.padding} px of padding (edge extended)`),
      field(
        'Levels kept apart',
        `${info.levels}, down to ${layoutW >> lastLevel} × ${layoutH >> lastLevel}`
      ),
      field(
        'File',
        `${info.width} × ${info.height}, ${plural(info.storedLevels, 'mip level')}${dropped ? ` (its maxSize dropped the top ${plural(dropped, 'level')})` : ''}`
      ),
      field('Cells', Object.keys(info.cells).length),
      table(['Cell', 'At (px)', 'Size (px)', 'UV rect (v up)'], rows),
      `<div class="${styles.assetsTableSub}">A cell's content in the layout: its padding surrounds it. UVs are what getAtlasCell and sampleAtlasCell use.</div>`,
    ].join('')
  );
};

const createTextureContent = (id: string) => {
  const entry = getTextureRegistry()[id];
  const texture = entry.resource;
  const importId = texture.userData.importId as string | undefined;
  const declared = findDeclaration('textures', id);
  // Authoring fields a scene entry leaves out (the JSON's path, an array's layer sources): only
  // dev data's registry has them
  const registered = getGeneratedData().textures?.[id];
  const importDeclaration = importId ? findDeclaration('importedAssets', importId) : undefined;
  const importFile = importId ? getImportedAsset(importId)?.fileName : undefined;
  const report = getAssetLoadReport(importId ? `import:${importId}` : `texture:${id}`);
  const pipeline = describePipelineFile(
    importFile ? importDeclaration : declared,
    report,
    Boolean(importFile)
  );

  const arrayInfo = getTextureArrayInfo(texture);
  const isArray = Boolean(arrayInfo) || getTextureDepth(texture) > 1;
  let file = '—';
  let urls: string[] = [];
  if (declared?.fileName) {
    file = [declared.path, [declared.fileName].flat().join(', ')].filter(Boolean).join('');
    urls = toUrls(declared.fileName, declared.path);
  } else if (importFile) {
    file = `embedded in ${importFile}`;
  } else if (declared?.__layers || declared?.__atlas) {
    // Production data has no JSON paths
    file =
      registered?.__sourcePath ??
      `— (${declared.__layers ? 'a texture array' : 'an atlas slot'} built by the asset pipeline)`;
  } else if (pipeline) {
    file = '— (packed by the asset pipeline)';
  } else if (arrayInfo?.origin === 'RUNTIME') {
    file = '— (built at runtime by buildTextureArray)';
  } else {
    // An <img> knows its URL; an ImageBitmap (assets worker) or HDR data doesn't, but the load
    // report does
    urls = getTextureImageSrc(texture) || (report?.sourceUrl ? [report.sourceUrl] : []);
    if (urls.length) file = urls.join(', ');
  }
  // The loaded file (the pipeline's output or source), not the declared one
  if (pipeline?.loadedUrl && !importFile) urls = [pipeline.loadedUrl];
  const fileType = importFile
    ? (texture.userData.mimeType as string | undefined) ?? '—'
    : getFileType(urls[0] || file);
  const fileSizeCmp = createFileSizeCmp(
    pipeline
      ? pipeline.loadedBytes
      : declared?.__fileSize ?? (importFile ? importDeclaration?.__fileSize : undefined),
    pipeline?.loadedUrl ? [pipeline.loadedUrl] : importFile ? toUrls(importFile) : urls
  );
  const fileSizeLabel = importFile
    ? pipeline
      ? 'Loaded import file size'
      : 'Source file size'
    : pipeline
      ? 'Loaded file size'
      : 'File size';
  const users = getTextureMaterialUsers(texture, id);
  const d = describeTexture(texture);
  const load = describeLoadReport(report);
  // An array's layers or an atlas slot's image (p299 D6)
  const previewCmp = createTexturePreviewCmp(
    texture,
    getKindWindowId(INFO_WIN_ID, rowKey('texture', id))
  );

  const html = () => `<div>
${field('Type', d.kind)}
${field('Id', id)}
${field('File', file)}
${pipeline ? field(importFile ? 'Loaded import file' : 'Loaded file', pipeline.loadedText) : ''}
${field('File type', fileType)}
<div><span class="winSmallLabel">${fileSizeLabel}:</span> ${fileSizeCmp}</div>
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
${isArray ? describeTextureArray(texture, registered) : ''}
${describeTextureAtlas(texture)}
${previewCmp ? section('Preview', `${previewCmp}`) : ''}
${pipeline?.sectionHtml ?? ''}
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

const VERTICES_TEXT: Record<LodLevelVertices, string> = {
  BASE: "the base's",
  WELDED: 'the welded copy',
  OWN: 'own',
};

/** A level's own bytes: its index, plus its vertex arrays when it has its own. */
const getLodLevelBytes = (geometryId: string, vertices: LodLevelVertices) => {
  const geometry = getGeometryRegistry()[geometryId]?.resource;
  if (!geometry) return undefined;
  return vertices === 'OWN' ? getGeometryByteSize(geometry) : geometry.index?.array.byteLength;
};

const describeLodChain = (chain: LodChain) => {
  const base = chain.levels[0];
  const welded = chain.levels.find((l) => l.vertices === 'WELDED');
  const weldedGeometry = welded ? getGeometryRegistry()[welded.geometryId]?.resource : undefined;
  const levelRows = chain.levels.slice(1).map((level, i) => {
    const bytes = getLodLevelBytes(level.geometryId, level.vertices);
    const percent = Math.round((level.triangles / base.triangles) * 100);
    return field(
      `LOD${i + 1}`,
      `${formatNumber(level.triangles)} triangles (${percent}%), error ${level.error.toFixed(4)} (≤ ~${(level.error * chain.extent).toPrecision(2)} units), ${bytes === undefined ? '—' : formatBytes(bytes)}, vertices: ${VERTICES_TEXT[level.vertices]}`
    );
  });
  const { report, options } = chain;
  return [
    field('Levels', `${chain.levels.length} (base + ${chain.levels.length - 1})`),
    ...levelRows,
    weldedGeometry
      ? field(
          'Welded vertex arrays',
          `${formatBytes(getGeometryByteSize(weldedGeometry) - (weldedGeometry.index?.array.byteLength ?? 0))} (shared by the levels)`
        )
      : '',
    field('Extent / radius', `${chain.extent.toPrecision(3)} / ${chain.radius.toPrecision(3)}`),
    field(
      'Generated on',
      report
        ? `${describeLoadReport(report).loadedOn}, ${report.durationMs.toFixed(1)} ms (main thread's own work ${report.mainThreadMs.toFixed(2)} ms)`
        : 'build time (asset pipeline), loaded with the GLB'
    ),
    field(
      'Options',
      `ratios ${options.ratios.join(', ')}, maxError ${options.maxError}, weights normal ${options.attributeWeights.normal} / uv ${options.attributeWeights.uv}${options.permissive ? ', permissive' : ''}${options.compactVertices ? ', compactVertices' : ''}${options.lockBorder ? ', lockBorder' : ''}`
    ),
  ].join('');
};

/** The info window's LOD chain section: the chain, or which chain a level belongs to, and the
 * generate / release buttons (p347 §2.5). */
const createLodChainCmp = (id: string) => {
  const windowId = getKindWindowId(INFO_WIN_ID, rowKey('geometry', id));
  const ofLevel = getLodChainOfLevel(id);
  if (ofLevel) {
    return CMP({
      html: `<div>${field('LOD level', `LOD${ofLevel.level} of "${ofLevel.chain.baseId}"`)}</div>`,
    });
  }
  const chain = getLodChain(id);
  const button = (action: string, text: string, title: string) =>
    `<button class="debuggerSmallButton" data-action="${action}" title="${esc(title)}">${esc(text)}</button>`;
  const buttons = [
    button(
      'generate',
      chain ? 'Regenerate' : 'Generate LOD chain',
      'generateLodChain() with the default options'
    ),
    button(
      'generatePermissive',
      chain ? 'Regenerate (permissive)' : 'Generate (permissive)',
      'With `permissive: true`: collapses across attribute seams (flat-shaded geometry needs it)'
    ),
    chain ? button('release', 'Release chain', 'releaseLodChain(): the levels are disposed') : '',
  ].join(' ');
  const cmp: TCMP = CMP({
    html: () =>
      `<div>${isLodChainPending(id) ? '<div>Generating…</div>' : chain ? describeLodChain(chain) : field('Chain', 'none')}<div style="margin-top: 0.6rem">${buttons}</div></div>`,
    onClick: async (e) => {
      const action = (e.target as HTMLElement).closest('button')?.dataset.action;
      if (!action || isLodChainPending(id)) return;
      if (action === 'release') {
        releaseLodChain(id);
      } else {
        const pendingChain = generateLodChain(id, { permissive: action === 'generatePermissive' });
        // Pending now: the content shows "Generating…"
        cmp.update();
        await pendingChain;
      }
      updateDraggableWindow(windowId);
      refreshAssetsTab();
    },
  });
  return cmp;
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
  const report = importInfo ? getAssetLoadReport(`import:${importInfo.importId}`) : undefined;
  const load = importInfo ? describeLoadReport(report) : undefined;
  const pipeline = importInfo ? describePipelineFile(importDeclaration, report, true) : undefined;

  const fileSizeCmp = createFileSizeCmp(
    pipeline ? pipeline.loadedBytes : importDeclaration?.__fileSize,
    pipeline?.loadedUrl
      ? [pipeline.loadedUrl]
      : typeof sourceFile === 'string'
        ? toUrls(sourceFile)
        : []
  );
  const loadedFile = pipeline?.loadedUrl ?? (typeof sourceFile === 'string' ? sourceFile : '');
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

  const lodChainCmp = createLodChainCmp(id);
  const p = importInfo?.customProps;
  const html = () => `<div>
${field('Type', importInfo ? 'Imported geometry' : generatorType ? `${generatorType} (generated)` : geometry.type)}
${field('Id', id)}
${field('File', typeof sourceFile === 'string' ? sourceFile : '—')}
${pipeline ? field('Loaded file', pipeline.loadedText) : ''}
${field('File type', loadedFile ? getFileType(loadedFile) : '—')}
<div><span class="winSmallLabel">${pipeline ? 'Loaded file size' : importInfo ? 'Source file size' : 'File size'}:</span> ${fileSizeCmp}</div>
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
${section('LOD chain', `${lodChainCmp}`)}
${pipeline?.sectionHtml ?? ''}
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

  // The content is built before the window state is open: refresh the list selection after it
  queueMicrotask(refreshAssetsTab);
  if (!isAssetLoaded(d)) {
    return CMP({
      class: 'winPaddedContent',
      html: `<div>${esc(d.kind)} "${esc(d.id)}" is not loaded (any more).</div>`,
    });
  }

  const content = d.kind === 'texture' ? createTextureContent(d.id) : createGeometryContent(d.id);
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this ${d.kind} to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: content.log,
  });
  return CMP({
    class: ['winPaddedContent'],
    html: () => `<div>
<div style="float:right">${logButton}</div>
${content.html()}
</div>`,
  });
};

const isAssetLoaded = ({ kind, id }: { kind: AssetKind; id: string }) =>
  kind === 'texture' ? Boolean(getTextureRegistry()[id]) : Boolean(getGeometryRegistry()[id]);

registerDraggableWindowKind(INFO_WIN_ID, {
  content: createInfoContent,
  onClose: (id) => {
    forgetTexturePreviewState(id);
    refreshAssetsTab();
  },
  // Kept open on a scene change when the asset is still loaded (eg. shared with the next scene)
  sceneTargetResolver: (data) => isAssetLoaded(data as { kind: AssetKind; id: string }),
});

export const _createAssetsDebugGUI = () => {
  const savedScope = (lsGetItem(UI_LS_KEY, {}) as { scope?: Scope }).scope;
  if (savedScope === 'SCENE' || savedScope === 'ALL') uiState.scope = savedScope;
  bootedOverrides = getBootOverrides();

  createDebuggerTab({
    id: TAB_ID,
    title: 'Assets',
    icon: 'assets',
    uiLsKey: UI_LS_KEY,
    // The tab's own LS data is its UI key (the scope and the folder states)
    clearLSButton: false,
    headerButtons: () => [
      createClearTabLSButton({
        hasData: () => lsKeyHasData(UI_LS_KEY),
        onClear: () => lsRemoveItem(UI_LS_KEY),
        watchKey: UI_LS_KEY,
      }),
    ],
    // No registry change hooks to subscribe to: poll (the list only re-renders when its rows
    // or the scope/scene changed, like the Physics API tab's entity list)
    refreshIntervalMs: 500,
    onRefresh: () => Object.assign(workerStatus, describeWorkerStatus()),
    content: () => [
      { pane: true, content: [getLoadingFolder()] },
      CMP({
        html: getListHeadingHtml,
        onClick: (e) => {
          if (!(e.target as HTMLElement).closest('button')) return;
          uiState.scope = uiState.scope === 'ALL' ? 'SCENE' : 'ALL';
          persistUIState();
          refreshAssetsTab();
        },
      }),
      debuggerListCMP({
        id: 'assets',
        emptyText: 'No loaded assets..',
        data: getAssetsListData,
        selectedItemId: () =>
          getDraggableWindowsOfKind(INFO_WIN_ID).map((win) => String(win.data?.key)),
        perItemConfig: { onClick: openInfoWindow },
      }),
    ],
  });
};
