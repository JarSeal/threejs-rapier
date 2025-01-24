import Stats from 'stats-gl';
import { getRenderer } from '../core/Renderer';
import { createNewDebuggerPane, createDebuggerTab } from './DebuggerGUI';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getGUIContainerElem } from '../core/HUD';

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

let stats: Stats | null = null;
let savedConfig = {};
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

// @TODO: add JSDoc comment
export const initStats = (config?: StatsOptions) => {
  // @TODO: disable for production ENV
  savedConfig = { ...defaultStatsOptions, ...lsGetItem(LS_KEY, config || {}) };
  if ('enabled' in savedConfig && savedConfig.enabled) {
    if (stats) stats.update();
    stats = new Stats(savedConfig as Omit<StatsOptions, 'enabled'>);
    getGUIContainerElem().appendChild(stats.dom);
    stats.init(getRenderer());
  }
  setDebuggerUI(savedConfig);
  return stats;
};

// @TODO: add JSDoc comment
export const getStats = () => stats;

const setDebuggerUI = (config: StatsOptions) =>
  createDebuggerTab({
    id: 'statsControls',
    buttonText: 'STATS',
    title: 'Statistics',
    orderNr: 3,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('Stats', 'Statistics');

      const performanceFolder = debugGUI
        .addFolder({
          title: 'Performance Measuring (reloads the app)',
          expanded: config.performanceFolderExpanded,
        })
        .on('fold', (state) => {
          config.performanceFolderExpanded = state.expanded;
          lsSetItem(LS_KEY, config);
        });
      const outlookFolder = debugGUI
        .addFolder({
          title: 'Measuring Outlook (reloads the app)',
          expanded: config.outlookFolderExpanded,
        })
        .on('fold', (state) => {
          config.outlookFolderExpanded = state.expanded;
          lsSetItem(LS_KEY, config);
        });

      performanceFolder
        .addBinding(config, 'enabled', { label: 'Enable measuring' })
        .on('change', (state) => {
          config.enabled = state.value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });
      performanceFolder
        .addBinding(config, 'trackGPU', { label: 'Track GPU' })
        .on('change', (state) => {
          config.trackGPU = state.value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });
      performanceFolder
        .addBinding(config, 'trackHz', { label: 'Track Hz' })
        .on('change', (state) => {
          config.trackHz = state.value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });
      performanceFolder
        .addBinding(config, 'trackCPT', { label: 'Track CPT' })
        .on('change', (state) => {
          config.trackCPT = state.value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });

      outlookFolder
        .addBinding(config, 'horizontal', { label: 'Horizontal' })
        .on('change', (state) => {
          config.horizontal = state.value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });
      outlookFolder
        .addBinding(config, 'minimal', { label: 'Minimal look' })
        .on('change', (state) => {
          config.minimal = state.value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });

      // @TODO: add current scene and all loaded scene stats
      // Current and all scenes stats:
      // - draw calls count
      // - imported objects count
      // - list of imported objects (and sizes, face count, edge count, vertex count)
      // - texture count, texture sizes, list of textures (and type, sizes, dimensions)
      return container;
    },
  });
