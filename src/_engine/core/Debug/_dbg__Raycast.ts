import * as THREE from 'three/webgpu';
import { CMP, type TCMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import { createLines, writePolyline, type LineObject } from '../LineManager';
import { createDebuggerTab, updateDebuggerTab } from '../../debug/DebuggerGUI';
import { createPercentagePie, type PercentagePie } from '../../utils/UI/PercentagePieHtml';
import type { IntervalWindowSnapshot } from '../../utils/stats/IntervalCounterStats';
import type { RayDebugOpts } from '../RayDebugTypes';
import { getRayCastStats, isRayCastStatsEnabled, setRayCastStatsEnabled } from '../Raycast';

const DEFAULT_HELPER_COLOR = '#ff0000';
const DEFAULT_MAX_HELPER_LENGTH = 1000;
const LS_KEY = 'debugRayCast';
const TAB_ID = 'rayCastControls';
/** How often the open tab writes the stats values into its view */
const STATS_VIEW_REFRESH_MS = 200;
/** One single-segment line per helper id, refilled on every draw. */
const rayHelpers = new Map<string, { line: LineObject; color: THREE.ColorRepresentation }>();
/** Helper ids drawn since the last cleanup; the rest are disposed by it. */
const drawnHelperIds = new Set<string>();
const rayEnd = new THREE.Vector3();
const rayPoints: THREE.Vector3Like[] = [rayEnd, rayEnd];
const rayCastState = {
  showAllRayDebugHelpers: false,
  enableRayStatistics: false,
};

export const _initRayCastingDebugger = () => {
  if (IS_DEBUG_ENV) {
    createDebugControls();
    // The persisted toggle is hydrated by createDebuggerTab
    setRayCastStatsEnabled(rayCastState.enableRayStatistics);
  }
};

export const _drawRayHelper = (
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  far: number,
  { id: helperId, color: helperColor }: RayDebugOpts
) => {
  if (!rayCastState.showAllRayDebugHelpers) return;

  const color = helperColor || DEFAULT_HELPER_COLOR;
  let helper = rayHelpers.get(helperId);
  if (!helper) {
    helper = {
      line: createLines({
        name: `rayHelper_${helperId}`,
        capacity: 1,
        growth: 'FIXED',
        color,
        // This module disposes them (cleanup, deleteAllRayHelpers), not the scene switch
        persistent: true,
      }),
      color,
    };
    rayHelpers.set(helperId, helper);
  } else if (helper.color !== color) {
    helper.color = color;
    helper.line.setColor(color);
  }

  rayEnd
    .copy(direction)
    .multiplyScalar(Number.isFinite(far) ? far : DEFAULT_MAX_HELPER_LENGTH)
    .add(origin);
  rayPoints[0] = origin;
  writePolyline(helper.line.beginWrite(), rayPoints);
  helper.line.endWrite();
  drawnHelperIds.add(helperId);
};

/** Once per rendered frame (Raycast.ts's LATE_MAIN frame end, after the stats frame has ended):
 * disposes the helpers of rays that weren't cast this frame, and refreshes the stats view. */
export const _onRayCastFrameEnd = () => {
  for (const [helperId, helper] of rayHelpers) {
    if (drawnHelperIds.has(helperId)) continue;
    helper.line.dispose();
    rayHelpers.delete(helperId);
  }
  drawnHelperIds.clear();
};

export const _deleteAllRayHelpers = () => {
  for (const helper of rayHelpers.values()) helper.line.dispose();
  rayHelpers.clear();
  drawnHelperIds.clear();
};

export const _toggleAllRayDebugHelpers = (show?: boolean) => {
  rayCastState.showAllRayDebugHelpers = show ?? !rayCastState.showAllRayDebugHelpers;
  updateDebuggerTab(TAB_ID);
};

const createDebugControls = () => {
  createDebuggerTab({
    id: TAB_ID,
    title: 'Ray cast controls',
    icon: 'heartArrow',
    lsKey: LS_KEY,
    state: rayCastState,
    persistKeys: ['showAllRayDebugHelpers', 'enableRayStatistics'],
    // Only while the tab is visible
    refreshIntervalMs: STATS_VIEW_REFRESH_MS,
    onRefresh: refreshStatsView,
    onOpen: () => () => {
      statsView = null;
    },
    content: () => [
      {
        pane: true,
        content: [
          { key: 'showAllRayDebugHelpers', label: 'Show ray cast helpers' },
          {
            key: 'enableRayStatistics',
            label: 'Enable ray cast statistics',
            onChange: () => {
              setRayCastStatsEnabled(rayCastState.enableRayStatistics);
              updateDebuggerTab(TAB_ID);
            },
          },
        ],
      },
      buildStatsView(),
    ],
  });
};

type StatsValue = { elem: HTMLElement; text: string };
type StatsWindowRow = { win: IntervalWindowSnapshot; pie: PercentagePie; value: StatsValue };
/** The mounted stats block's cached elements (null while the tab isn't mounted) */
let statsView: {
  list: TCMP;
  isActive: boolean | null;
  lastFrame: StatsValue;
  maxEver: StatsValue;
  rows: StatsWindowRow[];
} | null = null;

const INACTIVE_VALUE = '-';

const addStatsRow = (list: TCMP, label: string, pie?: PercentagePie): StatsValue => {
  const row = list.add({ tag: 'li' });
  const labelCmp = row.add({ tag: 'span', class: 'rayStatLabel', text: label });
  if (pie) labelCmp.add(pie.cmp);
  return { elem: row.add({ tag: 'span', text: INACTIVE_VALUE }).elem, text: INACTIVE_VALUE };
};

/** Builds the stats block once per mount (static markup, the value elements are cached). */
const buildStatsView = () => {
  const root = CMP({ class: 'rayCastStats' });
  root.add({ tag: 'h3', text: 'Stats:' });
  const list = root.add({ tag: 'ul' });
  const lastFrame = addStatsRow(list, 'Last frame:');
  const maxEver = addStatsRow(list, 'Max ever:');
  const rows: StatsWindowRow[] = [];
  const windows = getRayCastStats().windows;
  for (const kind of ['AVERAGE', 'MIN_MAX'] as const) {
    const heading = kind === 'AVERAGE' ? 'Average per frame' : 'Max / min per frame';
    list.add({ tag: 'li', class: 'rayStatHeading', text: heading });
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      if (win.kind !== kind) continue;
      const pie = createPercentagePie();
      const value = addStatsRow(list, `Last ${win.intervalMs / 1000}s: `, pie);
      rows.push({ win, pie, value });
    }
  }
  statsView = { list, isActive: null, lastFrame, maxEver, rows };
  refreshStatsView();
  return root;
};

const writeStatsValue = (value: StatsValue, text: string) => {
  if (value.text === text) return;
  value.text = text;
  value.elem.textContent = text;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Writes the stats into the cached view: only changed texts and pie values, no html. */
const refreshStatsView = () => {
  const view = statsView;
  if (!view) return;
  const isActive = isRayCastStatsEnabled();
  if (isActive !== view.isActive) {
    view.isActive = isActive;
    view.list.updateClass('inactive', isActive ? 'remove' : 'add');
  }
  const s = getRayCastStats();
  writeStatsValue(view.lastFrame, isActive ? String(s.lastFrame) : INACTIVE_VALUE);
  writeStatsValue(view.maxEver, isActive ? String(s.maxEver) : INACTIVE_VALUE);
  for (let i = 0; i < view.rows.length; i++) {
    const { win, pie, value } = view.rows[i];
    pie.set(isActive ? win.progress * 100 : 0);
    if (!isActive) {
      writeStatsValue(value, INACTIVE_VALUE);
    } else if (win.kind === 'AVERAGE') {
      writeStatsValue(value, String(round2(win.average)));
    } else {
      writeStatsValue(value, `${win.max} / ${win.min}`);
    }
  }
};
