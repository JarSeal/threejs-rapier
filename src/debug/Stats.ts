import Stats from 'stats-gl';
import { getRenderer } from '../core/Renderer';
import { getGUIContainerElem } from './DebuggerGUI';

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

export const initStats = (initConfigs: StatsOptions) => {
  stats = new Stats(initConfigs);
  getGUIContainerElem().appendChild(stats.dom);
  stats.init(getRenderer());
  return stats;
};

export const getStats = () => stats;

// @TODO: Toggle stats visibility
// @TODO: Toggle stats recording
// @TODO: Toggle stats (visibility & recording)
