import { CMP, type TCMP } from '../../../utils/CMP';
import styles from './Profiler.module.scss';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { lwarn } from '../../../utils/Logger';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import {
  openDraggableWindow,
  registerDraggableWindow,
  toggleDraggableWindow,
  updateDraggableWindow,
  type OpenDraggableWindowProps,
} from '../../UI/DraggableWindow';
import {
  hydrateDebuggerTabState,
  type AnyDebuggerTabDef,
  type UpdateDebuggerTabOpts,
} from '../../../debug/DebuggerGUI';
import {
  DEFAULT_PROFILER_SETTINGS,
  PROFILER_LS_KEY,
  PROFILER_UI_LS_KEY,
  PROFILER_UPDATE_RATES_HZ,
  PROFILER_WINDOW_ID,
  type ProfilerSettings,
} from '../../../debug/Profiler';
import { updateOnScreenTools } from '../../../debug/OnScreenTools';
import { updateStatsProfilerEntryPoint } from '../../../debug/Stats';
import { createTabHost } from '../_dbg__TabHost';
import { persistDebuggerTabStateValue } from '../_dbg__DebuggerPaneBuilder';
import { _acquireFrameProbe, _releaseFrameProbe } from './_dbg__FrameProbe';
import {
  createProfilerOverviewTabDef,
  PROFILER_OVERVIEW_TAB_ID,
  sanitizeOverviewMetrics,
} from './_dbg__ProfilerOverview';
import { registerBuiltInStatsSources } from './_dbg__ProfilerSources';
import { _syncStatsSources } from './_dbg__StatsSources';
import {
  createProfilerSettingsTabDef,
  PROFILER_SETTINGS_PERSIST_KEYS,
  PROFILER_SETTINGS_TAB_ID,
} from './_dbg__ProfilerSettings';

// SETTINGS

const settings: ProfilerSettings = { ...DEFAULT_PROFILER_SETTINGS };

/** Puts values the Settings tab can't offer (a stale or hand-edited LS) back to their default. */
const sanitizeSettings = () => {
  if (!(PROFILER_UPDATE_RATES_HZ as readonly number[]).includes(settings.updateRateHz)) {
    settings.updateRateHz = DEFAULT_PROFILER_SETTINGS.updateRateHz;
  }
  // Also turns the default's empty list into the default rows (always a new array)
  settings.overviewMetrics = sanitizeOverviewMetrics(settings.overviewMetrics);
  settings.openFromStatsPanels = Boolean(settings.openFromStatsPanels);
  settings.enabledInProdTest = Boolean(settings.enabledInProdTest);
  settings.measureGpu = Boolean(settings.measureGpu);
  settings.excludeDebugHelpers = Boolean(settings.excludeDebugHelpers);
};

hydrateDebuggerTabState({
  lsKey: PROFILER_LS_KEY,
  state: settings,
  persistKeys: PROFILER_SETTINGS_PERSIST_KEYS,
});
sanitizeSettings();

/** Applies a changed setting (it is already written and persisted). */
const applySetting = (key: keyof ProfilerSettings) => {
  switch (key) {
    case 'openFromStatsPanels':
      updateStatsProfilerEntryPoint();
      break;
    case 'enabledInProdTest':
      // The window's stored config carries the flag that lets it reopen in prodTest. A closed
      // window gets it on its next open.
      if (windowRoot) openDraggableWindow({ ...getWindowProps(), focusFirstElement: false });
      updateOnScreenTools('PLAY');
      break;
    case 'updateRateHz':
      // The Overview reads it on its next mount (it isn't visible next to the Settings tab)
      break;
    case 'overviewMetrics':
      // An open Overview (eg. changed through setProfilerSettings) applies it now, otherwise
      // its next mount does
      _updateProfilerTab(PROFILER_OVERVIEW_TAB_ID);
      break;
    case 'measureGpu':
      // A held GPU frame time source is released or acquired right away
      _syncStatsSources();
      break;
    case 'excludeDebugHelpers':
      // The census reads it on its next sample (a cached one taken with the old value isn't reused)
      break;
  }
};

const applyAllSettings = () => {
  for (let i = 0; i < PROFILER_SETTINGS_PERSIST_KEYS.length; i++) {
    applySetting(PROFILER_SETTINGS_PERSIST_KEYS[i]);
  }
};

const settingsTabDef = createProfilerSettingsTabDef({
  settings,
  onChange: applySetting,
  setSettings: (partial) => _setProfilerSettings(partial),
  onClearLS: () => {
    Object.assign(settings, DEFAULT_PROFILER_SETTINGS);
    sanitizeSettings();
    applyAllSettings();
    _updateProfilerTab(PROFILER_SETTINGS_TAB_ID);
  },
}) as unknown as AnyDebuggerTabDef;

export const _getProfilerSettings = () => settings;

export const _setProfilerSettings = (partial: Partial<ProfilerSettings>) => {
  const changed: (keyof ProfilerSettings)[] = [];
  for (let i = 0; i < PROFILER_SETTINGS_PERSIST_KEYS.length; i++) {
    const key = PROFILER_SETTINGS_PERSIST_KEYS[i];
    if (!(key in partial)) continue;
    (settings as Record<string, unknown>)[key] = partial[key];
    changed.push(key);
  }
  sanitizeSettings();
  for (let i = 0; i < changed.length; i++) {
    persistDebuggerTabStateValue(settingsTabDef, changed[i]);
    applySetting(changed[i]);
  }
  if (changed.length) _updateProfilerTab(PROFILER_SETTINGS_TAB_ID);
};

// UI STATE (the open tab; the folder states share the key)

type ProfilerUIState = { currentTabId?: string };

const getSavedTabId = () =>
  (lsGetItem(PROFILER_UI_LS_KEY, {}) as ProfilerUIState | null)?.currentTabId || '';

const saveTabId = (currentTabId: string) => {
  const uiState = (lsGetItem(PROFILER_UI_LS_KEY, {}) as ProfilerUIState | null) || {};
  lsSetItem(PROFILER_UI_LS_KEY, { ...uiState, currentTabId });
};

// TABS

// Keyed by tab id. A Map keeps insertion order, so a re-registered (replaced) tab keeps its
// registration position for the ordering tie-break.
const tabs = new Map<string, AnyDebuggerTabDef>();

/** All tabs in menu order: `orderNr`, then registration order (Array.sort is stable). */
const getOrderedTabs = () =>
  [...tabs.values()].sort((a, b) => (a.orderNr ?? Infinity) - (b.orderNr ?? Infinity));

// WINDOW

/** The window content's root, while the window is open (its content is mounted). */
let windowRoot: TCMP | null = null;
/** The mounted tab's scroller. */
let tabContentCMP: TCMP | null = null;
const menuButtons = new Map<string, TCMP>();

const host = createTabHost({
  getContainer: () => tabContentCMP,
  isVisible: () => Boolean(windowRoot),
  onMount: (def) => {
    for (const [id, button] of menuButtons) {
      button.updateClass(styles.tabButton_selected, id === def.id ? 'add' : 'remove');
    }
  },
  label: 'Profiler tab',
});

const getWindowProps = (): OpenDraggableWindowProps => ({
  id: PROFILER_WINDOW_ID,
  title: 'Profiler',
  icon: 'profiler',
  isDebugWindow: true,
  saveToLS: true,
  showInProdTest: settings.enabledInProdTest,
  size: { w: 560, h: 640 },
  minSize: { w: 380, h: 320 },
});

const selectTab = (def: AnyDebuggerTabDef) => {
  saveTabId(def.id);
  if (host.mountedId === def.id) return;
  host.mount(def);
  if (tabContentCMP) tabContentCMP.elem.scrollTop = 0;
};

const createMenuButton = (def: AnyDebuggerTabDef) => {
  const icon = getSvgIcon(def.icon);
  return CMP({
    class: styles.tabButton,
    html: () => `<button>${icon}</button>`,
    attr: { title: def.title },
    onClick: () => selectTab(def),
  });
};

/** Releases what the open window holds. Runs after the content's CMPs are removed (a close, or a
 * rebuild right before the new content is built). */
const onWindowContentRemoved = () => {
  host.unmount();
  windowRoot = null;
  tabContentCMP = null;
  menuButtons.clear();
  _releaseFrameProbe();
  updateOnScreenTools('PLAY');
};

/** The window content: the tab menu and the mounted tab. Built on every open and rebuild. */
const buildWindowContent = () => {
  const root = CMP({ class: styles.profiler, onRemoveCmp: onWindowContentRemoved });
  windowRoot = root;
  _acquireFrameProbe();

  const orderedTabs = getOrderedTabs();
  const menu = root.add({ class: styles.tabMenu });
  for (let i = 0; i < orderedTabs.length; i++) {
    const button = createMenuButton(orderedTabs[i]);
    menuButtons.set(orderedTabs[i].id, button);
    menu.add(button);
  }
  tabContentCMP = root.add({ class: styles.tabContent });

  const def = tabs.get(getSavedTabId()) || orderedTabs[0];
  if (def) host.mount(def);

  updateOnScreenTools('PLAY');
  return root;
};

registerDraggableWindow(PROFILER_WINDOW_ID, { content: buildWindowContent });

export const _toggleProfilerWindow = () => toggleDraggableWindow(getWindowProps());

export const _isProfilerWindowOpen = () => Boolean(windowRoot);

export const _createProfilerTab = (def: AnyDebuggerTabDef) => {
  if (def.sceneId) {
    lwarn(`Profiler tab "${def.id}" has a sceneId, which profiler tabs don't support (ignored).`);
  }
  tabs.set(def.id, def);
  if (!windowRoot) return;
  // The menu is part of the window content: rebuild it, keeping the scroll position
  const scrollPos = tabContentCMP?.elem.scrollTop || 0;
  updateDraggableWindow(PROFILER_WINDOW_ID);
  if (tabContentCMP) tabContentCMP.elem.scrollTop = scrollPos;
};

export const _openProfilerTab = (id: string) => {
  const def = tabs.get(id);
  if (!def) {
    lwarn(`Could not find a profiler tab to open with id "${id}" in openProfilerTab`);
    return;
  }
  saveTabId(id);
  // Opens the window on the saved tab, or brings an open one to the front
  openDraggableWindow(getWindowProps());
  selectTab(def);
};

export const _isProfilerTabOpen = (id: string) => Boolean(windowRoot) && host.mountedId === id;

export const _updateProfilerTab = (id: string, opts?: UpdateDebuggerTabOpts) => {
  if (!_isProfilerTabOpen(id)) return;
  host.refresh(opts?.rebuild);
};

// STATS SOURCES

export { _onStatsSourceReplaced } from './_dbg__StatsSources';

registerBuiltInStatsSources(settings);

// BUILT-IN TABS

_createProfilerTab(createProfilerOverviewTabDef(settings));
_createProfilerTab(settingsTabDef);
