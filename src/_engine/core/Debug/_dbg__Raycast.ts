import { CMP, type TCMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import { createDebuggerTab, updateDebuggerTab } from '../../debug/DebuggerGUI';
import { createPercentagePie, type PercentagePie } from '../../utils/UI/PercentagePieHtml';
import type { IntervalWindowSnapshot } from '../../utils/stats/IntervalCounterStats';
import { getRayCastStats, isRayCastStatsEnabled, setRayCastStatsEnabled } from '../Raycast';
import { setRayHelperSettings } from './_dbg__RayHelpers';

const LS_KEY = 'debugRayCast';
const TAB_ID = 'rayCastControls';
/** How often the open tab writes the stats values into its view */
const STATS_VIEW_REFRESH_MS = 200;
const rayCastState = {
  showAllRayDebugHelpers: false,
  enableRayStatistics: false,
};

export const _initRayCastingDebugger = () => {
  if (IS_DEBUG_ENV) {
    createDebugControls();
    // The persisted toggles are hydrated by createDebuggerTab
    setRayCastStatsEnabled(rayCastState.enableRayStatistics);
    setRayHelperSettings('THREE', { show: rayCastState.showAllRayDebugHelpers });
  }
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
          {
            key: 'showAllRayDebugHelpers',
            label: 'Show ray cast helpers',
            onChange: () => {
              setRayHelperSettings('THREE', { show: rayCastState.showAllRayDebugHelpers });
            },
          },
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
