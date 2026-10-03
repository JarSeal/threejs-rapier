import { CMP } from '../../../utils/CMP';
import { IS_DEBUG_ENV } from '../../Config';
import { getAllECSWorlds } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import type { AnyDebuggerTabDef } from '../../../debug/DebuggerGUI';
import {
  _getEntityWindowOpener,
  PROFILER_BAR_MEASURES,
  type ProfilerBarMeasure,
  type ProfilerSettings,
} from '../../../debug/Profiler';
import { formatNumber } from '../_dbg__AssetStats';
import {
  CENSUS_KINDS,
  type CensusBucket,
  type CensusKind,
  type InViewTotal,
  type SceneCensus,
} from './_dbg__Census';
import { escapeProfilerHtml as esc } from './_dbg__ProfilerOverview';
import { PROFILER_SOURCE, type DrawStats } from './_dbg__ProfilerSources';
import { _readStatsSource, createStatsSourceHolder } from './_dbg__StatsSources';

/**
 * The Objects tab (§2.8): the in-view census broken down by kind and by owner (two-tone bars:
 * in view solid, culled faded, the length the share of the scene total), the ECS worlds and
 * component counts, the heaviest objects in view, and a short history of the in-view figures.
 * Refreshed at the update rate while visible; it holds the census and the draw counters while
 * it is mounted.
 */

export const PROFILER_OBJECTS_TAB_ID = 'profilerObjects';

const HELD_SOURCES = [PROFILER_SOURCE.CENSUS, PROFILER_SOURCE.DRAW];

const KIND_LABELS: Record<CensusKind, string> = {
  MESH: 'Mesh',
  INSTANCED_MESH: 'InstancedMesh',
  BATCHED_MESH: 'BatchedMesh',
  SKINNED_MESH: 'SkinnedMesh',
  LINES: 'Lines',
  POINTS: 'Points',
  SPRITES: 'Sprites',
  LIGHTS: 'Lights',
  CAMERAS: 'Cameras',
  DEBUG_HELPERS: 'Debug helpers',
};

/** The primitives of the kinds that aren't triangles (shown under the kind). */
const PRIMITIVE_UNITS: Partial<Record<CensusKind, string>> = {
  LINES: 'segments',
  POINTS: 'points',
  SPRITES: 'quads',
  DEBUG_HELPERS: 'primitives',
};

const MEASURE_LABELS: Record<ProfilerBarMeasure, string> = {
  TRIANGLES: 'Triangles',
  VERTICES: 'Vertices',
  OBJECTS: 'Objects',
};

const getMeasure = (bucket: CensusBucket, measure: ProfilerBarMeasure): InViewTotal =>
  measure === 'TRIANGLES'
    ? bucket.triangles
    : measure === 'VERTICES'
      ? bucket.vertices
      : bucket.objects;

/** 1,234 · 12.3k · 123k · 1.23M */
const formatCompact = (n: number) => {
  if (n < 10_000) return formatNumber(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
};

const formatInViewTotal = ({ inView, total }: InViewTotal) =>
  `<b>${formatCompact(inView)}</b><span> / ${formatCompact(total)}</span>`;

// SAMPLE (read once per refresh, in onRefresh)

let census: Readonly<SceneCensus> | null = null;
let censusNa = '';
let draw: Readonly<DrawStats> | null = null;

// HISTORY (the "Over time" sparklines, one sample per census walk)

const HISTORY_LENGTH = 60;

type HistorySeries = {
  label: string;
  values: Float64Array;
  /** The figure of the latest sample (NaN = none). */
  read: () => number;
};

const history: HistorySeries[] = [
  {
    label: 'Triangles in view',
    values: new Float64Array(HISTORY_LENGTH),
    read: () => (census ? census.meshes.triangles.inView : NaN),
  },
  {
    label: 'Meshes in view',
    values: new Float64Array(HISTORY_LENGTH),
    read: () => (census ? census.meshes.objects.inView : NaN),
  },
  {
    label: 'Draw calls',
    values: new Float64Array(HISTORY_LENGTH),
    read: () => (draw ? draw.drawCalls.avg : NaN),
  },
];
let historyHead = 0;
let historyCount = 0;
let lastHistorySampleAt = -Infinity;

const pushHistory = () => {
  for (let i = 0; i < history.length; i++) history[i].values[historyHead] = history[i].read();
  historyHead = (historyHead + 1) % HISTORY_LENGTH;
  if (historyCount < HISTORY_LENGTH) historyCount++;
};

const resetHistory = () => {
  historyHead = 0;
  historyCount = 0;
  lastHistorySampleAt = -Infinity;
};

/** The i-th kept sample, oldest first. */
const getHistoryValue = (series: HistorySeries, i: number) =>
  series.values[(historyHead - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH];

const readSample = () => {
  const censusReading = _readStatsSource<SceneCensus>(PROFILER_SOURCE.CENSUS);
  census = censusReading.value;
  censusNa = censusReading.na || '';
  draw = _readStatsSource<DrawStats>(PROFILER_SOURCE.DRAW).value;
  // A refresh between two walks (eg. a bar measure change) reads the cached census
  if (census && census.sampledAt !== lastHistorySampleAt) {
    lastHistorySampleAt = census.sampledAt;
    pushHistory();
  }
};

// RENDERING

/** Without a census: why (or that it's coming). */
const renderNA = () =>
  `<div class="profilerNote">${esc(censusNa ? `n/a (${censusNa})` : 'measuring…')}</div>`;

const renderHeader = (settings: Readonly<ProfilerSettings>) => {
  let buttons = '';
  for (let i = 0; i < PROFILER_BAR_MEASURES.length; i++) {
    const measure = PROFILER_BAR_MEASURES[i];
    const selected = measure === settings.objectsBarMeasure ? ' class="isSelected"' : '';
    buttons += `<button data-measure="${measure}"${selected}>${MEASURE_LABELS[measure]}</button>`;
  }
  const notes: string[] = [];
  if (census) {
    notes.push(census.isDebugCamera ? "Counted in the debug camera's view" : 'Counted in view');
    if (census.isApprox) notes.push('BatchedMesh approx. (counted whole)');
    notes.push(
      census.excludesDebugHelpers
        ? 'debug helpers in their own row'
        : 'debug helpers counted in their kinds'
    );
    notes.push(`census ${census.sampleMs.toFixed(2)} ms`);
  }
  return (
    `<div class="profilerObjectsHead"><div class="profilerSegmented" title="What the bars measure">` +
    `<span>Bars</span>${buttons}</div>` +
    (census ? `<div class="profilerNote">${esc(notes.join(' · '))}</div>` : renderNA()) +
    `</div>`
  );
};

const onHeaderClick = (setSettings: (partial: Partial<ProfilerSettings>) => void) => (e: Event) => {
  const button = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-measure]');
  const measure = button?.dataset.measure as ProfilerBarMeasure | undefined;
  if (measure && PROFILER_BAR_MEASURES.includes(measure)) {
    setSettings({ objectsBarMeasure: measure });
  }
};

/** A two-tone bar: the in-view part solid, the culled part faded, both as shares of `of`. */
const renderBar = ({ inView, total }: InViewTotal, of: number) => {
  if (!of) return '<div class="profilerBar"></div>';
  const inViewPct = (inView / of) * 100;
  const culledPct = ((total - inView) / of) * 100;
  const title =
    `${formatNumber(inView)} in view, ${formatNumber(total - inView)} culled or hidden · ` +
    `${((total / of) * 100).toFixed(1)}% of the scene`;
  return (
    `<div class="profilerBar" title="${esc(title)}">` +
    `<span class="profilerBarInView" style="width:${inViewPct.toFixed(2)}%"></span>` +
    `<span class="profilerBarCulled" style="width:${culledPct.toFixed(2)}%"></span></div>`
  );
};

type BreakdownRow = { label: string; sub?: string; bucket: CensusBucket };

const totalBucket: CensusBucket = {
  objects: { inView: 0, total: 0 },
  instances: { inView: 0, total: 0 },
  primitives: { inView: 0, total: 0 },
  triangles: { inView: 0, total: 0 },
  vertices: { inView: 0, total: 0 },
};

const sumInto = (target: InViewTotal, source: InViewTotal) => {
  target.inView += source.inView;
  target.total += source.total;
};

/** The breakdown table: objects, triangles, vertices and a bar per row, then the total row. */
const renderBreakdown = (
  heading: string,
  rows: BreakdownRow[],
  measure: ProfilerBarMeasure,
  emptyText: string
) => {
  const total = totalBucket;
  total.objects.inView = total.objects.total = 0;
  total.triangles.inView = total.triangles.total = 0;
  total.vertices.inView = total.vertices.total = 0;
  for (let i = 0; i < rows.length; i++) {
    sumInto(total.objects, rows[i].bucket.objects);
    sumInto(total.triangles, rows[i].bucket.triangles);
    sumInto(total.vertices, rows[i].bucket.vertices);
  }
  const of = getMeasure(total, measure).total;

  const renderRow = (row: BreakdownRow, className = '') => {
    const { objects, triangles, vertices } = row.bucket;
    const sub = row.sub ? `<span class="profilerSub">${esc(row.sub)}</span>` : '';
    return (
      `<tr${className ? ` class="${className}"` : ''}><th>${esc(row.label)}${sub}</th>` +
      `<td class="profilerNum">${formatInViewTotal(objects)}</td>` +
      `<td class="profilerNum">${triangles.total ? formatInViewTotal(triangles) : '—'}</td>` +
      `<td class="profilerNum">${vertices.total ? formatInViewTotal(vertices) : '—'}</td>` +
      `<td class="profilerBarCell">${renderBar(getMeasure(row.bucket, measure), of)}</td></tr>`
    );
  };

  let body = '';
  for (let i = 0; i < rows.length; i++) body += renderRow(rows[i]);
  body += renderRow({ label: 'Total', bucket: total }, 'isTotal');
  return (
    `<div class="profilerSection"><h4>${esc(heading)}</h4>` +
    (rows.length
      ? `<table class="profilerTable profilerBreakdown"><thead><tr><th></th>` +
        `<th>Objects</th><th>Triangles</th><th>Vertices</th>` +
        `<th>${MEASURE_LABELS[measure]}, in view / culled</th></tr></thead>` +
        `<tbody>${body}</tbody></table>`
      : `<div class="profilerNote">${esc(emptyText)}</div>`) +
    `</div>`
  );
};

const getKindSub = (kind: CensusKind, bucket: CensusBucket) => {
  const parts: string[] = [];
  const unit = PRIMITIVE_UNITS[kind];
  if (unit && bucket.primitives.total) {
    parts.push(
      `${formatCompact(bucket.primitives.inView)} / ${formatCompact(bucket.primitives.total)} ${unit}`
    );
  }
  if ((kind === 'INSTANCED_MESH' || kind === 'BATCHED_MESH') && bucket.instances.total) {
    parts.push(
      `${formatCompact(bucket.instances.inView)} / ${formatCompact(bucket.instances.total)} instances`
    );
  }
  if (kind === 'LIGHTS' || kind === 'CAMERAS') parts.push('in view = shown');
  return parts.join(' · ');
};

const renderKinds = (settings: Readonly<ProfilerSettings>) => {
  if (!census) return '<div></div>';
  const rows: BreakdownRow[] = [];
  for (let i = 0; i < CENSUS_KINDS.length; i++) {
    const kind = CENSUS_KINDS[i];
    const bucket = census.kinds[kind];
    if (!bucket.objects.total) continue;
    rows.push({ label: KIND_LABELS[kind], sub: getKindSub(kind, bucket), bucket });
  }
  return renderBreakdown('By kind', rows, settings.objectsBarMeasure, 'The scene is empty.');
};

const renderOwners = (settings: Readonly<ProfilerSettings>) => {
  if (!census) return '<div></div>';
  const rows: BreakdownRow[] = census.owners.map((owner) => ({
    label: owner.label,
    bucket: owner.bucket,
  }));
  return renderBreakdown('By owner', rows, settings.objectsBarMeasure, 'The scene is empty.');
};

// ECS

/** Component type names by their value (the enum keys code uses, eg. 'MANAGED_BY'). */
const COMPONENT_TYPE_NAMES = Object.entries(ComponentType) as [string, ComponentType][];

const renderEcs = () => {
  const worlds = getAllECSWorlds();
  let worldRows = '';
  const counts = new Map<string, number>();
  for (let w = 0; w < worlds.length; w++) {
    const world = worlds[w];
    const name = world.name === world.id ? world.id : `${world.name} (${world.id})`;
    worldRows +=
      `<tr><th>${esc(name)}</th>` +
      `<td class="profilerValue">${formatNumber(world.getEntityCount())}</td>` +
      `<td class="profilerSub">entities</td></tr>`;
    for (let i = 0; i < COMPONENT_TYPE_NAMES.length; i++) {
      const [key, type] = COMPONENT_TYPE_NAMES[i];
      const size = world.getStorage(type).size;
      if (size) counts.set(key, (counts.get(key) || 0) + size);
    }
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let types = '';
  for (let i = 0; i < sorted.length; i++) {
    types += `<div><span>${esc(sorted[i][0])}</span><b>${formatNumber(sorted[i][1])}</b></div>`;
  }
  const typesNote = worlds.length > 1 ? ' (all worlds)' : '';
  return (
    `<div class="profilerSection"><h4>ECS</h4>` +
    `<table class="profilerTable"><tbody>${worldRows}</tbody></table>` +
    `<h5>Component types by entity count${typesNote}</h5>` +
    (types
      ? `<div class="profilerComponentGrid">${types}</div>`
      : `<div class="profilerNote">No components.</div>`) +
    `</div>`
  );
};

// HEAVIEST OBJECTS

/** The entities of the rendered heaviest rows (the census object is reused by the next walk). */
const shownHeavyTargets: { worldId: string; entityId: number }[] = [];

const findWorld = (worldId: string) => getAllECSWorlds().find((w) => w.id === worldId) || null;

const renderHeaviest = () => {
  if (!census) return '<div></div>';
  shownHeavyTargets.length = 0;
  const entries = census.heaviest;
  let rows = '';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let action = '';
    if (IS_DEBUG_ENV && entry.entityId !== -1) {
      const world = findWorld(entry.worldId);
      const opener = world ? _getEntityWindowOpener(world, entry.entityId) : null;
      if (opener) {
        shownHeavyTargets[i] = { worldId: entry.worldId, entityId: entry.entityId };
        action = `<button class="profilerAction" data-heavy="${i}" title="${esc(opener.label)}">Edit</button>`;
      }
    }
    const entity = entry.entityName
      ? `<span class="profilerSub">${esc(entry.entityName)}</span>`
      : '';
    const instances = entry.instances > 1 ? `× ${formatCompact(entry.instances)}` : '';
    rows +=
      `<tr><td class="profilerRank">${i + 1}</td>` +
      `<th>${esc(entry.name)}${entity}</th>` +
      `<td class="profilerSub">${KIND_LABELS[entry.kind]}</td>` +
      `<td class="profilerValue">${formatCompact(entry.triangles)}</td>` +
      `<td class="profilerSub">${instances}</td><td>${action}</td></tr>`;
  }
  return (
    `<div class="profilerSection"><h4>Heaviest objects in view</h4>` +
    (rows
      ? `<table class="profilerTable profilerHeaviest"><thead><tr><th></th><th>Object / entity</th>` +
        `<th>Kind</th><th>Triangles</th><th>Instances</th><th></th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`
      : `<div class="profilerNote">No meshes in view.</div>`) +
    `</div>`
  );
};

const onHeaviestClick = (e: Event) => {
  const button = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-heavy]');
  const target = button ? shownHeavyTargets[Number(button.dataset.heavy)] : undefined;
  if (!target) return;
  const world = findWorld(target.worldId);
  if (!world) return;
  _getEntityWindowOpener(world, target.entityId)?.toggle(world, target.entityId);
};

// OVER TIME

/** An auto-scaled sparkline of the kept samples (0 at the bottom), gaps where there is no value. */
const renderSparkline = (series: HistorySeries, max: number) => {
  const scale = max > 0 ? 100 / max : 0;
  const offset = HISTORY_LENGTH - historyCount;
  let shapes = '';
  let points = '';
  let firstX = -1;
  let lastX = -1;
  const flush = () => {
    if (firstX === -1) return;
    shapes +=
      `<polygon points="${firstX},100 ${points}${lastX},100" />` +
      `<polyline points="${points}" vector-effect="non-scaling-stroke" />`;
    points = '';
    firstX = lastX = -1;
  };
  for (let i = 0; i < historyCount; i++) {
    const value = getHistoryValue(series, i);
    if (Number.isNaN(value)) {
      flush();
      continue;
    }
    const x = offset + i;
    if (firstX === -1) firstX = x;
    lastX = x;
    points += `${x},${(100 - value * scale).toFixed(1)} `;
  }
  flush();
  return (
    `<svg class="profilerSparkline" viewBox="0 0 ${HISTORY_LENGTH - 1} 100" ` +
    `preserveAspectRatio="none" aria-hidden="true">${shapes}</svg>`
  );
};

const renderHistory = (settings: Readonly<ProfilerSettings>) => {
  let blocks = '';
  for (let s = 0; s < history.length; s++) {
    const series = history[s];
    let max = 0;
    let latest = NaN;
    for (let i = 0; i < historyCount; i++) {
      const value = getHistoryValue(series, i);
      if (Number.isNaN(value)) continue;
      if (value > max) max = value;
      latest = value;
    }
    blocks +=
      `<div class="profilerSpark"><div class="profilerSparkHead"><span>${esc(series.label)}</span>` +
      `<b>${Number.isNaN(latest) ? '—' : formatCompact(latest)}</b>` +
      `<span class="profilerSub">max ${formatCompact(max)}</span></div>` +
      `${renderSparkline(series, max)}</div>`;
  }
  const seconds = Math.round(HISTORY_LENGTH / settings.updateRateHz);
  return (
    `<div class="profilerSection"><h4>Over time</h4>` +
    `<div class="profilerNote">The last ${HISTORY_LENGTH} samples (${seconds} s at ` +
    `${settings.updateRateHz} Hz) while this tab is open. Draw calls per frame, 1 s average.</div>` +
    `${blocks}</div>`
  );
};

// TAB

type ObjectsTabOpts = {
  /** The live profiler settings (update rate, bar measure). */
  settings: Readonly<ProfilerSettings>;
  /** Changes settings: persists and applies them. */
  setSettings: (partial: Partial<ProfilerSettings>) => void;
};

/**
 * The Objects tab: the census breakdowns, ECS counts, heaviest objects and a short history.
 * @param opts ({@link ObjectsTabOpts})
 */
export const createProfilerObjectsTabDef = (opts: ObjectsTabOpts): AnyDebuggerTabDef => {
  const { settings, setSettings } = opts;
  const sources = createStatsSourceHolder();
  return {
    id: PROFILER_OBJECTS_TAB_ID,
    title: 'Objects',
    icon: 'objectsCubes',
    orderNr: 10,
    get refreshIntervalMs() {
      return 1000 / settings.updateRateHz;
    },
    // Runs before the build and every refresh: one census read for every section
    onRefresh: () => {
      sources.set(HELD_SOURCES);
      readSample();
    },
    onOpen: () => () => {
      sources.releaseAll();
      resetHistory();
      census = null;
      draw = null;
      shownHeavyTargets.length = 0;
    },
    content: () => [
      CMP({ html: () => renderHeader(settings), onClick: onHeaderClick(setSettings) }),
      CMP({ html: () => renderKinds(settings) }),
      CMP({ html: () => renderOwners(settings) }),
      CMP({ html: renderEcs }),
      CMP({ html: renderHeaviest, onClick: onHeaviestClick }),
      CMP({ html: () => renderHistory(settings) }),
    ],
  };
};
