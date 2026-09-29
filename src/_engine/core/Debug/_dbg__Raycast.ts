import { CMP, type TCMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import {
  createDebuggerTab,
  updateDebuggerTab,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { createPercentagePie, type PercentagePie } from '../../utils/UI/PercentagePieHtml';
import type { IntervalWindowSnapshot } from '../../utils/stats/IntervalCounterStats';
import type { RayHelperKind } from '../RayDebugTypes';
import { getRayCastStats, isRayCastStatsEnabled, setRayCastStatsEnabled } from '../Raycast';
import {
  getRayHelperSettings,
  setRayHelperSettings,
  type RayHelperKindSettings,
} from './_dbg__RayHelpers';

const LS_KEY = 'debugRayCast';
const TAB_ID = 'rayCastControls';
/** How often the open tab writes the stats values into its view */
const STATS_VIEW_REFRESH_MS = 200;
/** The pre-p141 single helper toggle, migrated to `threeShow` */
const LEGACY_SHOW_HELPERS_KEY = 'showAllRayDebugHelpers';

/** The helper settings in the tab, per kind: state key suffix → the kind's setting. The state
 * keys are the kind's prefix plus the suffix (eg. `threeActiveColor`). */
const HELPER_SETTING_KEYS = {
  Show: 'show',
  ShowAnonymous: 'showAnonymous',
  ForceKindColors: 'forceKindColors',
  ActiveColor: 'activeColor',
  InactiveColor: 'inactiveColor',
  Width: 'width',
  HoldMs: 'holdMs',
  FadeOutMs: 'fadeOutMs',
  DashPx: 'dashPx',
  GapPx: 'gapPx',
} as const satisfies Record<string, keyof RayHelperKindSettings>;
type HelperSettingSuffix = keyof typeof HELPER_SETTING_KEYS;
const HELPER_SETTING_SUFFIXES = Object.keys(HELPER_SETTING_KEYS) as HelperSettingSuffix[];

type HelperStatePrefix = 'three';
type HelperState<P extends HelperStatePrefix> = {
  [K in HelperSettingSuffix as `${P}${K}`]: RayHelperKindSettings[(typeof HELPER_SETTING_KEYS)[K]];
};

/** A kind's tab state keys, seeded with the kind's default settings. */
const createHelperState = <P extends HelperStatePrefix>(prefix: P, kind: RayHelperKind) => {
  const settings = getRayHelperSettings(kind);
  const state: Record<string, unknown> = {};
  for (const suffix of HELPER_SETTING_SUFFIXES) {
    state[`${prefix}${suffix}`] = settings[HELPER_SETTING_KEYS[suffix]];
  }
  return state as HelperState<P>;
};

const helperStateKeys = <P extends HelperStatePrefix>(prefix: P) =>
  HELPER_SETTING_SUFFIXES.map((suffix) => `${prefix}${suffix}` as keyof HelperState<P>);

const rayCastState = {
  enableRayStatistics: false,
  ...createHelperState('three', 'THREE'),
};
type RayCastState = typeof rayCastState;

export const _initRayCastingDebugger = () => {
  if (IS_DEBUG_ENV) {
    migrateLegacyShowHelpers();
    createDebugControls();
    // The persisted values are hydrated by createDebuggerTab
    setRayCastStatsEnabled(rayCastState.enableRayStatistics);
    applyHelperSettings('three', 'THREE');
  }
};

/** Pushes a kind's tab state into the helper renderer. Live helpers restyle on the next frame
 * (uniform writes), so this runs on every change, drag ticks included. */
const applyHelperSettings = (prefix: HelperStatePrefix, kind: RayHelperKind) => {
  const patch: Record<string, unknown> = {};
  for (const suffix of HELPER_SETTING_SUFFIXES) {
    patch[HELPER_SETTING_KEYS[suffix]] = rayCastState[`${prefix}${suffix}`];
  }
  setRayHelperSettings(kind, patch as Partial<RayHelperKindSettings>);
};

/** `showAllRayDebugHelpers` became `threeShow`. Rewritten once, before hydration (which only
 * reads the persistKeys). */
const migrateLegacyShowHelpers = () => {
  const saved = lsGetItem(LS_KEY, {}) as Record<string, unknown> | null;
  if (!saved || !(LEGACY_SHOW_HELPERS_KEY in saved)) return;
  const { [LEGACY_SHOW_HELPERS_KEY]: legacyShow, ...rest } = saved;
  if (!('threeShow' in rest) && typeof legacyShow === 'boolean') rest.threeShow = legacyShow;
  lsSetItem(LS_KEY, rest);
};

/** A kind's helper settings folder. */
const helperSettingsFolder = (
  prefix: HelperStatePrefix,
  kind: RayHelperKind,
  title: string
): DebuggerPaneItem<RayCastState> => {
  const onChange = () => applyHelperSettings(prefix, kind);
  const key = (suffix: HelperSettingSuffix) => `${prefix}${suffix}` as const;
  return {
    type: 'folder',
    id: `${prefix}RayHelpers`,
    title,
    content: [
      { key: key('Show'), label: 'Show helpers', onChange },
      { key: key('ShowAnonymous'), label: 'Show rays without an id', onChange },
      { key: key('ForceKindColors'), label: 'Force kind colors', onChange },
      { key: key('ActiveColor'), label: 'Active color', view: 'color', onChange },
      { key: key('InactiveColor'), label: 'Inactive color', view: 'color', onChange },
      { key: key('Width'), label: 'Width (px)', min: 1, max: 20, step: 0.5, onChange },
      { key: key('HoldMs'), label: 'Hold (ms)', min: 0, max: 5000, step: 10, onChange },
      { key: key('FadeOutMs'), label: 'Fade out (ms)', min: 0, max: 10000, step: 50, onChange },
      { key: key('DashPx'), label: 'Dash (px)', min: 1, max: 64, step: 1, onChange },
      { key: key('GapPx'), label: 'Gap (px)', min: 0, max: 64, step: 1, onChange },
    ],
  };
};

const createDebugControls = () => {
  createDebuggerTab({
    id: TAB_ID,
    title: 'Ray cast controls',
    icon: 'heartArrow',
    lsKey: LS_KEY,
    state: rayCastState,
    persistKeys: ['enableRayStatistics', ...helperStateKeys('three')],
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
          helperSettingsFolder('three', 'THREE', 'Three.js rays'),
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
