import { CMP, type TCMP } from '../../utils/CMP';
import { getConfig } from '../Config';
import { getCurrentSceneId } from '../Scene';
import { openDialog } from '../UI/DialogWindow';
import { closeDraggableWindow } from '../UI/DraggableWindow';
import {
  doKeyChordsCollide,
  getKeyBindings,
  getKeyChordLabel,
  type KeyBinding,
} from '../Input/KeyboardInput';
import {
  getDefaultDebugKeyBindings,
  type DebugKeyCategory,
  type DefaultDebugKeyBinding,
} from '../Input/DefaultDebugKeyBindings';
import styles from './DebugKeyShortcuts.module.scss';

export type DebugKeyShortcutsTab = 'APP' | 'AEKASHA';

const DIALOG_ID = 'debugKeyShortcutsDialog';

const TABS: { id: DebugKeyShortcutsTab; title: string }[] = [
  { id: 'APP', title: 'App (current scene)' },
  { id: 'AEKASHA', title: 'Aekasha' },
];

type Tone = 'muted' | 'info' | 'warning';
type Badge = { text: string; tone: Tone };
type ShortcutRow = {
  keys: string;
  name: string;
  id?: string;
  description?: string;
  badges: Badge[];
  notes: { text: string; tone: Tone }[];
  isInactive?: boolean;
};
type ShortcutSection = { title: string; description?: string; rows: ShortcutRow[] };

const CATEGORIES: { id: DebugKeyCategory; title: string; description: string }[] = [
  { id: 'DEBUGGER', title: 'Debugger', description: 'Debug mode.' },
  { id: 'CAMERA', title: 'Camera', description: 'Debug mode.' },
  { id: 'LOOPS_AND_MODES', title: 'Loops and modes', description: 'Debug mode.' },
  { id: 'VIEWPORT', title: 'Viewport helpers and tools', description: 'Debug mode.' },
  {
    id: 'PROD_TEST',
    title: 'Production test mode',
    description:
      'Production test mode only (?isProdTest=true). Each key gives way to an app binding of the same key.',
  },
];

/** Engine pointer and context shortcuts that are not key bindings (not rebindable). */
const CONTEXT_SHORTCUTS: { keys: string; name: string; context: string }[] = [
  { keys: 'Left drag', name: 'Orbit the debug camera', context: 'Debug camera' },
  { keys: 'Right drag', name: 'Pan the debug camera', context: 'Debug camera' },
  { keys: 'Wheel', name: 'Zoom the debug camera', context: 'Debug camera' },
  {
    keys: 'Click',
    name: 'Align the debug camera to an axis (again: the opposite axis)',
    context: 'Axes gizmo, debug camera',
  },
  { keys: 'Drag', name: 'Orbit the debug camera', context: 'Axes gizmo, debug camera' },
  { keys: 'Click', name: 'Pick a point', context: 'Ray tester, pick armed' },
  { keys: 'Escape', name: 'Cancel the pick', context: 'Ray tester, pick armed' },
];

const KEY_TYPE_LABELS: { [type in KeyBinding['type']]: string } = {
  KEY_DOWN: 'Key down',
  KEY_UP: 'Key up',
  KEY_HELD: 'Held',
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const isInScene = (binding: Readonly<KeyBinding>, sceneId: string | null) =>
  !binding.sceneId || binding.sceneId === sceneId;

/** The name a binding is listed with in another binding's note. */
const quoteBinding = (binding: Readonly<KeyBinding>) => `“${binding.name || binding.id}”`;

const getEngineKeyIds = () => {
  const { debug, prodTest } = getDefaultDebugKeyBindings();
  return new Set([...debug, ...prodTest].map((b) => b.id));
};

/** The app's CONFIG.ts debugKeys that add a key (not override a default): debug mode only. */
const getAppDebugKeyIds = (engineKeyIds: Set<string>) =>
  new Set((getConfig().debugKeys || []).map((k) => k.id).filter((id) => !engineKeyIds.has(id)));

// AEKASHA TAB

const getEngineRow = (
  def: Readonly<DefaultDebugKeyBinding>,
  appBindings: Readonly<KeyBinding>[]
): ShortcutRow => {
  const isProdTestKey = def.category === 'PROD_TEST';
  const override = isProdTestKey ? undefined : getConfig().debugKeys?.find((k) => k.id === def.id);
  const registered = getKeyBindings().find((b) => b.id === def.id);
  const chord = override?.chord ?? def.chord;
  const notes: ShortcutRow['notes'] = [];
  let status: Badge = { text: 'Default', tone: 'muted' };
  const setStatus = (text: string, tone: Tone) => {
    if (status.tone !== 'warning') status = { text, tone };
  };

  if (override?.enabled === false) {
    notes.push({ text: 'Turned off in CONFIG.ts (debugKeys).', tone: 'warning' });
    setStatus('Off', 'warning');
  } else if (!isProdTestKey) {
    if (!registered) {
      notes.push({ text: 'Removed by app code (deleteKeyBinding).', tone: 'warning' });
      setStatus('Removed by app', 'warning');
    } else if (registered.fn !== (override?.fn ?? def.fn)) {
      notes.push({ text: 'Replaced by app code (a binding with the same id).', tone: 'warning' });
      setStatus('Replaced by app', 'warning');
    } else if (registered.enabled === false) {
      notes.push({ text: 'Disabled by app code (setKeyBindingEnabled).', tone: 'warning' });
      setStatus('Disabled by app', 'warning');
    }
  }

  if (override && override.enabled !== false) {
    const defaultLabel = getKeyChordLabel(def.chord);
    if (override.chord && getKeyChordLabel(override.chord) !== defaultLabel) {
      notes.push({ text: `Rebound in CONFIG.ts (default: ${defaultLabel}).`, tone: 'info' });
      setStatus('Rebound', 'info');
    }
    if (override.fn) {
      notes.push({ text: 'Action replaced in CONFIG.ts.', tone: 'info' });
      setStatus('Custom action', 'info');
    }
    if (!notes.length)
      notes.push({ text: 'Set in CONFIG.ts, same as the default.', tone: 'muted' });
  }

  if (override?.enabled !== false) {
    for (const appBinding of appBindings) {
      if (!doKeyChordsCollide(appBinding.chord, chord)) continue;
      if (isProdTestKey) {
        notes.push({
          text: `The app's ${quoteBinding(appBinding)} takes this key.`,
          tone: 'warning',
        });
        setStatus('App takes over', 'warning');
      } else {
        notes.push({
          text: `Also bound by the app: ${quoteBinding(appBinding)} (both run).`,
          tone: 'warning',
        });
        setStatus('Shared with app', 'warning');
      }
    }
  }

  return {
    keys: getKeyChordLabel(chord),
    name: def.name || def.id,
    id: def.id,
    badges: [status],
    notes,
    isInactive: status.tone === 'warning' && status.text !== 'Shared with app',
  };
};

const getAekashaSections = (): ShortcutSection[] => {
  const sceneId = getCurrentSceneId();
  const engineKeyIds = getEngineKeyIds();
  const appDebugKeyIds = getAppDebugKeyIds(engineKeyIds);
  const appBindings = getKeyBindings().filter(
    (b) => !engineKeyIds.has(b.id) && isInScene(b, sceneId) && b.enabled !== false
  );
  // In production test mode the app's CONFIG.ts debugKeys are not registered
  const prodTestAppBindings = appBindings.filter((b) => !appDebugKeyIds.has(b.id));
  const { debug, prodTest } = getDefaultDebugKeyBindings();
  const all = [...debug, ...prodTest];

  const sections: ShortcutSection[] = CATEGORIES.map((category) => ({
    title: category.title,
    description: category.description,
    rows: all
      .filter((def) => def.category === category.id)
      .map((def) =>
        getEngineRow(def, def.category === 'PROD_TEST' ? prodTestAppBindings : appBindings)
      ),
  }));

  sections.push({
    title: 'Pointer and context',
    description: 'Debug mode. Mouse and context keys, not rebindable.',
    rows: CONTEXT_SHORTCUTS.map(({ keys, name, context }) => ({
      keys,
      name,
      badges: [{ text: context, tone: 'muted' }],
      notes: [],
    })),
  });

  return sections;
};

// APP TAB

const DEBUG_CAM_BADGES: { [key: string]: Badge } = {
  NOT_ENABLED_IN_DEBUG: { text: 'Not with debug camera', tone: 'warning' },
  ENABLED_ONLY_IN_DEBUG: { text: 'Debug camera only', tone: 'info' },
};

const getAppRow = (
  binding: Readonly<KeyBinding>,
  engineBindings: Readonly<DefaultDebugKeyBinding>[],
  isDebugOnly: boolean
): ShortcutRow => {
  const isDisabled = binding.enabled === false;
  const badges: Badge[] = [{ text: KEY_TYPE_LABELS[binding.type], tone: 'muted' }];
  if (isDebugOnly) badges.push({ text: 'Debug mode only', tone: 'info' });
  badges.push(
    binding.enabledInDebugCam && DEBUG_CAM_BADGES[binding.enabledInDebugCam]
      ? DEBUG_CAM_BADGES[binding.enabledInDebugCam]
      : { text: 'Works with debug camera', tone: 'muted' }
  );
  if (isDisabled) badges.push({ text: 'Disabled', tone: 'warning' });

  const notes: ShortcutRow['notes'] = [];
  if (!isDisabled) {
    for (const engineBinding of engineBindings) {
      // CONFIG.ts debugKeys are not registered in production test mode
      if (isDebugOnly && engineBinding.category === 'PROD_TEST') continue;
      if (!doKeyChordsCollide(engineBinding.chord, binding.chord)) continue;
      notes.push(
        engineBinding.category === 'PROD_TEST'
          ? {
              text: `Takes Aekasha's ${quoteBinding(engineBinding)} key in production test mode.`,
              tone: 'info',
            }
          : {
              text: `Also runs Aekasha's ${quoteBinding(engineBinding)} in debug mode.`,
              tone: 'warning',
            }
      );
    }
  }

  return {
    keys: getKeyChordLabel(binding.chord),
    name: binding.name || binding.id,
    id: binding.name ? binding.id : undefined,
    description: binding.description,
    badges,
    notes,
    isInactive: isDisabled,
  };
};

const getAppSections = (): ShortcutSection[] => {
  const sceneId = getCurrentSceneId();
  const engineKeyIds = getEngineKeyIds();
  const appDebugKeyIds = getAppDebugKeyIds(engineKeyIds);
  const allBindings = getKeyBindings();
  const appBindings = allBindings.filter((b) => !engineKeyIds.has(b.id));
  // The engine keys as they are bound now (CONFIG.ts chord overrides included), with prod test
  // keys as defined (they are not registered in debug mode)
  const { prodTest } = getDefaultDebugKeyBindings();
  const engineBindings: Readonly<DefaultDebugKeyBinding>[] = [
    ...getDefaultDebugKeyBindings().debug.flatMap((def) => {
      const registered = allBindings.find((b) => b.id === def.id);
      return registered && registered.enabled !== false
        ? [{ ...def, chord: registered.chord }]
        : [];
    }),
    ...prodTest,
  ];

  const sceneRows: ShortcutRow[] = [];
  const globalRows: ShortcutRow[] = [];
  const debugOnlyRows: ShortcutRow[] = [];
  let otherSceneCount = 0;
  for (const binding of appBindings) {
    if (!isInScene(binding, sceneId)) {
      otherSceneCount++;
      continue;
    }
    const isDebugOnly = appDebugKeyIds.has(binding.id);
    const row = getAppRow(binding, engineBindings, isDebugOnly);
    if (isDebugOnly) debugOnlyRows.push(row);
    else if (binding.sceneId) sceneRows.push(row);
    else globalRows.push(row);
  }

  const otherScenesText = otherSceneCount
    ? ` ${otherSceneCount} binding${otherSceneCount === 1 ? '' : 's'} of other scenes not listed.`
    : '';
  return [
    {
      title: `This scene${sceneId ? ` (${sceneId})` : ''}`,
      description: `Bound in app code with this scene's sceneId: every mode, this scene only.${otherScenesText}`,
      rows: sceneRows,
    },
    {
      title: 'All scenes',
      description: 'Bound in app code without a sceneId: every mode, every scene.',
      rows: globalRows,
    },
    {
      title: 'Debug keys (CONFIG.ts)',
      description: 'Added with CONFIG.ts debugKeys: debug mode only, every scene.',
      rows: debugOnlyRows,
    },
  ];
};

// RENDERING

const getKeysHtml = (keys: string) =>
  keys
    .split(' / ')
    .map((chord) =>
      chord
        .split(/\+(?=.)/)
        .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
        .join(`<span class="${styles.keyJoin}">+</span>`)
    )
    .join(`<span class="${styles.keyOr}">or</span>`);

const getRowHtml = (row: ShortcutRow) => {
  const badges = row.badges
    .map((b) => `<span class="${styles.badge} ${styles[b.tone]}">${escapeHtml(b.text)}</span>`)
    .join('');
  const notes = row.notes
    .map((n) => `<div class="${styles.note} ${styles[n.tone]}">${escapeHtml(n.text)}</div>`)
    .join('');
  return `<li class="${styles.row}${row.isInactive ? ` ${styles.inactive}` : ''}">
  <div class="${styles.keys}">${getKeysHtml(row.keys)}</div>
  <div class="${styles.info}">
    <div class="${styles.name}">${escapeHtml(row.name)}${row.id ? ` <span class="${styles.id}">${escapeHtml(row.id)}</span>` : ''}</div>
    ${row.description ? `<div class="${styles.description}">${escapeHtml(row.description)}</div>` : ''}
    ${notes}
    <div class="${styles.badges}">${badges}</div>
  </div>
</li>`;
};

const getSectionsHtml = (sections: ShortcutSection[]) =>
  sections
    .map(
      (section) => `<section class="${styles.section}">
  <h4>${escapeHtml(section.title)}</h4>
  ${section.description ? `<p class="${styles.sectionDescription}">${escapeHtml(section.description)}</p>` : ''}
  ${
    section.rows.length
      ? `<ul class="${styles.rows}">${section.rows.map(getRowHtml).join('')}</ul>`
      : `<p class="${styles.empty}">No key bindings.</p>`
  }
</section>`
    )
    .join('');

const createDialogContent = (initialTab: DebugKeyShortcutsTab): TCMP => {
  const root = CMP({ class: styles.dialogContent });
  const tabBar = root.add({ class: styles.tabBar, attr: { role: 'tablist' } });
  const panel = root.add({ class: styles.panel, attr: { role: 'tabpanel' } });
  const tabButtons = new Map<DebugKeyShortcutsTab, TCMP>();

  const showTab = (tab: DebugKeyShortcutsTab) => {
    for (const [id, button] of tabButtons) {
      button.updateClass(styles.tabButtonSelected, id === tab ? 'add' : 'remove');
      button.updateAttr({ 'aria-selected': String(id === tab) });
    }
    panel.removeChildren();
    panel.add({
      html: () =>
        `<div>${getSectionsHtml(tab === 'APP' ? getAppSections() : getAekashaSections())}</div>`,
    });
    panel.elem.scrollTop = 0;
  };

  for (const tab of TABS) {
    tabButtons.set(
      tab.id,
      tabBar.add({
        tag: 'button',
        text: tab.title,
        class: styles.tabButton,
        attr: { role: 'tab', type: 'button' },
        onClick: () => showTab(tab.id),
      })
    );
  }

  const footer = root.add({ class: styles.footer });
  footer.add({
    tag: 'button',
    text: 'Close',
    class: 'debuggerClearLSDialogButton',
    attr: { type: 'button' },
    onClick: () => closeDraggableWindow(DIALOG_ID),
  });

  showTab(initialTab);
  return root;
};

/**
 * Opens the Debug key shortcuts dialog on a tab (switching to it if the dialog is open): the
 * app's key bindings for the current scene, or the engine's debug and production test mode
 * keys with what the app changed about them.
 * @param tab ('APP' | 'AEKASHA') the tab to show, default 'AEKASHA'
 */
export const openDebugKeyShortcutsDialog = (tab: DebugKeyShortcutsTab = 'AEKASHA') => {
  openDialog({
    id: DIALOG_ID,
    title: 'Debug key shortcuts',
    size: { w: 640, h: 640 },
    isDebugWindow: true,
    backDropClickClosesWindow: true,
    closeOnEscape: true,
    // Built fresh on every open (the bindings change with the scene), and switched to the passed
    // tab when already open (a data change re-runs the content)
    removeOnClose: true,
    removeOnSceneChange: true,
    data: { tab },
    content: (data) => createDialogContent((data?.tab as DebugKeyShortcutsTab) || tab),
  });
};
