import Stats from 'stats-gl';
import { TimestampQuery, type Renderer } from 'three/webgpu';
import { getRenderer } from '../../core/Renderer';
import { createDebuggerTab, openDebuggerTab } from '../../debug/DebuggerGUI';
import { GPU_MEMORY_TAB_ID } from '../../debug/GPUMemory';
import { getHUDRootCMP } from '../../core/HUD';
import { CMP, type TCMP } from '../../utils/CMP';
import { defaultStatsOptions, type StatsOptions } from '../../debug/Stats';
import { setBootOverride } from './_dbg__PhysicsBootOverrides';
import { getConfig } from '../../core/Config';

type StatsPanel = {
  update: (value: number, maxValue: number, decimals: number) => void;
  updateGraph: (value: number, maxValue: number) => void;
  /** stats-gl's own position slot. Inert here (see applyPanelOrder), but kept in sync with
   * the displayed order anyway so the two mechanisms never disagree. */
  id: number;
  name: string;
  canvas: HTMLCanvasElement;
};

/** stats-gl keeps its own four panels and the Hz overlay in fields its .d.ts marks private,
 * though they are ordinary public properties at runtime. Reaching them needs this cast; it
 * is the only part of this file that depends on stats-gl internals, so if a future version
 * renames them the breakage is confined here. */
type StatsInternals = {
  fpsPanel: StatsPanel | null;
  msPanel: StatsPanel | null;
  gpuPanel: StatsPanel | null;
  gpuPanelCompute: StatsPanel | null;
  vsyncPanel: { canvas: HTMLCanvasElement } | null;
};

/** Top-to-bottom display order, independent of the order the panels get created in — which
 * we don't control: stats-gl builds FPS, CPU, GPU and CPT in its constructor, then we add PHY
 * and TFPS. GPU/CPT are built before init() has checked for timestamp-query support, so they
 * get detached again once it settles if the renderer turns out not to support it. */
const PANEL_ORDER = ['TFPS', 'FPS', 'CPU', 'PHY', 'GPU', 'CPT'];

let stats: Stats | null = null;
let statsCmp: TCMP | null = null;
let physicsPanel: StatsPanel | null = null;
let tFpsPanel: StatsPanel | null = null;
const LS_KEY = 'AEK_debugStats';
const STATS_TAB_ID = 'statsControls';

const statsConfig: StatsOptions = {
  trackFPS: true,
  trackCPU: true,
  trackTFPS: true,
  trackGPU: false,
  trackCPT: false,
  trackHz: false,
  logsPerSecond: undefined,
  graphsPerSecond: undefined,
  samplesLog: undefined,
  samplesGraph: undefined,
  precision: undefined,
  outlookFolderExpanded: false,
  horizontal: false,
  mode: undefined,
  enabled: true,
};

/** Every change reloads the app: the panels are only built once, at boot. */
const RELOAD_NOTE = '(reloads the app)';

/**
 * Initializes statistics for debugging
 * @param config ({@link StatsOptions}) optional configurations for stats
 * @returns ({@link Stats} | null)
 */
export const _initStats = (config?: StatsOptions) => {
  Object.assign(statsConfig, defaultStatsOptions, config);
  // Registered first: the registration hydrates the persisted values into statsConfig, which
  // the panels below are built from
  setDebuggerUI();
  const cfg = statsConfig;
  if (cfg.enabled) {
    if (stats) stats.update();
    stats = new Stats({
      ...(cfg as Omit<StatsOptions, 'enabled'>),
      // stats-gl builds FPS and CPU together, and only when trackFPS is on, so CPU would
      // vanish along with FPS. Always build both; a switched-off one is detached below.
      trackFPS: true,
      // Hz is drawn as a small overlay inside the CPU panel, so with CPU off it would have
      // nothing to sit on. The debug tab disables the Hz toggle in that case; this is the
      // matching guard for an already-persisted combination.
      trackHz: Boolean(cfg.trackHz && cfg.trackCPU),
      // Minimal look is no longer offered: it hides every panel behind a click-to-cycle
      // mode, which defeats the point of showing several at once. Forced off rather than
      // merely dropped from the options, so a stale persisted `minimal: true` can't
      // resurrect it.
      minimal: false,
    });
    const internals = stats as unknown as StatsInternals;
    // FPS and CPU can't be opted out of separately (see trackFPS above), so switching either
    // off means detaching its canvas after the fact. Detaching (rather than
    // display:none) because stats-gl's own window-resize handler re-asserts display:block
    // on every panel it knows about, which would undo a hide on the first resize.
    if (!cfg.trackFPS) internals.fpsPanel?.canvas.remove();
    if (!cfg.trackCPU) internals.msPanel?.canvas.remove();
    // PHY is only created when physics step tracking is on — with it off nothing ever
    // measures, so the panel would sit permanently at zero and misrepresent physics as free.
    if (getConfig().physics?.stepStatsEnabled) {
      physicsPanel = stats.addPanel(new Stats.Panel('PHY', '#fff', '#212121')) as StatsPanel;
    }
    if (cfg.trackTFPS) {
      tFpsPanel = stats.addPanel(new Stats.Panel('TFPS', '#fff', '#212121')) as StatsPanel;
    }
    statsCmp = CMP({
      id: '_statsContainer',
      class: ['statsContainer', ...(!cfg.horizontal ? ['vertical'] : [])],
    });
    statsCmp.elem.appendChild(stats.dom);
    getHUDRootCMP().add(statsCmp);
    // Ordered once now so nothing flashes in creation order, and again once init() settles,
    // because that is when the GPU/CPT panels may get detached (no timestamp-query support,
    // which stats-gl only checks in init()). Reordering on settle rather than on success: a
    // renderer that fails to init must still leave the rest in the right order.
    applyPanelOrder();
    const renderer = getRenderer();
    stats
      .init(renderer)
      .catch(() => undefined)
      .then(() => {
        if (!renderer?.hasFeature('timestamp-query')) {
          internals.gpuPanel?.canvas.remove();
          internals.gpuPanelCompute?.canvas.remove();
        }
        applyPanelOrder();
      });
  }
  return stats;
};

/**
 * Lays the visible panels out in PANEL_ORDER, top to bottom.
 *
 * Note that stats-gl's own positioning plays no part in this. It places panels absolutely
 * from `panel.id`, but `.statsContainer` in styles/index.scss overrides every panel canvas
 * with `position: static !important` and lays `stats.dom` out as a flexbox — so what
 * actually decides the on-screen order is DOM order, and in the vertical (default) case
 * `flex-direction: column-reverse` means the FIRST DOM child renders at the BOTTOM. Hence
 * the reversal below. Ids are still kept in step with the visual order so the two mechanisms
 * can't contradict each other if that CSS is ever relaxed.
 *
 * Panels that are switched off have had their canvas detached, so they drop out of the flex
 * flow entirely and leave no gap behind.
 */
const applyPanelOrder = () => {
  if (!stats) return;
  const internals = stats as unknown as StatsInternals;
  const visible = [
    internals.fpsPanel,
    internals.msPanel,
    internals.gpuPanel,
    internals.gpuPanelCompute,
    physicsPanel,
    tFpsPanel,
  ].filter((panel): panel is StatsPanel => Boolean(panel?.canvas.isConnected));
  visible.sort((a, b) => PANEL_ORDER.indexOf(a.name) - PANEL_ORDER.indexOf(b.name));

  // Vertical stacks bottom-up (column-reverse), horizontal is a plain left-to-right row.
  const domOrder = statsConfig.horizontal ? visible : [...visible].reverse();
  for (let i = 0; i < domOrder.length; i++) stats.dom.appendChild(domOrder[i].canvas);

  for (let i = 0; i < visible.length; i++) visible[i].id = i;

  positionVSyncOverlay(internals.vsyncPanel?.canvas, visible);
};

/**
 * Parks the Hz readout on top of the CPU panel.
 *
 * It has no panel of its own — it is a 35x9 canvas that stats-gl appends next to CPU and
 * nudges inwards with its own `transform: translate(56px, 35px)`. Left in the flex flow it
 * claims a slot of its own (a 35px column when horizontal, a 9px row when vertical), which
 * both pushes every later panel along and carries the readout off CPU and onto its
 * neighbour. Taking it out of the flow fixes the gap and the misalignment together.
 *
 * Absolute positioning has to be forced inline with `!important`, because .statsContainer
 * declares `position: static !important` on every canvas it holds and only an inline
 * important declaration outranks that. Offsets are then read from the CPU canvas — after the
 * overlay has left the flow, so the reflow that read triggers already reflects its absence —
 * and stats-gl's own translate still applies on top, so its inset stays its own business.
 */
const positionVSyncOverlay = (canvas: HTMLCanvasElement | undefined, visible: StatsPanel[]) => {
  if (!canvas) return;
  const cpuPanel = visible.find((panel) => panel.name === 'CPU');
  if (!cpuPanel) {
    // Shouldn't happen (_initStats forces trackHz off without CPU), but an orphaned readout
    // floating over an unrelated panel would be worse than none.
    canvas.style.display = 'none';
    return;
  }
  canvas.style.setProperty('position', 'absolute', 'important');
  canvas.style.left = `${cpuPanel.canvas.offsetLeft}px`;
  canvas.style.top = `${cpuPanel.canvas.offsetTop}px`;
};

export const _updateRestOfStats = (renderer: Renderer) => {
  logicEndTime = performance.now();
  logicDuration = logicEndTime - logicStartTime;
  // stats-gl only reads renderer.info's timestamps for a three.js WebGPURenderer (it resolves
  // them itself only on its native GPUDevice path), so resolving them stays our job.
  if (statsConfig.trackCPT) renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
  if (statsConfig.trackGPU) renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
  updateTFPSPanel(logicDuration);
};

let prevCurrentTime = 0;
let prevCurrentGraphsTime = 0;
let maxTime = 0;
let maxTimeCheckCount = 0;
let maxTimeGraphs = 0;
let maxTimeGraphsCheckCount = 0;
export const _updatePhysicsPanel = (value: number) => {
  const currentTime = performance.now();
  maxTime = Math.max(maxTime, value);
  maxTimeGraphs = Math.max(maxTimeGraphs, value);
  if (currentTime >= prevCurrentTime + 1000 / (stats?.logsPerSecond || 4)) {
    physicsPanel?.update(value, maxTime, 1);
    prevCurrentTime = currentTime;
    maxTimeCheckCount++;
    if (maxTimeCheckCount > 2 * (stats?.logsPerSecond || 4)) {
      maxTime = 0;
      maxTimeCheckCount = 0;
    }
  }
  if (currentTime >= prevCurrentGraphsTime + 1000 / (stats?.graphsPerSecond || 30)) {
    physicsPanel?.updateGraph(value, maxTimeGraphs * 1.5);
    prevCurrentGraphsTime = currentTime;
    maxTimeGraphsCheckCount++;
    if (maxTimeGraphsCheckCount > 4 * (stats?.graphsPerSecond || 4)) {
      maxTimeGraphs = 0;
      maxTimeGraphsCheckCount = 0;
    }
  }
};

let logicStartTime = 0;
let logicEndTime = 0;
let logicDuration = 0;
export const _startCustomMeasurements = () => {
  logicStartTime = performance.now();
};

let tFpsPrevCurrentTime = 0;
let tFpsPrevCurrentGraphsTime = 0;
let tFpsMax = 0;
const tFPSsamples: number[] = [];
const updateTFPSPanel = (duration: number) => {
  // Absent when TFPS tracking is off — skip the sampling work too, not just the draw.
  if (!tFpsPanel) return;
  const currentTime = performance.now();
  tFPSsamples.push(duration);
  if (tFPSsamples.length > 60) tFPSsamples.shift();
  if (currentTime >= tFpsPrevCurrentTime + 1000 / (stats?.logsPerSecond || 4)) {
    const avgDuration = tFPSsamples.reduce((a, b) => a + b, 0) / tFPSsamples.length;
    const tfps = 1000 / avgDuration;
    tFpsPanel?.update(tfps, tFpsMax, 0);
    tFpsPrevCurrentTime = currentTime;
  }
  if (currentTime >= tFpsPrevCurrentGraphsTime + 1000 / (stats?.graphsPerSecond || 30)) {
    const avgDuration = tFPSsamples.reduce((a, b) => a + b, 0) / tFPSsamples.length;
    const tfps = 1000 / avgDuration;
    tFpsMax = Math.max(10, tFpsMax, tfps);
    tFpsPanel?.updateGraph(tfps, tFpsMax * 1.25);
    tFpsPrevCurrentGraphsTime = currentTime;
  }
};

/**
 * Returns the stats 'stats-gl' instance
 * @returns ({@link Stats} | null)
 */
export const _getStats = () => stats;

/**
 * Returns the stats configurations
 * @returns {@link StatsOptions}
 */
export const _getStatsConfig = () => statsConfig;

const setDebuggerUI = () => {
  const reloadApp = () => location.reload();
  createDebuggerTab({
    id: STATS_TAB_ID,
    title: 'Statistics',
    icon: 'speedometer',
    lsKey: LS_KEY,
    state: statsConfig,
    persistKeys: [
      'enabled',
      'trackTFPS',
      'trackFPS',
      'trackCPU',
      'trackHz',
      'trackGPU',
      'trackCPT',
      'horizontal',
    ],
    content: () => {
      // Physics step tracking drives the PHY panel, so it belongs among these panel toggles —
      // but unlike its neighbours it is not a stats setting: it lives with the other boot-time
      // physics overrides and is equally reachable from the Physics API tab. Bound through a
      // proxy so there is exactly one stored source of truth, not a copy in LS_KEY that could
      // drift from it.
      const physicsStepTrackingProxy = {
        stepStatsEnabled: Boolean(getConfig().physics?.stepStatsEnabled),
      };
      return [
        {
          pane: true,
          content: [
            {
              type: 'folder',
              id: 'performance',
              title: `Performance Measuring ${RELOAD_NOTE}`,
              content: [
                { key: 'enabled', label: 'Enable measuring', onChange: reloadApp },
                // Ordered to mirror the panels' own top-to-bottom order on screen
                // (PANEL_ORDER), so the toggle list reads the same way the display does.
                { key: 'trackTFPS', label: 'Track TFPS', onChange: reloadApp },
                { key: 'trackFPS', label: 'Track FPS', onChange: reloadApp },
                { key: 'trackCPU', label: 'Track CPU', onChange: reloadApp },
                // Hz has no panel of its own — it is an overlay drawn inside the CPU panel —
                // so it is only offered while CPU is on. _initStats forces it off for any
                // already-persisted combination where CPU is off.
                {
                  key: 'trackHz',
                  label: 'Track Hz (showed in CPU panel)',
                  disabled: () => !statsConfig.trackCPU,
                  onChange: reloadApp,
                },
                {
                  key: 'stepStatsEnabled',
                  target: physicsStepTrackingProxy,
                  label: 'Track PHY',
                  onChange: (value) => setBootOverride({ stepStatsEnabled: Boolean(value) }),
                },
                { key: 'trackGPU', label: 'Track GPU', onChange: reloadApp },
                { key: 'trackCPT', label: 'Track CPT', onChange: reloadApp },
              ],
            },
            {
              type: 'folder',
              id: 'outlook',
              title: `Measuring Outlook ${RELOAD_NOTE}`,
              content: [{ key: 'horizontal', label: 'Horizontal', onChange: reloadApp }],
            },
            {
              type: 'button',
              label: 'Draw calls, memory',
              title: 'Open GPU memory',
              onClick: () => openDebuggerTab(GPU_MEMORY_TAB_ID),
            },
          ],
        },
      ];
    },
  });

  // @TODO: add current scene and all loaded scene stats (draw calls and GPU memory are in the
  // GPU memory tab, _dbg__GPUMemory.ts)
  // Current and all scenes stats:
  // - objects count (Object3D)
  // - mesh count
  // - face count
  // - edge count
  // - vertex count
  // - imported objects count
  // - list of imported objects (and sizes, face count, edge count, vertex count)
  // - list of primitive objects (face count, edge count, vertex count)
  // - texture count, texture sizes, list of textures (and type, sizes, dimensions)
};

export const _getStatsCmp = () => statsCmp;
