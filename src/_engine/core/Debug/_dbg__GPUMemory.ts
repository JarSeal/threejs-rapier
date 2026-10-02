import type { Renderer } from 'three/webgpu';
import { addDebugToast, createDebuggerTab, openDebuggerTab } from '../../debug/DebuggerGUI';
import { GPU_MEMORY_TAB_ID } from '../../debug/GPUMemory';
import { CMP } from '../../utils/CMP';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld, getECSWorld } from '../ECS';
import { getRenderer } from '../Renderer';
import { registerOnAllSceneEnterings } from '../Scene';
import { formatBytes, formatNumber } from './_dbg__AssetStats';
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

const state = { budgetMB: DEFAULT_BUDGET_MB };

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

export const _createGPUMemoryDebugGUI = () => {
  createDebuggerTab({
    id: GPU_MEMORY_TAB_ID,
    title: 'GPU memory',
    icon: 'memory',
    lsKey: LS_KEY,
    state,
    persistKeys: ['budgetMB'],
    // Only re-renders the tables; the sampling runs in gpuMemorySamplerSystem
    refreshIntervalMs: 500,
    content: () => [
      CMP({ html: totalsHtml }),
      CMP({ html: frameHtml }),
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
    ],
  });

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
