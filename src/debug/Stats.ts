import Stats from 'stats-gl';
import { getRenderer } from '../core/Renderer';
import { createNewDebuggerGUI, setDebuggerTabAndContainer } from './DebuggerGUI';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getGUIContainerElem } from '../core/HUD';

export type StatsOptions = {
  trackGPU?: boolean;
  trackCPT?: boolean;
  trackHz?: boolean;
  logsPerSecond?: number;
  graphsPerSecond?: number;
  samplesLog?: number;
  samplesGraph?: number;
  precision?: number;
  minimal?: boolean;
  horizontal?: boolean;
  mode?: number;
  enabled?: boolean;
};

let stats: Stats | null = null;
let savedConfig = {};
const LS_KEY = 'debugStats';

const defaultStatsOptions = {
  trackGPU: false,
  trackHz: false,
  trackCPT: false,
  horizontal: false,
  minimal: true,
  enabled: true,
};

export const initStats = (config?: StatsOptions) => {
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

export const getStats = () => stats;

const setDebuggerUI = (config: StatsOptions) =>
  setDebuggerTabAndContainer({
    id: 'statsControls',
    buttonText: 'STATS',
    title: 'Statistics',
    orderNr: 3,
    container: () => {
      const { container, debugGui } = createNewDebuggerGUI('Stats', 'Statistics');
      const performanceFolder = debugGui.addFolder('Performance Measuring (reloads the app)');
      const outlookFolder = debugGui.addFolder('Measuring Outlook (reloads the app)');
      performanceFolder
        .add(config, 'enabled')
        .name('Enable measuring')
        .onChange((value: boolean) => {
          config.enabled = value;
          lsSetItem(LS_KEY, config);
          location.reload();
        });
      performanceFolder
        .add(config, 'trackGPU')
        .name('Track GPU')
        .onChange((value: boolean) => {
          config.trackGPU = value;
          lsSetItem(LS_KEY, config);
          if (!stats) return;
          stats.trackGPU = value;
          location.reload();
        });
      performanceFolder
        .add(config, 'trackHz')
        .name('Track Hz')
        .onChange((value: boolean) => {
          config.trackHz = value;
          lsSetItem(LS_KEY, config);
          if (!stats) return;
          stats.trackHz = value;
          location.reload();
        });
      performanceFolder
        .add(config, 'trackCPT')
        .name('Track CPT')
        .onChange((value: boolean) => {
          config.trackCPT = value;
          lsSetItem(LS_KEY, config);
          if (!stats) return;
          stats.trackCPT = value;
          location.reload();
        });
      // @TODO: logsPerSecond
      // @TODO: graphsPerSecond
      // @TODO: samplesLog
      // @TODO: samplesGraph
      // @TODO: precision
      outlookFolder
        .add(config, 'horizontal')
        .name('Horizontal')
        .onChange((value: boolean) => {
          config.horizontal = value;
          lsSetItem(LS_KEY, config);
          if (!stats) return;
          stats.horizontal = value;
          location.reload();
        });
      outlookFolder
        .add(config, 'minimal')
        .name('Minimal look')
        .onChange((value: boolean) => {
          config.minimal = value;
          lsSetItem(LS_KEY, config);
          if (!stats) return;
          stats.minimal = value;
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
