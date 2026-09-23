import { isDebugCameraActive } from '../CameraManager';
import { isDebugEnvironment } from '../Config';
import { addOnWindowBlurFn, addVisibilityChangeFn } from '../MainLoop';
import { getCurrentSceneId } from '../Scene';
import { lwarn } from '../../utils/Logger';
import { areAllInputsEnabled } from './InputState';
import type { BindingMeta, EnabledInDebugCam, Modifiers } from './InputSharedTypes';

export type KeyChord = Modifiers & {
  /** KeyboardEvent.key value, e.g. 'h', 'F1', 'z', 'Escape'. */
  key: string;
};

export type KeyBindingType = 'KEY_UP' | 'KEY_DOWN' | 'KEY_HELD';

type KeyBindingBase = BindingMeta & {
  id: string;
  /** Array = "any of these chords triggers this binding". */
  chord: KeyChord | KeyChord[];
  caseInsensitive?: boolean; // default true
  /** Match on the key alone, whatever modifiers are (or aren't) held — the chord's own modifier
   * fields are ignored too. For continuous controls like movement that must keep working while
   * an unrelated modifier is pressed (e.g. a Shift run toggle). Default false (exact match). */
  ignoreModifiers?: boolean;
  enabled?: boolean; // default true
  sceneId?: string;
  enabledInDebugCam?: EnabledInDebugCam;
};

export type KeyUpDownBinding = KeyBindingBase & {
  type: 'KEY_UP' | 'KEY_DOWN';
  fn: (e: KeyboardEvent, time: number) => void;
};

/** KEY_HELD bindings are polled once per tick (see pollHeldKeyBindings), not event-driven,
 * so their fn receives the poll's delta instead of a KeyboardEvent. */
export type KeyHeldBinding = KeyBindingBase & {
  type: 'KEY_HELD';
  fn: (delta: number) => void;
};

export type KeyBinding = KeyUpDownBinding | KeyHeldBinding;

type ReservedChord = { id: string; chord: KeyChord | KeyChord[]; chordLabel: string };

let bindings: KeyBinding[] = [];
let reservedChords: ReservedChord[] = [];

const heldRawKeys = new Set<string>();
let heldModifiers: Modifiers = {};

let keyInputsEnabled = true;
export const setKeyInputsEnabled = (enabled: boolean): void => {
  keyInputsEnabled = enabled;
};

let keydownListener: ((e: KeyboardEvent) => void) | null = null;
let keyupListener: ((e: KeyboardEvent) => void) | null = null;

const getChordArray = (chord: KeyChord | KeyChord[]): KeyChord[] =>
  Array.isArray(chord) ? chord : [chord];

const chordLabel = (chord: KeyChord | KeyChord[]): string =>
  getChordArray(chord)
    .map((c) =>
      [c.ctrl && 'Ctrl', c.shift && 'Shift', c.alt && 'Alt', c.meta && 'Meta', c.key]
        .filter(Boolean)
        .join('+')
    )
    .join(' / ');

const isInputInDebugCamInvalid = (enabledInDebugCam?: EnabledInDebugCam) =>
  isDebugEnvironment() &&
  ((enabledInDebugCam === 'NOT_ENABLED_IN_DEBUG' && isDebugCameraActive()) ||
    (enabledInDebugCam === 'ENABLED_ONLY_IN_DEBUG' && !isDebugCameraActive()));

const isBindingDisabled = (binding: KeyBinding) =>
  binding.enabled === false || isInputInDebugCamInvalid(binding.enabledInDebugCam);

const isSceneMatch = (sceneId?: string) => !sceneId || sceneId === getCurrentSceneId();

/** The modifier flag a modifier key sets on its own events ('Shift' -> shift, ...), if any. */
const MODIFIER_OF_KEY: { [key: string]: keyof Modifiers } = {
  shift: 'shift',
  control: 'ctrl',
  alt: 'alt',
  meta: 'meta',
};

/** Exact modifier match, except that a chord whose key is itself a modifier (e.g.
 * `{ key: 'Shift' }`) doesn't require its own flag to be off: pressing Shift always reports
 * shiftKey, so such a chord could never match otherwise. */
const modifiersMatch = (chord: KeyChord, held: Modifiers): boolean => {
  const own = MODIFIER_OF_KEY[chord.key.toLowerCase()];
  return (
    (own === 'ctrl' || !!chord.ctrl === !!held.ctrl) &&
    (own === 'shift' || !!chord.shift === !!held.shift) &&
    (own === 'alt' || !!chord.alt === !!held.alt) &&
    (own === 'meta' || !!chord.meta === !!held.meta)
  );
};

/** Chord match against a live DOM event: key (case rule per binding) plus an exact modifier
 * match (a plain `{ key: 'h' }` requires no modifiers held) unless ignoreModifiers is set. */
const eventMatchesChord = (
  e: KeyboardEvent,
  chord: KeyChord,
  caseInsensitive: boolean,
  ignoreModifiers?: boolean
): boolean => {
  const keyMatches = caseInsensitive
    ? e.key.toLowerCase() === chord.key.toLowerCase()
    : e.key === chord.key;
  return (
    keyMatches &&
    (ignoreModifiers ||
      modifiersMatch(chord, {
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      }))
  );
};

/** Same exact-match rule as eventMatchesChord, but against the live held-key/modifier
 * snapshot instead of a single DOM event (used by isChordHeld / pollHeldKeyBindings). */
const chordIsHeld = (
  chord: KeyChord,
  caseInsensitive: boolean,
  ignoreModifiers?: boolean
): boolean => {
  const chordKeyLower = chord.key.toLowerCase();
  let keyHeld = false;
  for (const k of heldRawKeys) {
    if (caseInsensitive ? k.toLowerCase() === chordKeyLower : k === chord.key) {
      keyHeld = true;
      break;
    }
  }
  return keyHeld && (!!ignoreModifiers || modifiersMatch(chord, heldModifiers));
};

const chordsCollide = (a: KeyChord | KeyChord[], b: KeyChord | KeyChord[]): boolean => {
  const arrA = getChordArray(a);
  const arrB = getChordArray(b);
  for (let i = 0; i < arrA.length; i++) {
    for (let j = 0; j < arrB.length; j++) {
      const ca = arrA[i];
      const cb = arrB[j];
      if (
        ca.key.toLowerCase() === cb.key.toLowerCase() &&
        !!ca.ctrl === !!cb.ctrl &&
        !!ca.shift === !!cb.shift &&
        !!ca.alt === !!cb.alt &&
        !!ca.meta === !!cb.meta
      ) {
        return true;
      }
    }
  }
  return false;
};

const updateHeldModifiers = (e: KeyboardEvent) => {
  heldModifiers = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
};

const clearHeldKeys = () => {
  heldRawKeys.clear();
  heldModifiers = {};
};

const initKeyListeners = () => {
  if (keydownListener) return;

  keydownListener = (e: KeyboardEvent) => {
    if (!e.repeat) heldRawKeys.add(e.key);
    updateHeldModifiers(e);
    if (!keyInputsEnabled || !areAllInputsEnabled()) return;
    const timeNow = performance.now();
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (binding.type !== 'KEY_DOWN') continue;
      if (isBindingDisabled(binding) || !isSceneMatch(binding.sceneId)) continue;
      const caseInsensitive = binding.caseInsensitive ?? true;
      const matched = getChordArray(binding.chord).some((c) =>
        eventMatchesChord(e, c, caseInsensitive, binding.ignoreModifiers)
      );
      if (matched) binding.fn(e, timeNow);
    }
  };

  keyupListener = (e: KeyboardEvent) => {
    // A letter's e.key follows the Shift state at the time of each event, so one pressed with
    // Shift down ('W') and released after Shift ('w') must be cleared in either case.
    heldRawKeys.delete(e.key);
    heldRawKeys.delete(e.key.toLowerCase());
    heldRawKeys.delete(e.key.toUpperCase());
    updateHeldModifiers(e);
    if (!keyInputsEnabled || !areAllInputsEnabled()) return;
    const timeNow = performance.now();
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (binding.type !== 'KEY_UP') continue;
      if (isBindingDisabled(binding) || !isSceneMatch(binding.sceneId)) continue;
      const caseInsensitive = binding.caseInsensitive ?? true;
      const matched = getChordArray(binding.chord).some((c) =>
        eventMatchesChord(e, c, caseInsensitive, binding.ignoreModifiers)
      );
      if (matched) binding.fn(e, timeNow);
    }
  };

  window.addEventListener('keydown', keydownListener);
  window.addEventListener('keyup', keyupListener);
  addVisibilityChangeFn('inputKeyboardHeldKeysClear', () => clearHeldKeys());
  addOnWindowBlurFn('inputKeyboardHeldKeysClear', () => clearHeldKeys());
};

export const createKeyBinding = (binding: KeyBinding): void => {
  if (isDebugEnvironment()) {
    for (let i = 0; i < reservedChords.length; i++) {
      const reserved = reservedChords[i];
      if (reserved.id !== binding.id && chordsCollide(reserved.chord, binding.chord)) {
        lwarn(
          `Debugger shortcut key for "${reserved.chordLabel}" ("${reserved.id}") has been ` +
            `overwritten with app code ("${binding.id}"). Please overwrite it from the CONFIG.ts ` +
            `file instead (a debugKeys entry with the id "${reserved.id}").`
        );
      }
    }
  }

  bindings = bindings.filter((b) => b.id !== binding.id);
  bindings.push(binding);
  initKeyListeners();
};

export const deleteKeyBinding = (id: string): void => {
  bindings = bindings.filter((b) => b.id !== id);
};

export const setKeyBindingEnabled = (id: string, enabled: boolean): void => {
  const binding = bindings.find((b) => b.id === id);
  if (!binding) {
    lwarn(`Could not find key binding with id "${id}" in setKeyBindingEnabled.`);
    return;
  }
  binding.enabled = enabled;
};

/** Pure query: is this chord currently physically held? No registration needed. */
export const isChordHeld = (chord: KeyChord, caseInsensitive: boolean = true): boolean => {
  initKeyListeners();
  return chordIsHeld(chord, caseInsensitive);
};

/**
 * Drives KEY_HELD bindings once per tick. Preserves the exact two existing call sites
 * (MainLoop.ts's physDisabled branch, PhysicsRapier.ts's baseStepper sub-step loop) so
 * dynamicCharacter.ts's fixed-substep timing coupling is unchanged. New Physics-API-based
 * code should prefer isChordHeld() polled from its own APP_PRE_PHYSICS system instead.
 */
export const pollHeldKeyBindings = (delta: number): void => {
  initKeyListeners();
  if (!keyInputsEnabled || !areAllInputsEnabled()) return;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type !== 'KEY_HELD') continue;
    if (isBindingDisabled(binding) || !isSceneMatch(binding.sceneId)) continue;
    const caseInsensitive = binding.caseInsensitive ?? true;
    const matched = getChordArray(binding.chord).some((c) =>
      chordIsHeld(c, caseInsensitive, binding.ignoreModifiers)
    );
    if (matched) binding.fn(delta);
  }
};

/** Used by DefaultDebugKeyBindings.ts to register a chord as a collision-check target. */
export const markChordReserved = (id: string, chord: KeyChord | KeyChord[]): void => {
  reservedChords = reservedChords.filter((r) => r.id !== id);
  reservedChords.push({ id, chord, chordLabel: chordLabel(chord) });
};
