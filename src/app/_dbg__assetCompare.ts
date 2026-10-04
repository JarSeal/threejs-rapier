import * as THREE from 'three/webgpu';
import { getGeometryRegistry } from '../_engine/core/Geometry';
import { importAssetAsync, releaseImportedAsset } from '../_engine/core/Import/ImportRegistry';
import type { ImportedGeometryInfo } from '../_engine/core/Import/ImportTypes';
import { deriveColliderFromGeometry } from '../_engine/core/Import/MeshColliderGeometry';
import type { ColliderParams } from '../_engine/core/Physics/PhysicsAPITypes';
import { getRenderer } from '../_engine/core/Renderer';
import {
  addDebugToast,
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
} from '../_engine/debug/DebuggerGUI';
import { llog, lwarn } from '../_engine/utils/Logger';
import {
  ASSET_COMPARE_SCENE_ID,
  COMPARE_VARIANTS,
  compareConfig,
  getCompareSlots,
  PHASE1_URL,
  rebuildCompareSlot,
  setCompareChangeListener,
  showCompareSlot,
  toggleCompareSlot,
  type CompareSlot,
  type CompareSlotId,
  type CompareTexture,
  type CompareVariant,
} from './assetCompare';

const TAB_ID = 'assetCompare';
const LS_KEY = 'appDebugAssetCompare';

// ---------------------------------------------------------------------------------------------
// phase1Variants.ts's report.json (the fields read here)
// ---------------------------------------------------------------------------------------------

type ReportTexture = {
  file: string;
  kind: string;
  bytes: number;
  vramBytes: { rgba8: number; bc7Astc: number; etc2: number };
  metrics?: {
    psnr?: Record<string, number>;
    normalErrorDeg?: { mean: number; p99: number; max: number };
  };
};
type ReportModel = { file: string; bytes: number; textures?: ReportTexture[] };
type Report = { textures: ReportTexture[]; models: ReportModel[] };

let report: Report | null = null;
let reportRequest: Promise<void> | null = null;

const loadReport = () => {
  reportRequest ??= fetch(`${PHASE1_URL}/report.json`)
    .then((res) => res.json() as Promise<Report>)
    .then((json) => {
      report = json;
      updateDebuggerTab(TAB_ID);
    })
    .catch((error) => lwarn('[assetCompare] Could not load report.json', error));
  return reportRequest;
};

/** A texture's report entry: a standalone file's, or the prop GLB's texture of the same kind. */
const findReportTexture = ({ file, reportKind }: CompareTexture) => {
  if (!report) return undefined;
  if (!reportKind) return report.textures.find((t) => t.file === file);
  const glb = file.split('#')[0];
  return report.models.find((m) => m.file === glb)?.textures?.find((t) => t.kind === reportKind);
};

// ---------------------------------------------------------------------------------------------
// Slot rows
// ---------------------------------------------------------------------------------------------

const formatBytes = (bytes?: number) => {
  if (bytes === undefined) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

/** What three counts for the texture in `renderer.info` (the GPU memory tab's figure, with
 * compressed textures at their uploaded bytes, p300 1b). Undefined until it was first drawn. */
const getMeasuredVram = (texture: THREE.Texture) => {
  const info = getRenderer()?.info as unknown as { memoryMap?: WeakMap<object, unknown> };
  const size = info?.memoryMap?.get(texture);
  return typeof size === 'number' ? size : undefined;
};

const formatMetrics = (entry?: ReportTexture) => {
  const metrics = entry?.metrics;
  if (!metrics) return '';
  const parts: string[] = [];
  if (metrics.psnr) {
    parts.push(
      `PSNR ${Object.entries(metrics.psnr)
        .map(([channels, db]) => `${channels} ${db.toFixed(1)}`)
        .join(', ')} dB`
    );
  }
  if (metrics.normalErrorDeg) {
    const { mean, p99 } = metrics.normalErrorDeg;
    parts.push(`normal ${mean.toFixed(1)}° mean, ${p99.toFixed(1)}° p99`);
  }
  return parts.join(' · ');
};

const getSlotRows = (slot: CompareSlot): DebuggerListItem[] => {
  const isShown = compareConfig.shown === slot.id;
  const rows: DebuggerListItem[] = slot.messages.map((message, i) => ({
    itemId: `message${i}`,
    title: message,
    badge: '!',
  }));
  if (slot.isBuilding) rows.push({ itemId: 'building', title: 'Loading…', titlePlaceholder: true });
  if (!slot.built) return rows;

  let fileBytes = 0;
  let vramBytes = 0;
  let isVramComplete = true;
  const textureRows = slot.textures.map((t, i): DebuggerListItem => {
    const entry = findReportTexture(t);
    const vram = getMeasuredVram(t.texture);
    if (!t.reportKind) fileBytes += entry?.bytes ?? 0;
    if (vram === undefined) isVramComplete = false;
    else vramBytes += vram;
    const uncompressed = entry ? ` (RGBA8 ${formatBytes(entry.vramBytes.rgba8)})` : '';
    return {
      itemId: `texture${i}`,
      title: `${t.subject}: ${t.name}`,
      subTitle: t.file,
      suffix: vram === undefined ? 'not drawn' : formatBytes(vram),
      description: [`file ${formatBytes(entry?.bytes)}${uncompressed}`, formatMetrics(entry)]
        .filter(Boolean)
        .join(' · '),
      disabled: !isShown,
    };
  });
  const propBytes = slot.propFile
    ? report?.models.find((m) => m.file === slot.propFile)?.bytes
    : undefined;
  return [
    ...rows,
    {
      itemId: 'total',
      title: `Total VRAM${isVramComplete ? '' : ' (drawn so far)'}`,
      badge: isShown ? 'shown' : undefined,
      suffix: formatBytes(vramBytes),
      description: `files: textures ${formatBytes(fileBytes)}${slot.propFile ? `, prop GLB ${formatBytes(propBytes)}` : ''}`,
      disabled: !isShown,
    },
    ...textureRows,
  ];
};

// ---------------------------------------------------------------------------------------------
// Collider check (DD6): every collider copy against its source, with the engine's own
// derivation (deriveColliderFromGeometry), as spawnImportedAsset would build them
// ---------------------------------------------------------------------------------------------

const COLLIDER_MODELS = ['stairsStraightTrimesh', 'obstacles', 'terrainSmooth'];
const COLLIDER_VARIANTS = ['source', 'quantized', 'meshopt', 'meshoptLossless'] as const;
/** Max deviation that still counts as the same collider (16-bit quantization is ~1 mm here). */
const TOLERANCE_M = 0.01;

const getColliderFile = (model: string, variant: (typeof COLLIDER_VARIANTS)[number]) =>
  variant === 'source'
    ? `/debugger/assets/testModels/${model}.glb`
    : `${PHASE1_URL}/colliders/${model}_${variant}.glb`;

type ColliderShape = {
  nodeKey: string;
  type: string;
  /** The collider's world AABB (body at the node's position and rotation). */
  box: THREE.Box3;
  /** The visible mesh's world AABB (geometry bounds × node transform). */
  meshBox: THREE.Box3;
  /** HEIGHTFIELD: world heights, in Rapier's order. */
  worldHeights?: Float32Array;
  triangles?: number;
  /** Why the collider wasn't built (the derivation returned null or threw). */
  skipped?: string;
};

type ColliderResult = {
  model: string;
  variant: string;
  type: string;
  nodes: number;
  /** Worst AABB deviation from the source's collider (m). */
  vsSource: number;
  /** Worst AABB deviation from its own mesh (m). */
  vsMesh: number;
  /** Worst HEIGHTFIELD height deviation from the source's (m). */
  heights?: number;
  triangleMismatch?: boolean;
  skipped: number;
  failedNodes: string[];
};

let colliderResults: ColliderResult[] | null = null;
let isColliderCheckRunning = false;

const boxDeviation = (a: THREE.Box3, b: THREE.Box3) =>
  Math.max(
    Math.abs(a.min.x - b.min.x),
    Math.abs(a.min.y - b.min.y),
    Math.abs(a.min.z - b.min.z),
    Math.abs(a.max.x - b.max.x),
    Math.abs(a.max.y - b.max.y),
    Math.abs(a.max.z - b.max.z)
  );

/** The shape's AABB in the body's space (the derived params already carry the node's scale). */
const getLocalShapeBox = (c: ColliderParams) => {
  const box = new THREE.Box3();
  if ((c.type === 'TRIMESH' || c.type === 'CONVEXHULL') && c.vertices) {
    const v = c.vertices;
    for (let i = 0; i < v.length; i += 3)
      box.expandByPoint(new THREE.Vector3(v[i], v[i + 1], v[i + 2]));
  } else if (c.type === 'HEIGHTFIELD' && c.heights && c.scale) {
    let min = Infinity;
    let max = -Infinity;
    for (const h of c.heights) {
      min = Math.min(min, h * c.scale.y);
      max = Math.max(max, h * c.scale.y);
    }
    box.set(
      new THREE.Vector3(-c.scale.x / 2, min, -c.scale.z / 2),
      new THREE.Vector3(c.scale.x / 2, max, c.scale.z / 2)
    );
  } else if (c.type === 'BOX' || c.type === 'CUBOID') {
    box.set(
      new THREE.Vector3(-(c.hx ?? 0), -(c.hy ?? 0), -(c.hz ?? 0)),
      new THREE.Vector3(c.hx ?? 0, c.hy ?? 0, c.hz ?? 0)
    );
  } else if (c.type === 'BALL' || c.type === 'SPHERE') {
    box.setFromCenterAndSize(
      new THREE.Vector3(),
      new THREE.Vector3().setScalar((c.radius ?? 0) * 2)
    );
  } else if (c.type === 'CAPSULE' || c.type === 'CYLINDER' || c.type === 'CONE') {
    const r = c.radius ?? 0;
    const hh = (c.halfHeight ?? 0) + (c.type === 'CAPSULE' ? r : 0);
    box.set(new THREE.Vector3(-r, -hh, -r), new THREE.Vector3(r, hh, r));
  }
  return box;
};

const describeColliders = (importId: string, geometries: ImportedGeometryInfo[]) => {
  const registry = getGeometryRegistry();
  const counts = new Map<string, number>();
  const shapes: ColliderShape[] = [];
  for (const info of geometries) {
    const count = (counts.get(info.nodeName) || 0) + 1;
    counts.set(info.nodeName, count);
    const colliderParams = info.customProps.colliderParams;
    const geometry = registry[info.geometryId]?.resource;
    if (!info.customProps.isPhysObj || !colliderParams || !geometry) continue;

    const { position: p, quaternion: q, scale: s } = info.transform;
    const position = new THREE.Vector3(p.x, p.y, p.z);
    const quaternion = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const nodeMatrix = new THREE.Matrix4().compose(
      position,
      quaternion,
      new THREE.Vector3(s.x, s.y, s.z)
    );
    const bodyMatrix = new THREE.Matrix4().compose(
      position,
      quaternion,
      new THREE.Vector3(1, 1, 1)
    );
    geometry.computeBoundingBox();
    const meshBox = geometry.boundingBox!.clone().applyMatrix4(nodeMatrix);
    const nodeKey = `${info.nodeName}#${count}`;

    let collider: ColliderParams | null = null;
    let error: string | undefined;
    try {
      collider = deriveColliderFromGeometry(colliderParams, { geometry, info });
    } catch (e) {
      // spawnImportedAsset would throw here too
      error = (e as Error).message;
      lwarn(`[assetCompare] ${importId} ${nodeKey}: the collider derivation threw`, e);
    }
    if (!collider) {
      shapes.push({
        nodeKey,
        type: colliderParams.type,
        box: new THREE.Box3(),
        meshBox,
        skipped: error ? `threw: ${error}` : 'skipped',
      });
      continue;
    }
    const shape: ColliderShape = {
      nodeKey,
      type: collider.type,
      box: getLocalShapeBox(collider).applyMatrix4(bodyMatrix),
      meshBox,
    };
    if (collider.type === 'HEIGHTFIELD' && collider.heights && collider.scale) {
      const { y: scaleY } = collider.scale;
      shape.worldHeights = collider.heights.map((h) => p.y + h * scaleY);
    }
    if (collider.type === 'TRIMESH' && collider.indices)
      shape.triangles = collider.indices.length / 3;
    shapes.push(shape);
  }
  llog(`[assetCompare] ${importId}: ${shapes.length} colliders`);
  return shapes;
};

const runColliderCheck = async () => {
  if (isColliderCheckRunning) return;
  isColliderCheckRunning = true;
  updateDebuggerTab(TAB_ID, { rebuild: true });
  const results: ColliderResult[] = [];
  try {
    for (const model of COLLIDER_MODELS) {
      let sourceShapes: Map<string, ColliderShape> | null = null;
      for (const variant of COLLIDER_VARIANTS) {
        const importId = `assetCompareColliders/${model}/${variant}`;
        const manifest = await importAssetAsync({
          id: importId,
          fileName: getColliderFile(model, variant),
          throwOnError: true,
        });
        const shapes = describeColliders(importId, manifest!.geometries);
        releaseImportedAsset(importId);
        if (variant === 'source') sourceShapes = new Map(shapes.map((s) => [s.nodeKey, s]));

        const byType = new Map<string, ColliderShape[]>();
        for (const shape of shapes)
          byType.set(shape.type, [...(byType.get(shape.type) || []), shape]);
        for (const [type, typeShapes] of byType) {
          const result: ColliderResult = {
            model,
            variant,
            type,
            nodes: typeShapes.length,
            vsSource: 0,
            vsMesh: 0,
            skipped: 0,
            failedNodes: [],
          };
          for (const shape of typeShapes) {
            if (shape.skipped) {
              result.skipped++;
              result.failedNodes.push(`${shape.nodeKey} (${shape.skipped})`);
              continue;
            }
            result.vsMesh = Math.max(result.vsMesh, boxDeviation(shape.box, shape.meshBox));
            const source = sourceShapes?.get(shape.nodeKey);
            if (!source || source.skipped) continue;
            const deviation = boxDeviation(shape.box, source.box);
            result.vsSource = Math.max(result.vsSource, deviation);
            let isFailed = deviation > TOLERANCE_M;
            if (shape.worldHeights && source.worldHeights) {
              let maxDiff = shape.worldHeights.length === source.worldHeights.length ? 0 : Infinity;
              for (let i = 0; i < shape.worldHeights.length && maxDiff !== Infinity; i++) {
                maxDiff = Math.max(
                  maxDiff,
                  Math.abs(shape.worldHeights[i] - source.worldHeights[i])
                );
              }
              result.heights = Math.max(result.heights ?? 0, maxDiff);
              if (maxDiff > TOLERANCE_M) isFailed = true;
            }
            if (shape.triangles !== undefined && shape.triangles !== source.triangles) {
              result.triangleMismatch = true;
              isFailed = true;
            }
            if (isFailed) result.failedNodes.push(shape.nodeKey);
          }
          results.push(result);
        }
      }
    }
  } catch (error) {
    lwarn('[assetCompare] Collider check failed', error);
  }
  colliderResults = results;
  isColliderCheckRunning = false;
  llog('[assetCompare] Collider check', results);
  updateDebuggerTab(TAB_ID, { rebuild: true });
};

const formatMeters = (m: number) =>
  !Number.isFinite(m) ? '∞' : m >= 1 ? `${m.toFixed(2)} m` : `${(m * 1000).toFixed(1)} mm`;

const getColliderRows = (): DebuggerListItem[] => {
  if (isColliderCheckRunning)
    return [{ itemId: 'running', title: 'Running…', titlePlaceholder: true }];
  return (colliderResults || []).map((r, i) => {
    const isSource = r.variant === 'source';
    const isOk = !r.failedNodes.length;
    return {
      itemId: `collider${i}`,
      title: `${r.model} ${r.variant}`,
      badge: r.type,
      subTitle: `${r.nodes} node${r.nodes === 1 ? '' : 's'}`,
      suffix: isSource
        ? 'source'
        : r.skipped === r.nodes
          ? '✗ not built'
          : `${isOk ? '✓' : '✗'} Δ ${formatMeters(r.vsSource)}`,
      description: [
        `vs own mesh Δ ${formatMeters(r.vsMesh)}`,
        r.heights !== undefined ? `heights Δ ${formatMeters(r.heights)}` : '',
        r.triangleMismatch ? 'triangle count differs' : '',
        r.failedNodes.length ? `failed: ${r.failedNodes.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };
  });
};

// ---------------------------------------------------------------------------------------------
// Measure all variants (p300 1e): builds every variant in slot B, shows it until all its textures
// were drawn, and records what this device made of them (the GPU format the KTX2 files were
// transcoded to, three's VRAM figure, the build time). The same run on WebGL2 headless, desktop
// WebGPU and the phones gives 1f its table: "Copy results" puts the JSON on the clipboard.
// ---------------------------------------------------------------------------------------------

type MeasuredTexture = {
  subject: string;
  name: string;
  file: string;
  /** The three format constant the texture was uploaded as (eg. `RGBA_BPTC_Format`). */
  format: string;
  width: number;
  height: number;
  fileBytes?: number;
  vramBytes?: number;
  rgba8Bytes?: number;
};

type MeasuredVariant = {
  variant: string;
  normalMode: boolean;
  /** Load, transcode and import (rebuildCompareSlot), until the slot was built. */
  buildMs: number;
  /** Until every texture was drawn (shader compile and upload included). */
  firstDrawMs: number | null;
  textureFileBytes: number;
  propFileBytes?: number;
  vramBytes: number;
  textures: MeasuredTexture[];
  messages: string[];
};

type MeasureResults = {
  measuredAt: string;
  backend: string;
  adapter: string;
  userAgent: string;
  devicePixelRatio: number;
  variants: MeasuredVariant[];
};

/** Waits until every texture was drawn (in `renderer.info.memoryMap`), or the timeout. */
const MEASURE_DRAW_TIMEOUT_MS = 30000;

let measureResults: MeasureResults | null = null;
let measureProgress: string | null = null;

const FORMAT_NAMES = new Map<number, string>();
for (const [key, value] of Object.entries(THREE)) {
  if (key.endsWith('Format') && typeof value === 'number' && !FORMAT_NAMES.has(value))
    FORMAT_NAMES.set(value, key);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const getBackendInfo = () => {
  const backend = getRenderer()?.backend as unknown as {
    isWebGPUBackend?: boolean;
    device?: { adapterInfo?: Record<string, string> };
    gl?: WebGL2RenderingContext;
  };
  if (backend?.isWebGPUBackend) {
    const info = backend.device?.adapterInfo;
    const adapter = info
      ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ')
      : 'unknown';
    return { backend: 'WebGPU', adapter };
  }
  const gl = backend?.gl;
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  const adapter = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  return { backend: 'WebGL2', adapter };
};

const measureSlot = (slot: CompareSlot): MeasuredTexture[] =>
  slot.textures.map((t) => {
    const entry = findReportTexture(t);
    const image = t.texture.image as { width?: number; height?: number } | undefined;
    return {
      subject: t.subject,
      name: t.name,
      file: t.file,
      format: FORMAT_NAMES.get(t.texture.format) ?? String(t.texture.format),
      width: image?.width ?? 0,
      height: image?.height ?? 0,
      fileBytes: t.reportKind ? undefined : entry?.bytes,
      vramBytes: getMeasuredVram(t.texture),
      rgba8Bytes: entry?.vramBytes.rgba8,
    };
  });

/** Every variant in slot B, one after another; slot B's settings and the shown slot are restored
 * at the end. Returns the results (also kept for the tab and "Copy results"). */
export const measureAllVariants = async () => {
  if (measureProgress) return measureResults;
  await loadReport();
  const saved = {
    variantB: compareConfig.variantB,
    normalModeB: compareConfig.normalModeB,
    shown: compareConfig.shown,
  };
  const runs = COMPARE_VARIANTS.flatMap(
    (variant): { variant: CompareVariant; normalMode: boolean }[] =>
      variant === 'png'
        ? [{ variant, normalMode: false }]
        : [false, true].map((normalMode) => ({ variant, normalMode }))
  );
  const results: MeasureResults = {
    measuredAt: new Date().toISOString(),
    ...getBackendInfo(),
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    variants: [],
  };
  const slot = getCompareSlots().B;
  try {
    for (const [i, run] of runs.entries()) {
      measureProgress = `${i + 1} / ${runs.length}: ${run.variant}${run.normalMode ? ' (normal mode)' : ''}`;
      compareConfig.variantB = run.variant;
      compareConfig.normalModeB = run.normalMode;
      const start = performance.now();
      await rebuildCompareSlot('B');
      const buildMs = performance.now() - start;
      showCompareSlot('B');
      let firstDrawMs: number | null = null;
      while (performance.now() - start < MEASURE_DRAW_TIMEOUT_MS) {
        await nextFrame();
        if (slot.textures.every((t) => getMeasuredVram(t.texture) !== undefined)) {
          firstDrawMs = performance.now() - start;
          break;
        }
      }
      const textures = measureSlot(slot);
      results.variants.push({
        variant: run.variant,
        normalMode: run.normalMode,
        buildMs: Math.round(buildMs),
        firstDrawMs: firstDrawMs === null ? null : Math.round(firstDrawMs),
        textureFileBytes: textures.reduce((sum, t) => sum + (t.fileBytes ?? 0), 0),
        propFileBytes: slot.propFile
          ? report?.models.find((m) => m.file === slot.propFile)?.bytes
          : undefined,
        vramBytes: textures.reduce((sum, t) => sum + (t.vramBytes ?? 0), 0),
        textures,
        messages: [...slot.messages, ...(firstDrawMs === null ? ['not all textures drawn'] : [])],
      });
    }
  } finally {
    measureProgress = null;
    Object.assign(compareConfig, { variantB: saved.variantB, normalModeB: saved.normalModeB });
    await rebuildCompareSlot('B');
    showCompareSlot(saved.shown);
  }
  measureResults = results;
  llog('[assetCompare] Measured all variants', results);
  updateDebuggerTab(TAB_ID, { rebuild: true });
  return results;
};

const copyMeasureResults = async () => {
  if (!measureResults) return;
  try {
    // A button click (user activation): Safari refuses the clipboard after the async run itself
    await navigator.clipboard.writeText(JSON.stringify(measureResults, null, 2));
    addDebugToast({ title: 'Results copied' });
  } catch (error) {
    lwarn('[assetCompare] Could not copy the results (they are also in the console)', error);
  }
};

const getMeasureRows = (): DebuggerListItem[] => {
  if (measureProgress)
    return [{ itemId: 'progress', title: `Measuring ${measureProgress}…`, titlePlaceholder: true }];
  if (!measureResults) return [];
  const { backend, adapter, variants } = measureResults;
  return [
    { itemId: 'device', title: backend, subTitle: adapter },
    ...variants.map((v, i): DebuggerListItem => {
      const formats = [...new Set(v.textures.map((t) => t.format.replace(/_?Format$/, '')))];
      return {
        itemId: `variant${i}`,
        title: `${v.variant}${v.normalMode ? ' (nm)' : ''}`,
        badge: v.messages.length ? '!' : undefined,
        suffix: formatBytes(v.vramBytes),
        description: [
          `files ${formatBytes(v.textureFileBytes)}${v.propFileBytes ? ` + GLB ${formatBytes(v.propFileBytes)}` : ''}`,
          `build ${v.buildMs} ms, drawn ${v.firstDrawMs ?? '—'} ms`,
          formats.join(', '),
          ...v.messages,
        ].join(' · '),
      };
    }),
  ];
};

// ---------------------------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------------------------

const VARIANT_OPTIONS = COMPARE_VARIANTS.map((v) => ({
  value: v,
  text: v === 'png' ? 'png (baseline)' : v,
}));

const slotFolder = (slotId: CompareSlotId) => ({
  type: 'folder' as const,
  title: `Slot ${slotId}`,
  content: [
    {
      key: `variant${slotId}` as const,
      label: 'Variant',
      options: VARIANT_OPTIONS,
      onChange: () => void rebuildCompareSlot(slotId),
    },
    {
      key: `normalMode${slotId}` as const,
      label: 'Normal mode',
      disabled: () => compareConfig[`variant${slotId}`] === 'png',
      onChange: () => void rebuildCompareSlot(slotId),
    },
  ],
});

/** The asset compare scene's "Asset compare" tab (a scene tab). Creating it restores the saved
 * slot settings into compareConfig, so the scene creates it before building the slots. */
export const createAssetCompareTab = () => {
  let lastShown = compareConfig.shown;
  setCompareChangeListener(() => {
    if (compareConfig.shown !== lastShown) {
      lastShown = compareConfig.shown;
      const variant = compareConfig[`variant${lastShown}`];
      addDebugToast({ title: `Slot ${lastShown}: ${variant}` });
    }
    updateDebuggerTab(TAB_ID, { rebuild: true });
  });
  void loadReport();

  createDebuggerTab({
    id: TAB_ID,
    title: 'Asset compare',
    icon: 'texture',
    sceneId: ASSET_COMPARE_SCENE_ID,
    lsKey: LS_KEY,
    state: compareConfig,
    persistKeys: ['variantA', 'normalModeA', 'variantB', 'normalModeB', 'shown'],
    // VRAM appears once a texture is first drawn (the other slot's: when it is first shown)
    refreshIntervalMs: 500,
    content: () => [
      {
        pane: true,
        content: [
          slotFolder('A'),
          slotFolder('B'),
          {
            key: 'shown',
            label: 'Showing',
            options: [
              { value: 'A', text: 'A' },
              { value: 'B', text: 'B' },
            ],
            onChange: (value) => showCompareSlot(value as CompareSlotId),
          },
          { type: 'button', title: 'Toggle A / B', label: 'V key', onClick: toggleCompareSlot },
          {
            type: 'button',
            title: 'Run collider check',
            label: 'DD6',
            disabled: () => isColliderCheckRunning,
            onClick: () => void runColliderCheck(),
          },
          {
            type: 'button',
            title: 'Measure all variants',
            label: 'Slot B',
            disabled: () => Boolean(measureProgress),
            onClick: () => void measureAllVariants(),
          },
          {
            type: 'button',
            title: 'Copy results',
            label: 'JSON',
            disabled: () => !measureResults || Boolean(measureProgress),
            onClick: () => void copyMeasureResults(),
          },
        ],
      },
      ...(['A', 'B'] as const).map((slotId) => {
        const slot = getCompareSlots()[slotId];
        const built = slot.built;
        const title = built
          ? `${built.variant}${built.normalMode && built.variant !== 'png' ? ' (normal mode)' : ''}`
          : '…';
        return debuggerListCMP({
          id: `assetCompareSlot${slotId}`,
          heading: `Slot ${slotId}: ${title}`,
          data: () => getSlotRows(getCompareSlots()[slotId]),
        });
      }),
      debuggerListCMP({
        id: 'assetCompareMeasure',
        heading: 'Measured variants (this device)',
        emptyText: 'Not run yet.',
        data: getMeasureRows,
      }),
      debuggerListCMP({
        id: 'assetCompareColliders',
        heading: 'Collider check (each copy vs its source)',
        emptyText: 'Not run yet.',
        data: getColliderRows,
      }),
    ],
  });
};
