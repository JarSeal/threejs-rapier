import { CMP } from '../../../utils/CMP';
import type { AnyDebuggerTabDef } from '../../../debug/DebuggerGUI';
import type { ProfilerSettings } from '../../../debug/Profiler';
import { _getFrameProbeSummary, type FrameProbeSummary } from './_dbg__FrameProbe';

export const PROFILER_OVERVIEW_TAB_ID = 'profilerOverview';

/** What the metrics read, sampled once per refresh. */
type OverviewSample = { frame: FrameProbeSummary };

type MetricValue = {
  value: string;
  /** Small secondary text (min / max, "in view / total", a qualifier). */
  sub?: string;
  /** Why the metric has no value right now. */
  na?: string;
};

type OverviewMetric = {
  id: string;
  label: string;
  read: (sample: OverviewSample) => MetricValue;
};

const NO_FRAMES = 'no frames (main loop paused)';

const formatMs = (ms: number) => `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;

/** The frame metrics need at least one rendered frame in the window. */
const fromFrames = (read: (frame: FrameProbeSummary) => MetricValue) => (s: OverviewSample) =>
  s.frame.frames ? read(s.frame) : { value: '—', na: NO_FRAMES };

/** The Overview rows, in their default order. */
const OVERVIEW_METRICS: OverviewMetric[] = [
  {
    id: 'tfps',
    label: 'TFPS (est.)',
    read: fromFrames((f) => ({
      value: f.cpuAvgMs > 0 ? (1000 / f.cpuAvgMs).toFixed(0) : '—',
      sub: 'CPU-bound est.',
    })),
  },
  {
    id: 'fps',
    label: 'FPS',
    read: fromFrames((f) => ({ value: f.fps.toFixed(0), sub: `${f.frames} frames in 1 s` })),
  },
  {
    id: 'frameTime',
    label: 'Frame time',
    read: fromFrames((f) => ({
      value: formatMs(f.frameTimeAvgMs),
      sub: `worst ${formatMs(f.frameTimeMaxMs)}`,
    })),
  },
  {
    id: 'cpu',
    label: 'CPU',
    read: fromFrames((f) => ({
      value: formatMs(f.cpuAvgMs),
      sub: `max ${formatMs(f.cpuMaxMs)} · main loop per frame`,
    })),
  },
];

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (text: string) => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const renderOverviewTable = () => {
  const sample: OverviewSample = { frame: _getFrameProbeSummary() };
  let rows = '';
  for (let i = 0; i < OVERVIEW_METRICS.length; i++) {
    const metric = OVERVIEW_METRICS[i];
    const { value, sub, na } = metric.read(sample);
    const secondary = na ? `n/a (${na})` : sub || '';
    rows +=
      `<tr${na ? ' class="isNA"' : ''}><th>${esc(metric.label)}</th>` +
      `<td class="profilerValue">${esc(value)}</td>` +
      `<td class="profilerSub">${esc(secondary)}</td></tr>`;
  }
  return `<div><table class="profilerTable"><tbody>${rows}</tbody></table></div>`;
};

/**
 * The Overview tab: the key figures in one table, refreshed at the update rate while visible.
 * @param settings (object) the live profiler settings (the refresh rate is read on every mount)
 */
export const createProfilerOverviewTabDef = (settings: ProfilerSettings): AnyDebuggerTabDef => ({
  id: PROFILER_OVERVIEW_TAB_ID,
  title: 'Overview',
  icon: 'profiler',
  orderNr: 0,
  get refreshIntervalMs() {
    return 1000 / settings.updateRateHz;
  },
  content: () => [CMP({ html: renderOverviewTable })],
});
