import Stats from 'stats-gl';
import { TimestampQuery, type Renderer } from 'three/webgpu';
import { getRenderer } from '../core/Renderer';
import { createNewDebuggerPane, createDebuggerTab } from './DebuggerGUI';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getHUDRootCMP } from '../core/HUD';
import { Pane } from 'tweakpane';
import { getSvgIcon } from '../core/UI/icons/SvgIcon';
import { CMP } from '../utils/CMP';

export type StatsOptions = {
  performanceFolderExpanded?: boolean;
  trackGPU?: boolean;
  trackCPT?: boolean;
  trackHz?: boolean;
  logsPerSecond?: number;
  graphsPerSecond?: number;
  samplesLog?: number;
  samplesGraph?: number;
  precision?: number;
  outlookFolderExpanded?: boolean;
  minimal?: boolean;
  horizontal?: boolean;
  mode?: number;
  enabled?: boolean;
};

type StatsPanel = {
  update: (value: number, maxValue: number, decimals: number) => void;
  updateGraph: (value: number, maxValue: number) => void;
};

let stats: Stats | null = null;
let physicsPanel: StatsPanel | null = null;
let savedConfig = {};
const statsDebugGUIs: Pane[] = [];
const LS_KEY = 'debugStats';

const defaultStatsOptions = {
  performanceFolderExpanded: true,
  trackGPU: false,
  trackHz: false,
  trackCPT: false,
  outlookFolderExpanded: true,
  horizontal: false,
  minimal: true,
  enabled: true,
};
let statsConfig: StatsOptions = {
  performanceFolderExpanded: false,
  trackGPU: false,
  trackCPT: false,
  trackHz: false,
  logsPerSecond: undefined,
  graphsPerSecond: undefined,
  samplesLog: undefined,
  samplesGraph: undefined,
  precision: undefined,
  outlookFolderExpanded: false,
  minimal: true,
  horizontal: false,
  mode: undefined,
  enabled: true,
};

/**
 * Initializes statistics for debugging
 * @param config ({@link StatsOptions}) optional configurations for stats
 * @returns ({@link Stats} | null)
 */
export const initStats = (config?: StatsOptions) => {
  savedConfig = { ...defaultStatsOptions, ...lsGetItem(LS_KEY, config || {}) };
  if ('enabled' in savedConfig && savedConfig.enabled) {
    if (stats) stats.update();
    stats = new Stats(savedConfig as Omit<StatsOptions, 'enabled'>);
    physicsPanel = stats.addPanel(new Stats.Panel('PHY', '#fff', '#212121')) as StatsPanel;
    const statsCMP = CMP({
      id: '_statsContainer',
      class: ['statsContainer', ...(!(savedConfig as StatsOptions).horizontal ? ['vertical'] : [])],
    });
    statsCMP.elem.appendChild(stats.dom);
    getHUDRootCMP().add(statsCMP);
    stats.init(getRenderer());
  }
  statsConfig = savedConfig;
  setDebuggerUI();
  return stats;
};

export const updateStats = (renderer: Renderer) => {
  if (statsConfig.trackCPT) renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
  if (statsConfig.trackGPU) renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
  stats?.update();
};

let prevCurrentTime = 0;
let prevCurrentGraphsTime = 0;
let maxTime = 0;
let maxTimeCheckCount = 0;
let maxTimeGraphs = 0;
let maxTimeGraphsCheckCount = 0;
export const updatePhysicsPanel = (value: number) => {
  const currentTime = performance.now();
  value = value * 1000;
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

/**
 * Returns the stats 'stats-gl' instance
 * @returns ({@link Stats} | null)
 */
export const getStats = () => stats;

/**
 * Returns the stats configurations
 * @returns {@link StatsOptions}
 */
export const getStatsConfig = () => statsConfig;

const setDebuggerUI = () => {
  const icon = getSvgIcon('speedometer');
  return createDebuggerTab({
    id: 'statsControls',
    buttonText: icon,
    title: 'Statistics',
    orderNr: 3,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('Stats', `${icon} Statistics`);

      statsDebugGUIs.push(debugGUI);
      buildStatsDebugGUI(debugGUI);

      return container;
    },
  });
};

export const updateStatsDebugGUI = () => {
  for (let i = 0; i < statsDebugGUIs.length; i++) {
    statsDebugGUIs[i].refresh();
  }
};

export const buildStatsDebugGUI = (debugGUI: Pane) => {
  const performanceFolder = debugGUI
    .addFolder({
      title: 'Performance Measuring (reloads the app)',
      expanded: statsConfig.performanceFolderExpanded,
    })
    .on('fold', (state) => {
      statsConfig.performanceFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, statsConfig || {});
      updateStatsDebugGUI();
    });
  const outlookFolder = debugGUI
    .addFolder({
      title: 'Measuring Outlook (reloads the app)',
      expanded: statsConfig.outlookFolderExpanded,
    })
    .on('fold', (state) => {
      statsConfig.outlookFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, statsConfig || {});
      updateStatsDebugGUI();
    });

  performanceFolder
    .addBinding(statsConfig, 'enabled', { label: 'Enable measuring' })
    .on('change', () => {
      lsSetItem(LS_KEY, statsConfig);
      location.reload();
      updateStatsDebugGUI();
    });
  performanceFolder.addBinding(statsConfig, 'trackGPU', { label: 'Track GPU' }).on('change', () => {
    lsSetItem(LS_KEY, statsConfig);
    location.reload();
    updateStatsDebugGUI();
  });
  performanceFolder.addBinding(statsConfig, 'trackHz', { label: 'Track Hz' }).on('change', () => {
    lsSetItem(LS_KEY, statsConfig);
    location.reload();
    updateStatsDebugGUI();
  });
  performanceFolder.addBinding(statsConfig, 'trackCPT', { label: 'Track CPT' }).on('change', () => {
    lsSetItem(LS_KEY, statsConfig);
    location.reload();
    updateStatsDebugGUI();
  });

  outlookFolder.addBinding(statsConfig, 'horizontal', { label: 'Horizontal' }).on('change', () => {
    lsSetItem(LS_KEY, statsConfig);
    location.reload();
    updateStatsDebugGUI();
  });
  outlookFolder.addBinding(statsConfig, 'minimal', { label: 'Minimal look' }).on('change', () => {
    lsSetItem(LS_KEY, statsConfig);
    location.reload();
    updateStatsDebugGUI();
  });

  // @TODO: add current scene and all loaded scene stats
  // Current and all scenes stats:
  // - draw calls count
  // - imported objects count
  // - list of imported objects (and sizes, face count, edge count, vertex count)
  // - texture count, texture sizes, list of textures (and type, sizes, dimensions)
};
