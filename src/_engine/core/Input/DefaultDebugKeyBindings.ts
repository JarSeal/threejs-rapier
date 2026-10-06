import { addDebugToast } from '../../debug/DebuggerGUI';
import {
  playInProdTestMode,
  stopProdTestMode,
  toggleDebugCameraWithToast,
  toggleOnScreenDropDown,
  updateOnScreenTools,
} from '../../debug/OnScreenTools';
import {
  openDebugKeyShortcutsDialog,
  toggleAxesGizmo,
  toggleEnvBall,
  toggleOnScreenToolsDisabled,
} from '../../debug/DebugToolsManager';
import { toggleProfilerWindow } from '../../debug/Profiler';
import { redoLastAction, undoLastAction } from '../../debug/UndoRedo';
import { lwarn } from '../../utils/Logger';
import { getConfig } from '../Config';
import { getReadOnlyLoopState, toggleAppPlay, toggleMainPlay } from '../MainLoop';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import {
  getActiveView,
  isRuntimeViewActive,
  isViewPlaying,
  toggleActiveViewDrawer,
  toggleViewPlay,
} from '../ViewManager';
import { createKeyBinding, markChordReserved, type KeyUpDownBinding } from './KeyboardInput';

/**
 * An `AppConfig.debugKeys` entry (CONFIG.ts). Reusing a default debug binding's id overrides
 * that default — only the given fields change (e.g. just `chord`), and `enabled: false` removes
 * it. Any other id registers an additional debug-only key binding, which needs `chord` and `fn`
 * (`type` defaults to 'KEY_UP').
 */
export type DebugKeyBindingConfig = Partial<Omit<KeyUpDownBinding, 'id'>> & { id: string };

/** Whether keyboard focus is in a text field, where a letter key is typing, not a shortcut. */
const isTypingInField = () =>
  document.activeElement?.matches(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  ) ?? false;

/** A loop shortcut's toast: the pause icon when the loop stopped, the play icon when it plays. */
const showLoopToast = (title: string, isPlaying: boolean) =>
  addDebugToast({ title, icon: getSvgIcon(isPlaying ? 'playFill' : 'pause') });

/** The pressed chord as readable text (eg. 'Shift+§'), or undefined for keys with no readable
 * name (dead keys etc.). Read from the event, so it's right for a rebound key and for layouts
 * where the key is shifted. */
const getPressedChordHint = (e: KeyboardEvent) => {
  if (e.key === 'Dead' || e.key === 'Unidentified') return undefined;
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const modifiers = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Meta',
  ].filter(Boolean);
  return [...modifiers, key].join('+');
};

/** The sub category a default debug key is listed under (the Debug key shortcuts dialog). */
export type DebugKeyCategory = 'DEBUGGER' | 'CAMERA' | 'LOOPS_AND_MODES' | 'VIEWPORT' | 'PROD_TEST';

/** An engine default key binding with its listing category. */
export type DefaultDebugKeyBinding = KeyUpDownBinding & { category: DebugKeyCategory };

const DEFAULT_DEBUG_KEY_BINDINGS: DefaultDebugKeyBinding[] = [
  {
    id: 'sc-toggle-debug-drawer',
    category: 'DEBUGGER',
    type: 'KEY_UP',
    chord: { key: 'h' },
    name: 'Toggle debug drawer (an editor view: its own drawer)',
    fn: () => {
      if (!isTypingInField()) toggleActiveViewDrawer();
    },
  },
  {
    id: 'sc-open-app-key-shortcuts',
    category: 'DEBUGGER',
    type: 'KEY_UP',
    chord: { key: 'u' },
    name: 'Open app key shortcuts (current scene)',
    fn: () => {
      if (!isTypingInField()) openDebugKeyShortcutsDialog('APP');
    },
  },
  {
    id: 'sc-open-engine-key-shortcuts',
    category: 'DEBUGGER',
    type: 'KEY_UP',
    chord: { key: 'i' },
    name: 'Open Aekasha key shortcuts',
    fn: () => {
      if (!isTypingInField()) openDebugKeyShortcutsDialog('AEKASHA');
    },
  },
  {
    id: 'sc-toggle-debug-camera',
    category: 'CAMERA',
    type: 'KEY_DOWN', // keydown, so preventDefault can stop the browser's own F1 (help) action
    chord: { key: 'F1' },
    name: 'Toggle debug camera (Runtime view)',
    fn: (e) => {
      e.preventDefault();
      // An editor view has its own camera
      if (e.repeat || isTypingInField() || !isRuntimeViewActive()) return;
      toggleDebugCameraWithToast();
    },
  },
  // The F keys are keydown, so preventDefault can stop the browser's own action (F5 reload,
  // F6 address bar, F7 caret browsing, F10 menu bar). With a modifier they don't match, so eg.
  // Ctrl+F5 and Shift+F5 still reload.
  {
    id: 'sc-play-prod-test',
    category: 'LOOPS_AND_MODES',
    type: 'KEY_DOWN',
    chord: { key: 'F5' },
    name: 'Play in production test mode (Runtime view)',
    fn: (e) => {
      e.preventDefault();
      // Like the on-screen button, which an editor view doesn't have
      if (e.repeat || isTypingInField() || !isRuntimeViewActive()) return;
      playInProdTestMode();
    },
  },
  {
    id: 'sc-toggle-main-loop',
    category: 'LOOPS_AND_MODES',
    type: 'KEY_DOWN',
    chord: { key: 'F6' },
    name: 'Toggle main loop',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleMainPlay();
      updateOnScreenTools('PLAY');
      const isPlaying = getReadOnlyLoopState().masterPlay;
      showLoopToast(isPlaying ? 'Main loop playing' : 'Main loop stopped', isPlaying);
    },
  },
  {
    id: 'sc-toggle-app-pause',
    category: 'LOOPS_AND_MODES',
    type: 'KEY_DOWN',
    chord: { key: 'F7' },
    name: 'Pause / play app loop (an editor view: the view)',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      // The on-screen pause button's key: it pauses the active view
      toggleViewPlay();
      updateOnScreenTools('PLAY');
      const isPlaying = isViewPlaying();
      const target = getActiveView() ? 'View' : 'App loop';
      showLoopToast(`${target} ${isPlaying ? 'playing' : 'paused'}`, isPlaying);
    },
  },
  {
    id: 'sc-toggle-profiler',
    category: 'DEBUGGER',
    type: 'KEY_DOWN',
    chord: { key: 'F8' },
    name: 'Open / close the profiler window',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleProfilerWindow();
    },
  },
  {
    id: 'sc-toggle-env-ball',
    category: 'VIEWPORT',
    type: 'KEY_DOWN',
    chord: { key: 'F9' },
    name: 'Toggle environment ball',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleEnvBall();
    },
  },
  {
    id: 'sc-toggle-axes-gizmo',
    category: 'VIEWPORT',
    type: 'KEY_DOWN',
    chord: { key: 'F10' },
    name: 'Toggle axes gizmo',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleAxesGizmo();
    },
  },
  {
    id: 'sc-open-camera-selector',
    category: 'VIEWPORT',
    type: 'KEY_DOWN',
    chord: { key: 'o' },
    name: 'Open / close the on-screen camera list',
    fn: (e) => {
      if (e.repeat || isTypingInField()) return;
      toggleOnScreenDropDown('CAMERA');
    },
  },
  {
    id: 'sc-open-scene-selector',
    category: 'VIEWPORT',
    type: 'KEY_DOWN',
    chord: { key: 'p' },
    name: 'Open / close the on-screen scene list',
    fn: (e) => {
      if (e.repeat || isTypingInField()) return;
      toggleOnScreenDropDown('SCENE');
    },
  },
  {
    id: 'sc-toggle-on-screen-tools',
    category: 'VIEWPORT',
    // keydown: where § is a shifted key (eg. German layout: Shift+3), releasing Shift first
    // would make the keyup's key '3'. ignoreModifiers, so the shifted § matches too. No § key on
    // US ANSI keyboards: rebind it with AppConfig.debugKeys.
    type: 'KEY_DOWN',
    chord: { key: '§' },
    ignoreModifiers: true,
    name: 'Toggle on-screen tools click-through',
    fn: (e) => {
      if (e.repeat || isTypingInField()) return;
      toggleOnScreenToolsDisabled(getPressedChordHint(e));
    },
  },
  // Undo/redo are keydown: macOS browsers fire no keyup for other keys while ⌘ is held, and
  // preventDefault stops the browser's own undo. In a text field they do nothing (no
  // preventDefault either), so the field's native undo still works.
  {
    id: 'sc-undo',
    category: 'DEBUGGER',
    type: 'KEY_DOWN',
    chord: [
      { key: 'z', ctrl: true },
      { key: 'z', meta: true },
    ],
    name: 'Undo debugger action',
    fn: (e) => {
      if (isTypingInField()) return;
      e.preventDefault();
      if (!e.repeat) undoLastAction();
    },
  },
  {
    id: 'sc-redo',
    category: 'DEBUGGER',
    type: 'KEY_DOWN',
    chord: [
      { key: 'z', ctrl: true, shift: true },
      { key: 'z', meta: true, shift: true },
    ],
    name: 'Redo debugger action',
    fn: (e) => {
      if (isTypingInField()) return;
      e.preventDefault();
      if (!e.repeat) redoLastAction();
    },
  },
];

/**
 * Registers the engine's default debug key bindings (merged with any CONFIG.ts `debugKeys`
 * overrides) plus the app's own `debugKeys`, and reserves the defaults' chords so app code
 * binding the same chord under another id gets a console warning. Debug environment only.
 */
export const registerDefaultDebugKeyBindings = (): void => {
  const { debugKeys = [] } = getConfig();
  const defaultIds = new Set(DEFAULT_DEBUG_KEY_BINDINGS.map((d) => d.id));

  for (const def of DEFAULT_DEBUG_KEY_BINDINGS) {
    const override = debugKeys.find((k) => k.id === def.id);
    if (override?.enabled === false) continue; // the app turned this default off
    // Debug keys also run in editor views (ViewManager.ts), which suspend the app's bindings
    const binding: KeyUpDownBinding = { ...def, ...override, isDebugKey: true };
    markChordReserved(binding.id, binding.chord); // reserve whatever chord actually ends up bound
    createKeyBinding(binding); // same id = sanctioned override, no warning
  }

  // App debugKeys that don't override a default register normally (and get the collision
  // warning if they reuse a reserved chord)
  for (const appKey of debugKeys) {
    if (defaultIds.has(appKey.id)) continue;
    const { chord, fn } = appKey;
    if (!chord || !fn) {
      lwarn(
        `Debug key "${appKey.id}" in CONFIG.ts debugKeys needs both "chord" and "fn" (only ` +
          `overrides of a default debug key id can leave them out). Skipped.`
      );
      continue;
    }
    createKeyBinding({ ...appKey, type: appKey.type ?? 'KEY_UP', chord, fn, isDebugKey: true });
  }
};

/** Production test mode keys: the on-screen play tools' stop, main loop, app loop pause and
 * profiler buttons. Each gives way to an app binding of the same key (yieldToOtherBindings). */
const DEFAULT_PROD_TEST_KEY_BINDINGS: DefaultDebugKeyBinding[] = [
  {
    id: 'sc-prod-test-stop',
    category: 'PROD_TEST',
    type: 'KEY_DOWN', // keydown, so preventDefault can stop the browser's reload
    chord: { key: 'F5' },
    name: 'Stop production test mode',
    yieldToOtherBindings: true,
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      stopProdTestMode();
    },
  },
  {
    id: 'sc-prod-test-toggle-main-loop',
    category: 'PROD_TEST',
    type: 'KEY_DOWN',
    chord: { key: 'F6' },
    name: 'Toggle main loop',
    yieldToOtherBindings: true,
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleMainPlay();
      updateOnScreenTools('PLAY');
    },
  },
  {
    id: 'sc-prod-test-toggle-app-pause',
    category: 'PROD_TEST',
    type: 'KEY_DOWN',
    chord: { key: 'F7' },
    name: 'Pause / play app loop',
    yieldToOtherBindings: true,
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleAppPlay();
      updateOnScreenTools('PLAY');
    },
  },
  {
    id: 'sc-prod-test-toggle-profiler',
    category: 'PROD_TEST',
    type: 'KEY_DOWN',
    chord: { key: 'F8' },
    name: 'Open / close the profiler window (when enabled in production test mode)',
    yieldToOtherBindings: true,
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleProfilerWindow(); // a no-op while the profiler isn't loaded
    },
  },
];

/**
 * Registers the production test mode keys (F5 stop, F6 main loop, F7 app loop pause, F8
 * profiler window, no toasts). An app binding of the same key takes over. Production test mode
 * only.
 */
export const registerDefaultProdTestKeyBindings = (): void => {
  for (const binding of DEFAULT_PROD_TEST_KEY_BINDINGS) createKeyBinding(binding);
};

/**
 * The engine's default key bindings as defined (before any CONFIG.ts `debugKeys` override), for
 * listing them: `debug` for the debug environment, `prodTest` for production test mode.
 */
export const getDefaultDebugKeyBindings = (): {
  debug: readonly Readonly<DefaultDebugKeyBinding>[];
  prodTest: readonly Readonly<DefaultDebugKeyBinding>[];
} => ({ debug: DEFAULT_DEBUG_KEY_BINDINGS, prodTest: DEFAULT_PROD_TEST_KEY_BINDINGS });
