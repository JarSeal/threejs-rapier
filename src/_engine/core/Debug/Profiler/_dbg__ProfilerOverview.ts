import { CMP } from '../../../utils/CMP';
import { IS_DEBUG_ENV } from '../../Config';
import { getAllECSWorlds } from '../../ECS';
import type { AnyDebuggerTabDef } from '../../../debug/DebuggerGUI';
import type { ProfilerOverviewMetricEntry, ProfilerSettings } from '../../../debug/Profiler';
import { formatBytes, formatNumber } from '../_dbg__AssetStats';
import { setBootOverride } from '../_dbg__PhysicsBootOverrides';
import { _getFrameProbeSummary, type FrameProbeSummary } from './_dbg__FrameProbe';
import {
  PROFILER_SOURCE,
  STEP_STATS_OFF,
  type DrawStats,
  type GpuFrameStats,
  type GpuMemoryStats,
  type JsMemoryStats,
  type LongTaskStats,
  type PhysicsObjectStats,
  type PhysicsStepStats,
  type PhysicsSubStepStats,
  type PostFxGpuStats,
  type RayStats,
  type SceneStats,
} from './_dbg__ProfilerSources';
import { _readStatsSource, createStatsSourceHolder, type StatsReading } from './_dbg__StatsSources';

export const PROFILER_OVERVIEW_TAB_ID = 'profilerOverview';

/** What the metrics read in one refresh. */
type OverviewSample = {
  frame: FrameProbeSummary;
  /** Reads a stats source, once per refresh (rows that share a source share the reading). */
  get: <T>(id: string) => StatsReading<T>;
};

type MetricAction = { label: string; title: string; run: () => void };

type MetricValue = {
  value: string;
  /** Small secondary text (min / max, "in view / total", a qualifier). */
  sub?: string;
  /** Why the metric has no value right now. */
  na?: string;
  /** The figure needs attention (eg. physics sub-steps at their ceiling). */
  warn?: boolean;
  /** A button after the secondary text (eg. turning a boot-time measurement on). */
  action?: MetricAction;
};

type OverviewMetric = {
  id: string;
  label: string;
  /** Shown in a new or reset list. */
  defaultVisible: boolean;
  /** The stats sources it reads, held while the row is shown. */
  sources?: string[];
  read: (sample: OverviewSample) => MetricValue;
};

const NO_FRAMES = 'no frames (main loop paused)';
const MEASURING = 'measuring…';
/** The in-view census rows (§2.7) have no source yet. */
const NO_CENSUS = 'in-view census not available yet';

const formatMs = (ms: number) => `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
const formatAvg = (n: number) => formatNumber(Math.round(n));
const formatRate = (n: number) => (n < 10 ? n.toFixed(1) : formatAvg(n));

/** The frame metrics need at least one rendered frame in the window. */
const fromFrames =
  (read: (frame: FrameProbeSummary, s: OverviewSample) => MetricValue) => (s: OverviewSample) =>
    s.frame.frames ? read(s.frame, s) : { value: '—', na: NO_FRAMES };

/** A metric of one stats source: its n/a reason, "measuring…" until it has a value. */
const fromSource =
  <T>(id: string, read: (value: T) => MetricValue) =>
  (s: OverviewSample): MetricValue => {
    const reading = s.get<T>(id);
    if (reading.na) return { value: '—', na: reading.na };
    return reading.value === null ? { value: '—', sub: MEASURING } : read(reading.value);
  };

const censusRow = (id: string, label: string, defaultVisible: boolean): OverviewMetric => ({
  id,
  label,
  defaultVisible,
  read: () => ({ value: '—', na: NO_CENSUS }),
});

const ENABLE_STEP_STATS: MetricAction = {
  label: 'enable (reloads)',
  title: 'Turn physics step stats on (a boot-time flag) and reload',
  run: () => setBootOverride({ stepStatsEnabled: true }),
};

const readPhysics = (s: OverviewSample): MetricValue => {
  const step = s.get<PhysicsStepStats>(PROFILER_SOURCE.PHYSICS_STEP);
  const subSteps = s.get<PhysicsSubStepStats>(PROFILER_SOURCE.PHYSICS_SUB_STEPS);
  // Physics off: both sources say so
  if (subSteps.na) return { value: '—', na: subSteps.na };

  const parts: string[] = [];
  let warn = false;
  const result: MetricValue = { value: '—' };
  if (step.na) {
    result.na = step.na;
    // The boot overrides are only applied in the debug env (loadConfig)
    if (step.na === STEP_STATS_OFF && IS_DEBUG_ENV) result.action = ENABLE_STEP_STATS;
  } else if (!step.value) {
    parts.push('waiting for a step');
  } else {
    const { stepMs, dispatchMs, writeBackMs, transport } = step.value;
    result.value = formatMs(stepMs);
    parts.push('step');
    if (dispatchMs !== null) parts.push(`dispatch ${formatMs(dispatchMs)}`);
    if (writeBackMs !== null) {
      // Not the same figure on both transports: never compare them like for like
      const label = transport === 'SHARED_MEMORY' ? 'read latency' : 'transit';
      parts.push(`${label} ${formatMs(writeBackMs)}`);
    }
  }
  if (subSteps.value) {
    const { subSteps: stat, maxSubSteps } = subSteps.value;
    parts.push(`sub-steps ${stat.avg.toFixed(1)}/frame (max ${stat.max})`);
    if (maxSubSteps > 0 && stat.max >= maxSubSteps) {
      warn = true;
      parts.push(`at the ${maxSubSteps} ceiling`);
    }
  }
  result.sub = parts.join(' · ');
  result.warn = warn;
  return result;
};

/** The Overview rows, in their default order. */
const OVERVIEW_METRICS: OverviewMetric[] = [
  {
    id: 'tfps',
    label: 'TFPS (est.)',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.GPU_FRAME],
    read: fromFrames((f, s) => {
      const gpu = s.get<GpuFrameStats>(PROFILER_SOURCE.GPU_FRAME).value;
      if (gpu) {
        const isGpuBound = gpu.ms.avg > f.cpuAvgMs;
        const boundMs = isGpuBound ? gpu.ms.avg : f.cpuAvgMs;
        return {
          value: boundMs > 0 ? (1000 / boundMs).toFixed(0) : '—',
          sub: `${isGpuBound ? 'GPU' : 'CPU'}-bound est. · 1000 / max(CPU, GPU)`,
        };
      }
      return {
        value: f.cpuAvgMs > 0 ? (1000 / f.cpuAvgMs).toFixed(0) : '—',
        sub: 'CPU-bound est. (no GPU time)',
      };
    }),
  },
  {
    id: 'fps',
    label: 'FPS',
    defaultVisible: true,
    read: fromFrames((f) => ({ value: f.fps.toFixed(0), sub: `${f.frames} frames in 1 s` })),
  },
  {
    id: 'frameTime',
    label: 'Frame time',
    defaultVisible: true,
    read: fromFrames((f) => ({
      value: formatMs(f.frameTimeAvgMs),
      sub: `worst ${formatMs(f.frameTimeMaxMs)}`,
    })),
  },
  {
    id: 'cpu',
    label: 'CPU',
    defaultVisible: true,
    read: fromFrames((f) => ({
      value: formatMs(f.cpuAvgMs),
      sub: `max ${formatMs(f.cpuMaxMs)} · main loop per frame`,
    })),
  },
  {
    id: 'gpu',
    label: 'GPU',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.GPU_FRAME],
    read: fromSource<GpuFrameStats>(PROFILER_SOURCE.GPU_FRAME, (g) => ({
      value: formatMs(g.ms.avg),
      sub: `max ${formatMs(g.ms.max)} · per frame, all passes`,
    })),
  },
  {
    id: 'physics',
    label: 'Physics',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.PHYSICS_STEP, PROFILER_SOURCE.PHYSICS_SUB_STEPS],
    read: readPhysics,
  },
  {
    id: 'drawCalls',
    label: 'Draw calls',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.DRAW],
    read: fromSource<DrawStats>(PROFILER_SOURCE.DRAW, (d) => ({
      value: formatAvg(d.drawCalls.avg),
      sub: `max ${formatNumber(d.drawCalls.max)} · per frame, all passes`,
    })),
  },
  {
    id: 'trianglesDrawn',
    label: 'Triangles drawn',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.DRAW],
    read: fromSource<DrawStats>(PROFILER_SOURCE.DRAW, (d) => {
      let sub = `max ${formatNumber(d.triangles.max)} · per frame, all passes`;
      if (d.points.avg > 0) sub += ` · ${formatAvg(d.points.avg)} points`;
      if (d.lines.avg > 0) sub += ` · ${formatAvg(d.lines.avg)} lines`;
      return { value: formatAvg(d.triangles.avg), sub };
    }),
  },
  censusRow('triangles', 'Triangles', true),
  censusRow('vertices', 'Vertices', true),
  censusRow('meshes', 'Meshes', true),
  {
    id: 'entities',
    label: 'Entities',
    defaultVisible: true,
    read: () => {
      let total = 0;
      const worlds = getAllECSWorlds();
      for (let i = 0; i < worlds.length; i++) total += worlds[i].getEntityCount();
      return {
        value: formatNumber(total),
        sub: `total, ${worlds.length} world${worlds.length === 1 ? '' : 's'} (in view: needs the census)`,
      };
    },
  },
  {
    id: 'memJs',
    label: 'JS heap',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.MEMORY_JS],
    read: fromSource<JsMemoryStats>(PROFILER_SOURCE.MEMORY_JS, (m) => ({
      value: formatBytes(m.usedBytes),
      sub: `used, of a ${formatBytes(m.limitBytes)} limit`,
    })),
  },
  {
    id: 'memGpu',
    label: 'GPU memory (est.)',
    defaultVisible: true,
    sources: [PROFILER_SOURCE.MEMORY_GPU],
    read: fromSource<GpuMemoryStats>(PROFILER_SOURCE.MEMORY_GPU, (m) => ({
      value: formatBytes(m.bytes),
      sub: "three's own estimate",
    })),
  },
  censusRow('instances', 'Instances', false),
  censusRow('lights', 'Lights', false),
  {
    id: 'bodies',
    label: 'Physics bodies',
    defaultVisible: false,
    sources: [PROFILER_SOURCE.PHYSICS_OBJECTS],
    read: fromSource<PhysicsObjectStats>(PROFILER_SOURCE.PHYSICS_OBJECTS, (o) => ({
      value: formatNumber(o.bodies),
      sub: `bodies · ${formatNumber(o.colliders)} colliders · ${formatNumber(o.joints)} joints`,
    })),
  },
  {
    id: 'rays',
    label: 'Ray casts',
    defaultVisible: false,
    sources: [PROFILER_SOURCE.RAYS],
    read: fromSource<RayStats>(PROFILER_SOURCE.RAYS, ({ three, physics }) => {
      if (!physics) {
        return {
          value: formatRate(three.avg),
          sub: `Three.js rays per frame, 3 s avg · last frame ${three.lastFrame}`,
        };
      }
      const pending = physics.pending ? ` · ${physics.pending} pending` : '';
      return {
        value: `${formatRate(three.avg)} · ${formatRate(physics.avg)}`,
        sub:
          `Three.js rays · physics queries per frame, 3 s avg · last frame ` +
          `${three.lastFrame} · ${physics.lastFrame}${pending}`,
      };
    }),
  },
  {
    id: 'postFxGpu',
    label: 'PostFX GPU',
    defaultVisible: false,
    sources: [PROFILER_SOURCE.POSTFX],
    read: fromSource<PostFxGpuStats>(PROFILER_SOURCE.POSTFX, (p) => {
      const sub = `CPU ${formatMs(p.cpuMs)} · ${p.passes} passes + composite, per frame`;
      if (p.gpuMs === null) return { value: '—', na: 'no GPU timestamps', sub };
      return { value: formatMs(p.gpuMs), sub };
    }),
  },
  {
    id: 'longTasks',
    label: 'Long tasks',
    defaultVisible: false,
    sources: [PROFILER_SOURCE.LONG_TASKS],
    read: fromSource<LongTaskStats>(PROFILER_SOURCE.LONG_TASKS, (l) => ({
      value: String(l.count),
      sub: l.count ? `in the last second · longest ${formatMs(l.longestMs)}` : 'in the last second',
      warn: l.count > 0,
    })),
  },
  {
    id: 'scene',
    label: 'Scene',
    defaultVisible: false,
    sources: [PROFILER_SOURCE.SCENE],
    read: fromSource<SceneStats>(PROFILER_SOURCE.SCENE, (sc) => ({
      value: sc.currentId || '—',
      sub: sc.isLoading ? `loading${sc.nextId ? ` → ${sc.nextId}` : ''}` : 'loaded',
    })),
  },
];

const metricsById = new Map(OVERVIEW_METRICS.map((m) => [m.id, m]));

// METRIC LIST (the Settings tab's order and visibility)

/**
 * A stored metric list made valid: unknown and repeated ids dropped, missing metrics appended
 * with their default visibility. Always a new array.
 * @param list (unknown) the stored list
 */
export const sanitizeOverviewMetrics = (list: unknown): ProfilerOverviewMetricEntry[] => {
  const result: ProfilerOverviewMetricEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(list)) {
    for (const entry of list as Partial<ProfilerOverviewMetricEntry>[]) {
      const id = entry?.id;
      if (typeof id !== 'string' || !metricsById.has(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, visible: Boolean(entry.visible) });
    }
  }
  for (let i = 0; i < OVERVIEW_METRICS.length; i++) {
    const { id, defaultVisible } = OVERVIEW_METRICS[i];
    if (!seen.has(id)) result.push({ id, visible: defaultVisible });
  }
  return result;
};

/** The default order and visibility. */
export const getDefaultOverviewMetrics = () => sanitizeOverviewMetrics([]);

export const getOverviewMetricLabel = (id: string) => metricsById.get(id)?.label ?? id;

// RENDERING

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeProfilerHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const esc = escapeProfilerHtml;

/** The shown rows' actions of the last render, by metric id (the table's click handler). */
const shownActions = new Map<string, MetricAction>();

const getVisibleMetrics = (settings: ProfilerSettings) => {
  const visible: OverviewMetric[] = [];
  for (let i = 0; i < settings.overviewMetrics.length; i++) {
    const entry = settings.overviewMetrics[i];
    const metric = entry.visible ? metricsById.get(entry.id) : undefined;
    if (metric) visible.push(metric);
  }
  return visible;
};

const getVisibleSourceIds = (settings: ProfilerSettings) => {
  const ids: string[] = [];
  const metrics = getVisibleMetrics(settings);
  for (let i = 0; i < metrics.length; i++) ids.push(...(metrics[i].sources || []));
  return ids;
};

const createSample = (): OverviewSample => {
  const readings = new Map<string, StatsReading<unknown>>();
  return {
    frame: _getFrameProbeSummary(),
    get: <T>(id: string) => {
      let reading = readings.get(id);
      if (!reading) {
        reading = _readStatsSource<unknown>(id);
        readings.set(id, reading);
      }
      return reading as StatsReading<T>;
    },
  };
};

const renderOverviewTable = (settings: ProfilerSettings) => {
  const metrics = getVisibleMetrics(settings);
  if (!metrics.length) {
    return '<div class="profilerNote">No rows are shown. Pick them in the Settings tab.</div>';
  }
  const sample = createSample();
  shownActions.clear();
  let rows = '';
  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    const { value, sub, na, warn, action } = metric.read(sample);
    let secondary = na ? `n/a (${na})` : '';
    if (sub) secondary += secondary ? ` · ${sub}` : sub;
    let actionHtml = '';
    if (action) {
      shownActions.set(metric.id, action);
      actionHtml =
        ` <button class="profilerAction" data-metric="${esc(metric.id)}" ` +
        `title="${esc(action.title)}">${esc(action.label)}</button>`;
    }
    const classes = [na ? 'isNA' : '', warn ? 'isWarn' : ''].filter(Boolean).join(' ');
    rows +=
      `<tr${classes ? ` class="${classes}"` : ''}><th>${esc(metric.label)}</th>` +
      `<td class="profilerValue">${esc(value)}</td>` +
      `<td class="profilerSub">${esc(secondary)}${actionHtml}</td></tr>`;
  }
  return `<div><table class="profilerTable"><tbody>${rows}</tbody></table></div>`;
};

const onTableClick = (e: Event) => {
  const button = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-metric]');
  const id = button?.dataset.metric;
  if (id) shownActions.get(id)?.run();
};

/**
 * The Overview tab: the key figures in one table, refreshed at the update rate while visible. It
 * holds the stats sources of its shown rows while it is mounted.
 * @param settings (object) the live profiler settings (rows, and the refresh rate read on every
 * mount)
 */
export const createProfilerOverviewTabDef = (settings: ProfilerSettings): AnyDebuggerTabDef => {
  const sources = createStatsSourceHolder();
  return {
    id: PROFILER_OVERVIEW_TAB_ID,
    title: 'Overview',
    icon: 'profiler',
    orderNr: 0,
    get refreshIntervalMs() {
      return 1000 / settings.updateRateHz;
    },
    // Runs before every build and refresh: a row shown or hidden in Settings applies here
    onRefresh: () => sources.set(getVisibleSourceIds(settings)),
    onOpen: () => sources.releaseAll,
    content: () => [CMP({ html: () => renderOverviewTable(settings), onClick: onTableClick })],
  };
};
