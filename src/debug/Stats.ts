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
};

let stats: Stats | null = null;
let savedConfig = {};
const LS_KEY = 'debugStats';

const defaultStatsOptions = {
  trackGPU: false,
  trackCPT: false,
  trackHz: false,
  horizontal: false,
};

export const initStats = (config: StatsOptions) => {
  savedConfig = { ...defaultStatsOptions, ...lsGetItem(LS_KEY, config) };
  if (stats) stats.update();
  stats = new Stats(savedConfig);
  getGUIContainerElem().appendChild(stats.dom);
  stats.init(getRenderer());
  setDebuggerUI(savedConfig);
  return stats;
};

export const getStats = () => stats;

const setDebuggerUI = (config: StatsOptions) => {
  setTimeout(
    () =>
      setDebuggerTabAndContainer({
        id: 'statsControls',
        buttonText: 'SC',
        title: 'Statistics',
        orderNr: 3,
        container: () => {
          const { container, debugGui } = createNewDebuggerGUI('Stats', 'Statistics');
          const enableStatsFolder = debugGui.addFolder('Performance Graphs (reloads the app)');
          enableStatsFolder
            .add(config, 'trackHz')
            .name('Track Hz')
            .onChange((value: boolean) => {
              if (!stats) return;
              stats.trackHz = config.trackHz = value;
              lsSetItem(LS_KEY, config);
              location.reload();
            });
          enableStatsFolder
            .add(config, 'trackGPU')
            .name('Track GPU')
            .onChange((value: boolean) => {
              if (!stats) return;
              stats.trackGPU = config.trackGPU = value;
              lsSetItem(LS_KEY, config);
              location.reload();
            });
          return container;
        },
      }),
    2000
  );
};

// @TODO: Toggle stats visibility
// @TODO: Toggle stats recording
// @TODO: Toggle stats (visibility & recording)
