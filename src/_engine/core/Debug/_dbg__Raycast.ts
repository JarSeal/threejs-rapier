import { CMP, type TCMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import {
  createDebuggerTab,
  persistDebuggerTabValue,
  updateDebuggerTab,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { createPercentagePie, type PercentagePie } from '../../utils/UI/PercentagePieHtml';
import type {
  IntervalCounterSnapshot,
  IntervalWindowSnapshot,
} from '../../utils/stats/IntervalCounterStats';
import type { RayHelperKind } from '../RayDebugTypes';
import { getRayCastStats, isRayCastStatsEnabled, setRayCastStatsEnabled } from '../Raycast';
import {
  getPhysicsRayStats,
  getPhysicsState,
  isPhysicsRayStatsEnabled,
  isPhysicsWorldEnabled,
  setPhysicsRayHelpersEnabled,
  setPhysicsRayStatsEnabled,
} from '../PhysicsAPI';
import {
  getRayHelperSettings,
  setRayHelperSettings,
  type RayHelperKindSettings,
} from './_dbg__RayHelpers';
import { _refreshRayTesterHelperNotices, _toggleRayTesterWindow } from './_dbg__RayTester';

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
  DepthTest: 'depthTest',
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

type HelperStatePrefix = 'three' | 'physics';
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
  physicsEnableRayStatistics: false,
  ...createHelperState('physics', 'PHYSICS'),
};
type RayCastState = typeof rayCastState;

export const _initRayCastingDebugger = () => {
  if (IS_DEBUG_ENV) {
    migrateLegacyShowHelpers();
    createDebugControls();
    // The persisted values are hydrated by createDebuggerTab
    setRayCastStatsEnabled(rayCastState.enableRayStatistics);
    applyHelperSettings('three', 'THREE');
    setPhysicsRayStatsEnabled(rayCastState.physicsEnableRayStatistics);
    applyHelperSettings('physics', 'PHYSICS');
  }
};

/** Pushes a kind's tab state into the helper renderer (and, for physics, whether the Physics API
 * draws its queries at all). Live helpers restyle on the next frame (uniform writes), so this
 * runs on every change, drag ticks included. */
const applyHelperSettings = (prefix: HelperStatePrefix, kind: RayHelperKind) => {
  const patch: Record<string, unknown> = {};
  for (const suffix of HELPER_SETTING_SUFFIXES) {
    patch[HELPER_SETTING_KEYS[suffix]] = rayCastState[`${prefix}${suffix}`];
  }
  setRayHelperSettings(kind, patch as Partial<RayHelperKindSettings>);
  if (kind === 'PHYSICS') setPhysicsRayHelpersEnabled(rayCastState.physicsShow);
  _refreshRayTesterHelperNotices();
};

/** Turns a kind's helpers on or off as the tab's "Show helpers" does (persisted, tab refreshed).
 * The ray tester windows use it, so the tab stays the one owner of the setting. */
export const _setRayHelpersShown = (kind: RayHelperKind, show: boolean) => {
  const prefix: HelperStatePrefix = kind === 'THREE' ? 'three' : 'physics';
  const key = `${prefix}Show` as const;
  rayCastState[key] = show;
  applyHelperSettings(prefix, kind);
  persistDebuggerTabValue(TAB_ID, key);
  updateDebuggerTab(TAB_ID);
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
      { key: key('DepthTest'), label: 'Respect depth', onChange },
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
    persistKeys: [
      'enableRayStatistics',
      ...helperStateKeys('three'),
      'physicsEnableRayStatistics',
      ...helperStateKeys('physics'),
    ],
    // Only while the tab is visible
    refreshIntervalMs: STATS_VIEW_REFRESH_MS,
    onRefresh: refreshStatsView,
    onOpen: () => () => {
      statsBlocks = [];
      pendingQueriesView = null;
    },
    content: () => {
      // Re-run on every mount and rebuild: the views below re-register themselves
      statsBlocks = [];
      pendingQueriesView = null;
      return [
        {
          pane: true,
          content: [
            {
              type: 'button',
              title: 'Three.js ray tester',
              onClick: () => _toggleRayTesterWindow('THREE'),
            },
            {
              type: 'button',
              title: 'Physics ray tester',
              // Re-evaluated on every tab refresh (a scene may have no physics world)
              disabled: () => !isPhysicsWorldEnabled(),
              onClick: () => _toggleRayTesterWindow('PHYSICS'),
            },
          ],
        },
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
        buildThreeStatsView(),
        {
          pane: true,
          content: [
            helperSettingsFolder('physics', 'PHYSICS', 'Physics rays'),
            {
              key: 'physicsEnableRayStatistics',
              label: 'Enable physics ray statistics',
              onChange: () => {
                setPhysicsRayStatsEnabled(rayCastState.physicsEnableRayStatistics);
                updateDebuggerTab(TAB_ID);
              },
            },
          ],
        },
        buildPhysicsStatsView(),
      ];
    },
  });
};

type StatsValue = { elem: HTMLElement; text: string };
type StatsWindowRow = { win: IntervalWindowSnapshot; pie: PercentagePie; value: StatsValue };
/** One counter's cached stats elements */
type StatsBlock = {
  list: TCMP;
  getStats: () => Readonly<IntervalCounterSnapshot>;
  isEnabled: () => boolean;
  isActive: boolean | null;
  lastFrame: StatsValue;
  maxEver: StatsValue;
  rows: StatsWindowRow[];
};
/** The mounted stats blocks (empty while the tab isn't mounted) */
let statsBlocks: StatsBlock[] = [];
/** The mounted pending physics queries row (WORKER_THREAD only) */
let pendingQueriesView: { list: TCMP; isActive: boolean | null; value: StatsValue } | null = null;

const INACTIVE_VALUE = '-';

const addStatsRow = (list: TCMP, label: string, pie?: PercentagePie): StatsValue => {
  const row = list.add({ tag: 'li' });
  const labelCmp = row.add({ tag: 'span', class: 'rayStatLabel', text: label });
  if (pie) labelCmp.add(pie.cmp);
  return { elem: row.add({ tag: 'span', text: INACTIVE_VALUE }).elem, text: INACTIVE_VALUE };
};

/** Builds one counter's stats markup once per mount (static, the value elements are cached). */
const buildStatsBlock = (
  root: TCMP,
  title: string,
  getStats: () => Readonly<IntervalCounterSnapshot>,
  isEnabled: () => boolean
) => {
  root.add({ tag: 'h3', text: title });
  const list = root.add({ tag: 'ul' });
  const lastFrame = addStatsRow(list, 'Last frame:');
  const maxEver = addStatsRow(list, 'Max ever:');
  const rows: StatsWindowRow[] = [];
  const windows = getStats().windows;
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
  statsBlocks.push({ list, getStats, isEnabled, isActive: null, lastFrame, maxEver, rows });
};

const buildThreeStatsView = () => {
  const root = CMP({ class: 'rayCastStats' });
  buildStatsBlock(root, 'Three.js ray stats:', getRayCastStats, isRayCastStatsEnabled);
  refreshStatsView();
  return root;
};

const getPhysicsRaysSnapshot = () => getPhysicsRayStats().rays;
const getPhysicsShapeCastsSnapshot = () => getPhysicsRayStats().shapeCasts;

/** The physics stats, or a note when there is no physics world (the settings above stay). */
const buildPhysicsStatsView = () => {
  const root = CMP({ class: 'rayCastStats' });
  if (!isPhysicsWorldEnabled()) {
    root.add({ tag: 'p', class: 'rayStatNote', text: 'No physics world' });
    return root;
  }
  buildStatsBlock(root, 'Physics ray stats:', getPhysicsRaysSnapshot, isPhysicsRayStatsEnabled);
  buildStatsBlock(
    root,
    'Physics shape cast stats:',
    getPhysicsShapeCastsSnapshot,
    isPhysicsRayStatsEnabled
  );
  if (getPhysicsState().workerTarget === 'WORKER_THREAD') {
    const list = root.add({ tag: 'ul' });
    list.add({ tag: 'li', class: 'rayStatHeading', text: 'Worker' });
    const value = addStatsRow(list, 'Pending queries:');
    pendingQueriesView = { list, isActive: null, value };
  }
  refreshStatsView();
  return root;
};

const writeStatsValue = (value: StatsValue, text: string) => {
  if (value.text === text) return;
  value.text = text;
  value.elem.textContent = text;
};

const writeListActive = (view: { list: TCMP; isActive: boolean | null }, isActive: boolean) => {
  if (isActive === view.isActive) return;
  view.isActive = isActive;
  view.list.updateClass('inactive', isActive ? 'remove' : 'add');
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const refreshStatsBlock = (block: StatsBlock) => {
  const isActive = block.isEnabled();
  writeListActive(block, isActive);
  const s = block.getStats();
  writeStatsValue(block.lastFrame, isActive ? String(s.lastFrame) : INACTIVE_VALUE);
  writeStatsValue(block.maxEver, isActive ? String(s.maxEver) : INACTIVE_VALUE);
  for (let i = 0; i < block.rows.length; i++) {
    const { win, pie, value } = block.rows[i];
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

/** Writes the stats into the cached views: only changed texts and pie values, no html. */
const refreshStatsView = () => {
  for (let i = 0; i < statsBlocks.length; i++) refreshStatsBlock(statsBlocks[i]);
  const pending = pendingQueriesView;
  if (pending) {
    const isActive = isPhysicsRayStatsEnabled();
    writeListActive(pending, isActive);
    const pendingQueries = getPhysicsRayStats().pendingQueries;
    writeStatsValue(pending.value, isActive ? String(pendingQueries) : INACTIVE_VALUE);
  }
};
