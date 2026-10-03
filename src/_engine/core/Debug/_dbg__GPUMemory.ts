import type { Renderer } from 'three/webgpu';
import {
  addDebugToast,
  createDebuggerTab,
  openDebuggerTab,
  updateDebuggerTab,
} from '../../debug/DebuggerGUI';
import { GPU_MEMORY_TAB_ID } from '../../debug/GPUMemory';
import { CMP } from '../../utils/CMP';
import { llog } from '../../utils/Logger';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld, getECSWorld } from '../ECS';
import { getRenderer, onRendererCreated } from '../Renderer';
import { getCurrentSceneId, registerOnAllSceneEnterings } from '../Scene';
import { formatBytes, formatNumber } from './_dbg__AssetStats';
import {
  BOOT_OWNER,
  collectGPUAssets,
  groupByOwner,
  type OwnerSums,
} from './_dbg__GPUMemoryOwners';
import {
  ALLOCATION_KIND_LABELS,
  installAllocationTracker,
  setRecordAllocationSites,
} from './_dbg__GPUMemoryAllocations';
import {
  clearGPUMemorySnapshot,
  getGPUMemoryDiff,
  getGPUMemorySnapshot,
  takeGPUMemorySnapshot,
  type GPUMemoryDiff,
} from './_dbg__GPUMemorySnapshots';
import styles from './GPUMemory.module.scss';

/**
 * GPU memory and draw-call tab (docs/plans/p345_gpu-memory-and-draw-call-debugger.md).
 *
 * Everything here is three's own bookkeeping (`renderer.info`) of the buffers and textures it
 * created, not a driver measurement: browsers expose no real VRAM figure.
 *
 * `info.render` is not reset per render() call but at the start of three's own animation frame,
 * which runs next to the engine's main loop. So the frame counters are read by a LATE_MAIN
 * system, right after the frame's renderScene() (MainLoop.ts), and never from the tab's refresh
 * interval: that would read 0 whenever three's reset ran last, the loop is paused or the FPS
 * limiter skipped the frame. The same system tracks the memory peaks and the budget, so they are
 * caught while the tab is closed too.
 */

const LS_KEY = 'AEK_debugGPUMemory';
const DEFAULT_BUDGET_MB = 512;
/** Frame counters are summarised (min / avg / max) per window of this length. */
const FRAME_WINDOW_MS = 500;
/** No sampled frame for this long reads as a paused main loop. */
const PAUSED_AFTER_MS = 1000;
const MB = 1024 * 1024;

/** Rows per diff table; "Log diff" prints them all. */
const DIFF_MAX_ROWS = 12;

const state = { budgetMB: DEFAULT_BUDGET_MB, recordSites: false };

// --- MEMORY ---

const MEMORY_CATEGORIES = [
  { label: 'Textures', count: 'textures', size: 'texturesSize' },
  { label: 'Attributes', count: 'attributes', size: 'attributesSize' },
  { label: 'Index attributes', count: 'indexAttributes', size: 'indexAttributesSize' },
  { label: 'Storage attributes', count: 'storageAttributes', size: 'storageAttributesSize' },
  {
    label: 'Indirect storage attr.',
    count: 'indirectStorageAttributes',
    size: 'indirectStorageAttributesSize',
  },
  { label: 'Uniform buffers', count: 'uniformBuffers', size: 'uniformBuffersSize' },
  { label: 'Programs (code)', count: 'programs', size: 'programsSize' },
  { label: 'Readback buffers', count: 'readbackBuffers', size: 'readbackBuffersSize' },
] as const;

type MemoryInfo = Renderer['info']['memory'];
type Peak = { bytes: number; at: number };

const bootPeak: Peak = { bytes: 0, at: 0 };
const scenePeak: Peak = { bytes: 0, at: 0 };
/** Over-budget toast shown in the current scene (reset on scene enter and on a budget change). */
let isBudgetToastShown = false;

const raisePeak = (peak: Peak, bytes: number) => {
  if (bytes <= peak.bytes) return;
  peak.bytes = bytes;
  peak.at = Date.now();
};

const trackMemory = (total: number) => {
  raisePeak(bootPeak, total);
  raisePeak(scenePeak, total);
  if (isBudgetToastShown || total <= state.budgetMB * MB) return;
  // addDebugToast is a no-op (null) before the debug toaster exists: try again next frame
  isBudgetToastShown = Boolean(
    addDebugToast({
      type: 'warning',
      title: 'GPU memory over budget',
      message: `${formatBytes(total)} of the ${state.budgetMB} MB budget (three's estimate). See the GPU memory tab.`,
    })
  );
};

// --- FRAME COUNTERS ---

const FRAME_METRICS = ['Draw calls', 'Triangles', 'Render calls', 'Compute calls'] as const;
const METRIC_COUNT = FRAME_METRICS.length;

const frameLast = new Float64Array(METRIC_COUNT);
const windowMin = new Float64Array(METRIC_COUNT);
const windowMax = new Float64Array(METRIC_COUNT);
const windowSum = new Float64Array(METRIC_COUNT);
let windowFrames = 0;
let windowStartedAt = 0;
let lastSampledAt = 0;
/** The last finished window, shown in the tab. */
const shown = {
  min: new Float64Array(METRIC_COUNT),
  max: new Float64Array(METRIC_COUNT),
  avg: new Float64Array(METRIC_COUNT),
  frames: 0,
};

const finishFrameWindow = (now: number) => {
  for (let i = 0; i < METRIC_COUNT; i++) {
    shown.min[i] = windowMin[i];
    shown.max[i] = windowMax[i];
    shown.avg[i] = windowSum[i] / windowFrames;
  }
  shown.frames = windowFrames;
  windowFrames = 0;
  windowStartedAt = now;
};

const sampleFrame = (info: Renderer['info'], now: number) => {
  frameLast[0] = info.render.drawCalls;
  frameLast[1] = info.render.triangles;
  frameLast[2] = info.render.frameCalls;
  frameLast[3] = info.compute.frameCalls;
  for (let i = 0; i < METRIC_COUNT; i++) {
    const value = frameLast[i];
    if (windowFrames === 0 || value < windowMin[i]) windowMin[i] = value;
    if (windowFrames === 0 || value > windowMax[i]) windowMax[i] = value;
    windowSum[i] = windowFrames === 0 ? value : windowSum[i] + value;
  }
  windowFrames++;
  lastSampledAt = now;
  if (now - windowStartedAt >= FRAME_WINDOW_MS) finishFrameWindow(now);
};

/** LATE_MAIN, so right after the frame's renderScene(); default world only (one renderer). */
const gpuMemorySamplerSystem = (world: ECSWorld) => {
  if (world !== getECSWorld()) return;
  const renderer = getRenderer();
  if (!renderer) return;
  sampleFrame(renderer.info, performance.now());
  trackMemory(renderer.info.memory.total);
};

// --- TAB CONTENT ---

const getBackendLabel = (renderer: Renderer) =>
  (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'WebGPU'
    : 'WebGL2';

const formatTime = (at: number) => (at ? new Date(at).toLocaleTimeString() : '—');

const totalsHtml = () => {
  const renderer = getRenderer();
  if (!renderer) return `<div class="${styles.gpuMemorySummary}">No renderer yet.</div>`;
  const memory: MemoryInfo = renderer.info.memory;
  const budgetBytes = state.budgetMB * MB;
  const ratio = budgetBytes > 0 ? memory.total / budgetBytes : 0;
  const isOver = ratio > 1;

  const categories = MEMORY_CATEGORIES.map((c) => ({
    label: c.label,
    count: memory[c.count],
    size: memory[c.size],
  })).sort((a, b) => b.size - a.size);
  const categoryRows = categories
    .map(
      (c) =>
        `<tr><td>${c.label}</td><td>${formatBytes(c.size)}</td><td>${formatNumber(c.count)}</td></tr>`
    )
    .join('');

  return `<div class="${styles.gpuMemorySummary}${isOver ? ` ${styles.gpuMemoryOverBudget}` : ''}">
  <div class="${styles.gpuMemoryTotalRow}"><span>Total</span><strong>${formatBytes(memory.total)}</strong></div>
  <div class="${styles.gpuMemoryBar}"><div class="${styles.gpuMemoryBarFill}" style="width:${Math.min(ratio, 1) * 100}%"></div></div>
  <div class="${styles.gpuMemoryBarLabel}">${(ratio * 100).toFixed(0)} % of the ${state.budgetMB} MB budget${isOver ? ' (over budget)' : ''}</div>
  <table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Category</th><th>Size</th><th>Count</th></tr></thead>
    <tbody>${categoryRows}
      <tr><td>Render targets</td><td>in textures</td><td>${formatNumber(memory.renderTargets)}</td></tr>
      <tr><td>Geometries</td><td>in attributes</td><td>${formatNumber(memory.geometries)}</td></tr>
    </tbody>
  </table>
  <table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Peak</th><th>Size</th><th>Reached</th></tr></thead>
    <tbody>
      <tr><td>Since boot</td><td>${formatBytes(bootPeak.bytes)}</td><td>${formatTime(bootPeak.at)}</td></tr>
      <tr><td>Since scene enter</td><td>${formatBytes(scenePeak.bytes)}</td><td>${formatTime(scenePeak.at)}</td></tr>
    </tbody>
  </table>
  <div class="${styles.gpuMemoryNote}">${getBackendLabel(renderer)} backend. three's own estimate of what it created, since boot, not a driver measurement. Compressed textures count as 1 B each (three r186).</div>
</div>`;
};

const formatMetric = (value: number) => formatNumber(Math.round(value));

const frameHtml = () => {
  const isPaused = performance.now() - lastSampledAt > PAUSED_AFTER_MS;
  const rows = FRAME_METRICS.map(
    (label, i) =>
      `<tr><td>${label}</td><td>${formatMetric(frameLast[i])}</td><td>${formatMetric(shown.min[i])}</td><td>${formatMetric(shown.avg[i])}</td><td>${formatMetric(shown.max[i])}</td></tr>`
  ).join('');
  return `<div class="${styles.gpuMemorySummary}">
  <h4 class="${styles.gpuMemoryHeading}">Frame${isPaused ? ' (main loop paused)' : ''}</h4>
  <table class="${styles.gpuMemoryTable}">
    <thead><tr><th></th><th>Last</th><th>Min</th><th>Avg</th><th>Max</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="${styles.gpuMemoryNote}">Min / avg / max over the last ${FRAME_WINDOW_MS} ms (${shown.frames} frames). Includes every render of the frame: shadow maps, PostFX passes, sky bakes and viewports. The axes gizmo (F10) and the environment ball (F9) are viewports and add their own draw calls; the drawer itself is DOM and adds none.</div>
</div>`;
};

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );

const ownerLabel = (owner: string) =>
  owner === BOOT_OWNER ? 'boot (before the first scene)' : esc(owner);

const ownerRowHtml = (sums: OwnerSums, label: string, className = '') =>
  `<tr${className ? ` class="${className}"` : ''}><td>${label}</td><td>${formatBytes(sums.textures)}</td><td>${formatBytes(sums.geometries)}</td><td>${formatBytes(sums.total)}</td><td>${formatNumber(sums.count)}</td></tr>`;

const ownersHtml = () => {
  const renderer = getRenderer();
  if (!renderer) return '';
  const memory: MemoryInfo = renderer.info.memory;
  const rows = collectGPUAssets(renderer);
  const groups = groupByOwner(rows);
  const currentSceneId = getCurrentSceneId();

  let trackedTextures = 0;
  let trackedGeometries = 0;
  for (const group of groups) {
    trackedTextures += group.textures;
    trackedGeometries += group.geometries;
  }
  const notOnGPU = rows.filter((row) => !row.bytes).length;

  const ownerRows = groups
    .map((group) => {
      const isCurrent = group.owner === currentSceneId;
      const label = `${ownerLabel(group.owner)}${isCurrent ? ' (current)' : ''}`;
      return (
        ownerRowHtml(group, label, isCurrent ? styles.gpuMemoryCurrent : '') +
        group.cells
          .map((cell) =>
            ownerRowHtml(cell, esc(cell.owner.slice(group.owner.length + 1)), styles.gpuMemoryCell)
          )
          .join('')
      );
    })
    .join('');

  // What the registries can't name: render targets (shadow maps, PostFX, sky bakes, viewports),
  // unregistered and instanced geometry, uniform buffers, shader code
  const untrackedRows = [
    { label: 'Textures', bytes: memory.texturesSize - trackedTextures },
    {
      label: 'Attributes + index',
      bytes: memory.attributesSize + memory.indexAttributesSize - trackedGeometries,
    },
    ...MEMORY_CATEGORIES.filter(
      (c) =>
        c.size !== 'texturesSize' && c.size !== 'attributesSize' && c.size !== 'indexAttributesSize'
    ).map((c) => ({ label: c.label, bytes: memory[c.size] })),
  ]
    .filter((row) => row.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const untracked = memory.total - trackedTextures - trackedGeometries;
  const untrackedRatio = memory.total > 0 ? untracked / memory.total : 0;

  return `<div class="${styles.gpuMemorySummary}">
  <h4 class="${styles.gpuMemoryHeading}">By owner</h4>
  <table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Owner</th><th>Textures</th><th>Geometry</th><th>Total</th><th>Assets</th></tr></thead>
    <tbody>${ownerRows || '<tr><td>No registered assets on the GPU.</td></tr>'}
      <tr class="${styles.gpuMemoryUntracked}"><td>Untracked</td><td></td><td></td><td>${formatBytes(untracked)}</td><td>${(untrackedRatio * 100).toFixed(0)} %</td></tr>
    </tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td>${formatBytes(memory.total)}</td><td></td></tr></tfoot>
  </table>
  <table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Untracked</th><th>Size</th></tr></thead>
    <tbody>${untrackedRows.map((row) => `<tr><td>${row.label}</td><td>${formatBytes(row.bytes)}</td></tr>`).join('')}</tbody>
  </table>
  <div class="${styles.gpuMemoryNote}">Registered textures and geometries, and the textures a material holds alone (eg. clones), summed per owning scene with three's own byte counts. ${notOnGPU ? `${formatNumber(notOnGPU)} registered asset${notOnGPU === 1 ? ' is' : 's are'} not on the GPU (never drawn, or not uploaded yet). ` : ''}Untracked is everything else: render targets (shadow maps, PostFX, sky bakes, viewports), unregistered and instanced geometry, uniform buffers and shader code. A large or growing figure is a finding.</div>
</div>`;
};

// --- SNAPSHOTS ---

const formatDelta = (delta: number, format: (n: number) => string) =>
  delta === 0 ? '0' : `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`;
const formatBytesDelta = (delta: number) => formatDelta(delta, formatBytes);
const formatCountDelta = (delta: number) => formatDelta(delta, formatNumber);

const moreRow = (total: number, columns: number) =>
  total > DIFF_MAX_ROWS
    ? `<tr class="${styles.gpuMemoryUntracked}"><td colspan="${columns}">+${formatNumber(total - DIFF_MAX_ROWS)} more (Log diff lists all)</td></tr>`
    : '';

/** One row per info.memory category that changed, by its size and count keys. */
const memoryChangeRows = (diff: GPUMemoryDiff) => {
  const delta = (key: string) => {
    const change = diff.memory.find((c) => c.key === key);
    return change ? change.after - change.before : 0;
  };
  const rows = [
    ...MEMORY_CATEGORIES.map((c) => ({
      label: c.label,
      size: delta(c.size),
      count: delta(c.count),
    })),
    { label: 'Render targets', size: 0, count: delta('renderTargets') },
    { label: 'Geometries', size: 0, count: delta('geometries') },
  ].filter((row) => row.size !== 0 || row.count !== 0);
  return { total: delta('total'), rows };
};

const snapshotHtml = () => {
  const renderer = getRenderer();
  const snapshot = getGPUMemorySnapshot();
  if (!renderer || !snapshot) {
    return `<div class="${styles.gpuMemorySummary}">
  <h4 class="${styles.gpuMemoryHeading}">Snapshot</h4>
  <div class="${styles.gpuMemoryNote}">No snapshot. For leak hunting: take one in scene A, go to scene B and back to A, and the diff lists what B left allocated.</div>
</div>`;
  }
  const diff = getGPUMemoryDiff(renderer)!;
  const { total, rows } = memoryChangeRows(diff);

  const categoryRows = rows
    .map(
      (row) =>
        `<tr><td>${row.label}</td><td>${row.size ? formatBytesDelta(row.size) : ''}</td><td>${formatCountDelta(row.count)}</td></tr>`
    )
    .join('');
  const assetRows = diff.assets
    .slice(0, DIFF_MAX_ROWS)
    .map(
      (change) =>
        `<tr><td class="${styles.gpuMemoryWrap}" title="${esc(change.key)}">${esc(change.id)}<br><span class="${styles.gpuMemoryDim}">${change.kind}, ${ownerLabel(change.owner)}</span></td><td>${change.before ? formatBytes(change.before) : 'new'}</td><td>${change.after ? formatBytes(change.after) : 'gone'}</td><td>${formatBytesDelta(change.after - change.before)}</td></tr>`
    )
    .join('');
  const leftRows = diff.leftBehind
    .slice(0, DIFF_MAX_ROWS)
    .map(
      (group) =>
        `<tr><td class="${styles.gpuMemoryWrap}">${ALLOCATION_KIND_LABELS[group.kind]}: ${esc(group.label)}<br><span class="${styles.gpuMemoryDim}">${ownerLabel(group.scene)}, visit ${group.visit}${group.site ? ` · ${esc(group.site)}` : ''}${group.collected ? ` · ${formatNumber(group.collected)} collected` : ''}</span></td><td>${formatNumber(group.count)}</td><td>${formatBytes(group.bytes)}</td></tr>`
    )
    .join('');
  const assetsNew = diff.assets.filter((change) => !change.before).length;
  const assetsGone = diff.assets.filter((change) => !change.after).length;
  const assetsNet = diff.assets.reduce((sum, change) => sum + change.after - change.before, 0);
  const leftBytes = diff.leftBehind.reduce((sum, group) => sum + group.bytes, 0);
  const leftCount = diff.leftBehind.reduce((sum, group) => sum + group.count, 0);

  return `<div class="${styles.gpuMemorySummary}">
  <h4 class="${styles.gpuMemoryHeading}">Since the snapshot in ${ownerLabel(snapshot.sceneId)} at ${formatTime(snapshot.at)}</h4>
  <div class="${styles.gpuMemoryTotalRow}"><span>Total</span><strong>${formatBytesDelta(total)}</strong></div>
  ${
    categoryRows
      ? `<table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Category</th><th>Size</th><th>Count</th></tr></thead>
    <tbody>${categoryRows}</tbody>
  </table>`
      : `<div class="${styles.gpuMemoryNote}">No category changed.</div>`
  }
  ${
    leftRows
      ? `<table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Left behind (scene, visit)</th><th>Count</th><th>Size</th></tr></thead>
    <tbody>${leftRows}${moreRow(diff.leftBehind.length, 3)}</tbody>
    <tfoot><tr><td>Total</td><td>${formatNumber(leftCount)}</td><td>${formatBytes(leftBytes)}</td></tr></tfoot>
  </table>`
      : `<div class="${styles.gpuMemoryNote}">No earlier scene visit since the snapshot left anything allocated.</div>`
  }
  ${
    assetRows
      ? `<table class="${styles.gpuMemoryTable}">
    <thead><tr><th>Registered asset (${formatNumber(assetsNew)} new, ${formatNumber(assetsGone)} gone, net ${formatBytesDelta(assetsNet)})</th><th>Then</th><th>Now</th><th>Change</th></tr></thead>
    <tbody>${assetRows}${moreRow(diff.assets.length, 4)}</tbody>
  </table>`
      : `<div class="${styles.gpuMemoryNote}">No registered asset changed.</div>`
  }
  <div class="${styles.gpuMemoryNote}">Since the snapshot: ${formatNumber(diff.currentVisit.count)} allocations (${formatBytes(diff.currentVisit.bytes)}) made in this scene visit are still live, and ${formatNumber(diff.freed.count)} that existed at the snapshot (${formatBytes(diff.freed.bytes)}) were freed. "Left behind" lists what the snapshot's scene visit and the visits after it, up to this one, created and is still counted: what a scene left behind, or something long-lived it created first (a new visit starts on every scene load, so the same scene twice is two visits). Collected ones were garbage collected without being destroyed, so three counts them for good.${state.recordSites ? '' : ' Turn on "Call sites" to see where each one was created (from the next allocation on).'}</div>
</div>`;
};

const logDiff = () => {
  const renderer = getRenderer();
  const snapshot = getGPUMemorySnapshot();
  if (!renderer || !snapshot) return;
  const diff = getGPUMemoryDiff(renderer)!;
  llog(
    `[GPU memory] Diff since the snapshot in "${snapshot.sceneId}" at ${formatTime(snapshot.at)}:`,
    diff
  );
};

export const _createGPUMemoryDebugGUI = () => {
  createDebuggerTab({
    id: GPU_MEMORY_TAB_ID,
    title: 'GPU memory',
    icon: 'memory',
    lsKey: LS_KEY,
    state,
    persistKeys: ['budgetMB', 'recordSites'],
    // Only re-renders the tables; the sampling runs in gpuMemorySamplerSystem
    refreshIntervalMs: 500,
    content: () => [
      CMP({ html: totalsHtml }),
      CMP({ html: frameHtml }),
      CMP({ html: ownersHtml }),
      {
        pane: true,
        content: [
          {
            key: 'budgetMB',
            label: 'Budget (MB)',
            min: 16,
            step: 16,
            onChange: (_value, e) => {
              // Re-checked against the new budget from the next frame on
              if (e.last) isBudgetToastShown = false;
            },
          },
          {
            type: 'button',
            label: 'Viewports',
            title: 'Open Debug tools',
            onClick: () => openDebuggerTab('debugToolsControls'),
          },
          {
            type: 'button',
            label: 'GPU time',
            title: 'Open PostFX profiler',
            onClick: () => openDebuggerTab('postFxControls'),
          },
        ],
      },
      CMP({ html: snapshotHtml }),
      {
        pane: true,
        content: [
          {
            type: 'button',
            label: 'Snapshot',
            title: 'Take snapshot',
            disabled: () => !getRenderer(),
            onClick: () => {
              const renderer = getRenderer();
              if (!renderer) return;
              takeGPUMemorySnapshot(renderer);
              updateDebuggerTab(GPU_MEMORY_TAB_ID);
            },
          },
          {
            type: 'button',
            label: 'Diff',
            title: 'Log diff to console',
            disabled: () => !getGPUMemorySnapshot(),
            onClick: logDiff,
          },
          {
            type: 'button',
            label: 'Clear',
            title: 'Clear snapshot',
            disabled: () => !getGPUMemorySnapshot(),
            onClick: () => {
              clearGPUMemorySnapshot();
              updateDebuggerTab(GPU_MEMORY_TAB_ID);
            },
          },
          {
            key: 'recordSites',
            label: 'Call sites',
            onChange: (value) => setRecordAllocationSites(Boolean(value)),
          },
        ],
      },
    ],
  });

  // Hydrated above; the tracker is installed before the renderer's init(), so it sees everything
  setRecordAllocationSites(state.recordSites);
  onRendererCreated(installAllocationTracker);

  registerOnAllSceneEnterings('gpuMemoryScenePeak', () => {
    // Starts from what is held now: the previous scene's assets are already released here
    scenePeak.bytes = getRenderer()?.info.memory.total ?? 0;
    scenePeak.at = Date.now();
    isBudgetToastShown = false;
  });

  ECSWorld.registerPlugin((world) => {
    world.addSystem(ECSSystemStage.LATE_MAIN, 'gpuMemorySamplerSystem', gpuMemorySamplerSystem);
  });
};
