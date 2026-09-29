import { toggleDrawer } from '../../debug/DebuggerGUI';
import { updateOnScreenTools } from '../../debug/OnScreenTools';
import { toggleAxesGizmo } from '../../debug/DebugToolsManager';
import { redoLastAction, undoLastAction } from '../../debug/UndoRedo';
import { lwarn } from '../../utils/Logger';
import { isDebugCameraActive, toggleDebugCamera } from '../CameraManager';
import { getConfig } from '../Config';
import { getECSWorld } from '../ECS';
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

const DEFAULT_DEBUG_KEY_BINDINGS: KeyUpDownBinding[] = [
  {
    id: 'sc-toggle-debug-drawer',
    type: 'KEY_UP',
    chord: { key: 'h' },
    name: 'Toggle debug drawer',
    fn: () => {
      if (!isTypingInField()) toggleDrawer();
    },
  },
  {
    id: 'sc-toggle-debug-camera',
    type: 'KEY_DOWN', // keydown, so preventDefault can stop the browser's own F1 (help) action
    chord: { key: 'F1' },
    name: 'Toggle debug camera',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleDebugCamera(getECSWorld(), !isDebugCameraActive());
      updateOnScreenTools('SWITCH');
    },
  },
  {
    id: 'sc-toggle-axes-gizmo',
    type: 'KEY_DOWN', // keydown, so preventDefault can stop the browser's own F8 action
    chord: { key: 'F8' },
    name: 'Toggle axes gizmo',
    fn: (e) => {
      e.preventDefault();
      if (e.repeat || isTypingInField()) return;
      toggleAxesGizmo();
    },
  },
  // Undo/redo are keydown: macOS browsers fire no keyup for other keys while ⌘ is held, and
  // preventDefault stops the browser's own undo. In a text field they do nothing (no
  // preventDefault either), so the field's native undo still works.
  {
    id: 'sc-undo',
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
    const binding: KeyUpDownBinding = { ...def, ...override };
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
    createKeyBinding({ ...appKey, type: appKey.type ?? 'KEY_UP', chord, fn });
  }
};
