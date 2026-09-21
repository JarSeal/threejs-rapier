Status: draft | not-implemented
Category: Input
Epic: https://trello.com/c/UyGHLLsX/218-input-system-refactoring

# Input System Refactoring — Plan

## Context

The current input system (`src/_engine/core/InputControls.ts`, 1090 lines) grew organically and is now genuinely confusing to work with: held-key ("loop action") input is pumped from two different, mutually-exclusive call sites depending on whether physics is enabled for the current scene — one inside the legacy `PhysicsRapier.ts` physics stepper's fixed-timestep sub-step loop, the other inside `MainLoop.ts`'s per-frame branch. This split exists because the one real character-movement consumer (`dynamicCharacter.ts`) reads the physics engine's fixed sub-step delta directly and applies velocities synchronously to a main-thread Rapier rigidbody — a coupling inherited from `PhysicsRapier.ts` being main-thread-only and mesh-coupled (CLAUDE.md already flags this system as legacy — "don't build new features on it"). On top of the confusing timing split, the module has a real case-sensitivity bug (`CONFIG.ts` has to register `['h', 'H']` to work around it), no modifier-key (Ctrl/Shift/Alt/Meta) support at all, and no mouse capability beyond raw up/down/move passthroughs — no click-vs-drag distinction, no hover, no wheel, no double-click, no raycasting/object-picking. There's no touch or gamepad support whatsoever.

This plan replaces `InputControls.ts` with a modular input system split across dedicated files under `src/_engine/core/Input/` — keyboard (with chord/modifier support and case-insensitivity), mouse (raycast-based click/hover/wheel/double-click), touch (tap/drag/pinch), and a gamepad research-note stub. It fixes the case bug, adds a first-class default-debug-key-bindings mechanism (`h`/`F1`) with an app-override + collision-warning path, migrates all real consumers, and deletes the old file outright — no legacy system left running in parallel.

**Decisions already made (do not re-litigate):**
1. Fully replace and delete `InputControls.ts` in this plan; migrate all 3 existing call sites (`Character.ts`/`dynamicCharacter.ts`, `scene01.ts`, `largeWorld.ts`).
2. The debug-default-key-overwrite warning fires whenever `IS_DEBUG_ENV` is true at registration time (not gated on the drawer's visual open/closed state).
3. Default debug keys for now: `h`/`H` → toggle drawer, `F1` → toggle debug camera. Defined in one engine-owned place, registered only in debug-mode init, overridable via `CONFIG.ts` by reusing the reserved `id` (no warning), with a console warning if app code registers a *different*-id binding that collides with a reserved chord.
4. Keyboard needs first-class Ctrl/Shift/Alt/Meta chord support plus a per-binding `caseInsensitive` option.
5. Mouse needs left/right click (via raycasting against real scene objects), hover, wheel, and double-click (left + right, where right needs manual timing since native `dblclick` only fires for the left button).
6. Touch needs basic support (tap, drag, pinch) in this same plan — not deferred.
7. Gamepad/controller is out of scope for implementation — only a short research note plus an unwired stub file with a `// TODO`.
8. Load-by-demand tree-shaking is achieved via file boundaries (one file per input domain, no barrel `index.ts`), not runtime dynamic `import()` code-splitting.
9. Every binding type gets optional `name`, `description`, and `icons?: string[]` (raw SVG strings, same convention as `UI/icons/SvgIcon.ts`).
10. The last implementation phase updates `docs/plans/p062_add-undo-and-redo-ui.md` to use this plan's mechanism instead of patching the old `KeyMapping` type.

---

## 1. Current state (grounded in the actual code)

- `InputControls.ts` holds 6 flat module-level mapping arrays (`keyUpMappings`/`keyDownMappings`/`keyLoopActionMappings`, each with a per-scene dict sibling) plus the same 6 for mouse (`InputControls.ts:51-64`).
- Case-sensitivity is inconsistent: the `keyup` handler lower-cases both sides for **global** mappings (`InputControls.ts:94,106`), but scene-specific keyup/keydown checks and the entire keydown handler for global mappings compare `KEY === mapping.key` with no normalization (`InputControls.ts:136,148,180,189,199,220,232,243`) — why `src/CONFIG.ts:11` has to register `key: ['h', 'H']`.
- No modifier fields exist on `KeyMapping` (`InputControls.ts:15-26`); nothing reads `e.ctrlKey`/`e.shiftKey`/etc. An array value for `key` means "any of these keys fire it," never "these keys as a chord."
- `KEY_LOOP_ACTION` is not a query API — there's no `isKeyDown()` anywhere. Held keys populate `mapping.keysPressed[]`/`keyDownIdsForLoop` on keydown; `updateInputControllerLoopActions(delta)` (`InputControls.ts:1064-1077`) must be called once per tick by *someone else*, re-invoking `mapping.fn(mapping.event, mapping.time)` for every still-held id.
- `updateInputControllerLoopActions` has exactly two call sites, mutually exclusive per scene via `physDisabled = !sceneId || !physicsState.enabled || !physicsState.scenes[sceneId].worldStepEnabled`:
  - `MainLoop.ts:159,216,274` (three loop variants), called with the raw rAF `delta`, only when `physDisabled`.
  - `PhysicsRapier.ts:1612`, inside `baseStepper`'s fixed-timestep sub-step loop, called with the *fixed* `physicsState.timestepRatio`, immediately before `world.step()`.
- The one real production consumer, `src/_engine/utils/character/dynamicCharacter.ts:658-694` (used by `src/app/scene_thirdPersonGym.ts`), needs its `fn` to fire in the same tick as `world.step()` because `controlFns.move`/`controlFns.rotate` (`dynamicCharacter.ts:223-260`) read `getPhysicsState().timestepRatio` directly and call `rigidBody.setLinvel(...)`/`rotateY(...)` synchronously on the main-thread rigidbody — a direct consequence of `PhysicsRapier.ts` being main-thread-only/mesh-coupled. The mapping `fn` itself receives no delta from the pump; the coupling is purely about *when* it fires.
- The new, engine-agnostic Physics API (`PhysicsAPI.ts` + `Physics/EngineRapier.ts` + `PhysicsManager.ts`, worker-thread RPC by default per `AppConfig.physics.workerTarget`) has no equivalent constraint: rigid bodies live in a Web Worker, and the main thread only sends RPC commands the worker applies before its own next internal fixed step. There is no architectural need to pump held-key actions from inside a physics-stepping loop for anything built on the new API — a plain per-frame poll of "is this chord currently held" is sufficient. This plan's `pollHeldKeyBindings` preserves the *existing* two call sites unchanged (so `dynamicCharacter.ts` keeps working identically), while also exposing a plain `isChordHeld()` query for future Physics-API-based movement code to poll from its own `ECSSystemStage.APP_PRE_PHYSICS` system instead.
- Mouse today is raw `MOUSE_UP`/`MOUSE_DOWN`/`MOUSE_MOVE` passthroughs (`InputControls.ts:262-348`) — no click/hover/wheel/dblclick/raycast concept. Grep confirms **zero** current consumers register a mouse control at all (`Character.ts`'s generic `controls` wiring supports the type, but every real call site — `dynamicCharacter.ts`, `scene01.ts`, `largeWorld.ts` — only registers `KEY_*` entries), so mouse migration carries no legacy-behavior burden.
- `getKeyInputControl`/`getMouseInputControl`/`enableKeyInputControl`/`enableMouseInputControl`/`DeleteControlsListeners` have zero external callers (grep confirms only `InputControls.ts` itself references them) — free to redesign.
- `src/_engine/core/Raycast.ts` only supports world-space rays (`castRayFromPoints`, `castRayFromAngle`, both via one module-level `THREE.Raycaster`, lines 16/60/107). No screen-space/NDC (`setFromCamera`) helper exists anywhere in the codebase.
- Debug shortcuts: `src/CONFIG.ts:7-15` declares `debugKeys: [{ id: 'sc-toggle-debug-drawer', key: ['h','H'], type: 'KEY_UP', fn: () => toggleDrawer() }]`, read once (guarded by `debugKeysFromConfigInitiated`) inside `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`'s `initDrawerState()` (lines 41-71), which calls `createKeyInputControl(...)` per entry — only runs once the debugger GUI module is lazy-loaded.
- `toggleDebugCamera(world, useDebugCam)` and `isDebugCameraActive()` already exist and work (`CameraManager.ts:461,464`), wired only to an on-screen HUD button click today (`_dbg__OnScreenTools.ts:131-141`) — no key binding exists yet.
- `IS_DEBUG_ENV`/`isDebugEnvironment()` (`Config.ts:255-261`) is a plain, always-bundled boolean check. `InputControls.ts` already imports `isDebugCameraActive` directly (not via the lazy `_dbg__` pattern) for its `enabledInDebugCam` gating — established precedent for core input code checking debug state inline without a dynamic import.
- `src/_engine/InitApp.ts:90-98` centralizes every `IS_DEBUG_ENV`-gated module registration (`registerStatsModule()`, `registerRaycastDebugGUI()`, `registerDebuggerGUI()`, etc., all awaited in sequence) before `appStartFn()` runs.
- `src/AppECSRegistry.ts:51` already defines `APP_PRE_PHYSICS = 'APP_PRE_PHYSICS', // Input handling, logic before physics` — the stage exists specifically for this purpose but has no engine-owned input system registered against it today.
- `Character.ts:55-58`'s `controls` param type is `(KeyInputParams & { id: string; type: KeyInputControlType }) | (MouseInputParams & { id: string; type: MouseInputControlType })`, wired to `createKeyInputControl`/`createMouseInputControl` at lines 127/137 and `deleteKeyInputControl`/`deleteMouseInputControl` in the delete path (~line 162+).
- `docs/plans/p062_add-undo-and-redo-ui.md`'s §2.3 already drafts adding `ctrlKey?`/`shiftKey?`/`altKey?`/`metaKey?` fields directly onto the *old* `KeyMapping` type for `Ctrl+Z`/`Ctrl+Shift+Z`, and flags an open text-input-focus-guard question. Status `draft | not-implemented` — nothing built yet, so no risk of clashing with in-flight work, only with the *design* on paper.

---

## 2. Design

### 2.1 Module layout (tree-shaking via file boundaries, no barrel)

```
src/_engine/core/Input/
  InputSharedTypes.ts        // type-only: Modifiers, BindingMeta, EnabledInDebugCam, TargetList
  KeyboardInput.ts           // createKeyBinding, deleteKeyBinding, isChordHeld, pollHeldKeyBindings, markChordReserved
  MouseInput.ts              // createMouseBinding, deleteMouseBinding (click/hover/wheel/dblclick)
  TouchInput.ts              // createTouchBinding, deleteTouchBinding (tap/drag/pinch)
  GamepadInput.ts            // stub only, wired into nothing
  DefaultDebugKeyBindings.ts // engine-owned h/F1 defaults + override/collision mechanism
```

No `index.ts` re-export barrel (per decision 8) — an app that never imports `TouchInput.ts`/`GamepadInput.ts` never bundles them. `InputSharedTypes.ts` is `type`-only, so importing it broadly doesn't defeat tree-shaking (erased at build). Each domain module keeps its own lazily-attached `window.addEventListener` guard (continuing `InputControls.ts`'s existing lazy-init pattern, just decentralized per file), and each keeps **one flat array** of bindings with an optional `sceneId?: string` filtered at dispatch time (`!binding.sceneId || binding.sceneId === getCurrentSceneId()`) — replacing the old file's 12 separate global/per-scene collections.

### 2.2 Keyboard API

```ts
// InputSharedTypes.ts
export type EnabledInDebugCam = 'ENABLED_IN_DEBUG' | 'ENABLED_ONLY_IN_DEBUG' | 'NOT_ENABLED_IN_DEBUG';

export type BindingMeta = {
  name?: string;
  description?: string;
  icons?: string[]; // raw SVG strings, same convention as UI/icons/SvgIcon.ts
};

// KeyboardInput.ts
export type KeyChord = {
  key: string; // KeyboardEvent.key value, e.g. 'h', 'F1', 'z', 'Escape'
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type KeyBindingType = 'KEY_UP' | 'KEY_DOWN' | 'KEY_HELD';

export type KeyBinding = BindingMeta & {
  id: string; // now required (was optional) — needed for the override/collision mechanism
  type: KeyBindingType;
  chord: KeyChord | KeyChord[]; // array = "any of these chords triggers this binding"
  caseInsensitive?: boolean; // default true
  enabled?: boolean; // default true
  sceneId?: string;
  enabledInDebugCam?: EnabledInDebugCam;
  fn: (e: KeyboardEvent, time: number) => void; // KEY_HELD bindings use a different signature, see below
};

export const createKeyBinding = (binding: KeyBinding): void => { /* ... */ };
export const deleteKeyBinding = (id: string): void => { /* ... */ };
export const setKeyBindingEnabled = (id: string, enabled: boolean): void => { /* ... */ };
export const setKeyInputsEnabled = (enabled: boolean): void => { /* ... */ };

/** Pure query: is this chord currently physically held? No registration needed. */
export const isChordHeld = (chord: KeyChord, caseInsensitive?: boolean): boolean => { /* ... */ };

/**
 * Drives KEY_HELD bindings once per tick. Preserves the exact two existing call sites
 * (MainLoop.ts's physDisabled branch, PhysicsRapier.ts's baseStepper sub-step loop) so
 * dynamicCharacter.ts's fixed-substep timing coupling is unchanged. New Physics-API-based
 * code should prefer isChordHeld() polled from its own APP_PRE_PHYSICS system instead.
 */
export const pollHeldKeyBindings = (delta: number): void => { /* ... */ };

/** Used only by DefaultDebugKeyBindings.ts to register a chord as a collision-check target. */
export const markChordReserved = (id: string, chord: KeyChord | KeyChord[]): void => { /* ... */ };
```

Matching (fixes the case bug from §1 by centralizing normalization in one place, and requires an *exact* modifier match):

```ts
const eventMatchesChord = (e: KeyboardEvent, chord: KeyChord, caseInsensitive: boolean): boolean => {
  const keyMatches = caseInsensitive
    ? e.key.toLowerCase() === chord.key.toLowerCase()
    : e.key === chord.key;
  return (
    keyMatches &&
    !!chord.ctrl === e.ctrlKey &&
    !!chord.shift === e.shiftKey &&
    !!chord.alt === e.altKey &&
    !!chord.meta === e.metaKey
  );
};
```

A plain `{ key: 'h' }` binding requires *no* modifiers held — this is a deliberate tightening versus today's bare-key-only matching (needed to make `Ctrl+Z` unambiguous from plain `Z`), but doesn't change `h`/`F1` behavior since those are pressed without modifiers. See §5.

`KEY_HELD` replaces `KEY_LOOP_ACTION`: keydown/keyup listeners maintain a live `Set<string>` of held raw keys + a modifiers snapshot (mirrors the old `keyDownIdsForLoop`, keyed on raw key state instead of mapping ids). `pollHeldKeyBindings(delta)` iterates registered `KEY_HELD` bindings, checks `isChordHeld` per binding, and calls `fn(delta)` for active ones. Blur/visibility-change cleanup is preserved via the same `addOnWindowBlurFn`/`addVisibilityChangeFn` hooks (`MainLoop.ts`) that `InputControls.ts:258-259` already uses.

### 2.3 Mouse API (raycast-based)

Add one screen-space helper to `Raycast.ts` (world-space rays stay as-is, reusing the existing module-level `THREE.Raycaster` and debug-helper hook):

```ts
// Raycast.ts addition
export const castRayFromScreenPosition = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  ndcX: number, // -1..1
  ndcY: number, // -1..1
  camera: THREE.Camera,
  opts?: Opts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  (ray as THREE.Raycaster).setFromCamera({ x: ndcX, y: ndcY } as THREE.Vector2, camera);
  const intersects = getRayCastIntersects({ ray: ray as THREE.Raycaster, objects, ...opts });
  useDebug(debugGUI)?._drawRayHelper({ /* from camera.position along the projected NDC ray */ });
  return intersects;
};
```

`MouseInput.ts` converts `MouseEvent.clientX/clientY` (relative to the renderer canvas rect) to NDC and calls this, defaulting `camera` to `getMainCamera()` (`CameraManager.ts:233`) unless a binding overrides it — relevant for debug-camera mode.

```ts
export type MouseButton = 'LEFT' | 'MIDDLE' | 'RIGHT';
type TargetList = THREE.Object3D[] | (() => THREE.Object3D[]);

type MouseBindingBase = BindingMeta & {
  id: string;
  enabled?: boolean;
  sceneId?: string;
  enabledInDebugCam?: EnabledInDebugCam;
};

export type MouseClickBinding = MouseBindingBase & {
  type: 'MOUSE_CLICK';
  button: MouseButton;
  targets: TargetList;
  camera?: THREE.Camera;
  recursive?: boolean;
  fn: (e: MouseEvent, intersection: THREE.Intersection) => void;
};

export type MouseHoverBinding = MouseBindingBase & {
  type: 'MOUSE_HOVER';
  targets: TargetList;
  camera?: THREE.Camera;
  onEnter?: (e: MouseEvent, intersection: THREE.Intersection) => void;
  onLeave?: (e: MouseEvent) => void;
};

export type MouseWheelBinding = MouseBindingBase & { type: 'MOUSE_WHEEL'; fn: (e: WheelEvent) => void };

export type MouseDblClickBinding = MouseBindingBase & {
  type: 'MOUSE_DBLCLICK';
  button: 'LEFT' | 'RIGHT'; // native dblclick only fires for LEFT; RIGHT is manually timed
  targets?: TargetList;
  maxIntervalMs?: number; // default 300, RIGHT only
  fn: (e: MouseEvent, intersection?: THREE.Intersection) => void;
};

export const createMouseBinding = (
  binding: MouseClickBinding | MouseHoverBinding | MouseWheelBinding | MouseDblClickBinding
): void => { /* ... */ };
export const deleteMouseBinding = (id: string): void => { /* ... */ };
```

- **Click**: on `mousedown` + a matching `mouseup` on the same button with movement under a small pixel threshold (distinguishes click from drag), raycast `targets` and call `fn` on hit.
- **Hover**: on `mousemove`, throttled to once per rendered frame (a dirty flag consumed from `MainLoop.ts`, not once per raw DOM event — mousemove fires far faster than rAF), raycast `targets`, diff the closest hit's `object.uuid` against the previous frame's per-binding hover state, fire `onEnter`/`onLeave` on change.
- **Wheel**: direct `wheel` event passthrough, no raycast.
- **Double-click**: `LEFT` uses the native `dblclick` DOM event (raycast at that point). `RIGHT` tracks `lastRightClickTime` on `mouseup` itself and synthesizes a double-click when two right-mouseups land within `maxIntervalMs`.

### 2.4 Touch API

```ts
// TouchInput.ts
type TouchBindingBase = BindingMeta & { id: string; enabled?: boolean; sceneId?: string };

export type TouchTapBinding = TouchBindingBase & {
  type: 'TOUCH_TAP';
  targets?: TargetList;
  camera?: THREE.Camera;
  maxDurationMs?: number; // default 250 — touchstart→touchend under this = tap, not drag
  maxMoveDistancePx?: number; // default 10
  fn: (e: TouchEvent, intersection?: THREE.Intersection) => void;
};

export type TouchDragBinding = TouchBindingBase & {
  type: 'TOUCH_DRAG';
  onStart?: (e: TouchEvent) => void;
  onMove?: (e: TouchEvent, delta: { x: number; y: number }) => void;
  onEnd?: (e: TouchEvent) => void;
};

export type TouchPinchBinding = TouchBindingBase & {
  type: 'TOUCH_PINCH';
  onPinch: (e: TouchEvent, distance: number, deltaDistance: number) => void;
};

export const createTouchBinding = (
  binding: TouchTapBinding | TouchDragBinding | TouchPinchBinding
): void => { /* ... */ };
export const deleteTouchBinding = (id: string): void => { /* ... */ };
```

No hover concept (touch has none, per decision 6). Pinch tracks the distance between the first two active entries in `TouchEvent.touches` across `touchmove` and reports the delta; single-finger `touchmove` beyond `maxMoveDistancePx` is drag, not tap. Listeners attach with `{ passive: false }` only where `preventDefault()` is actually needed to stop native pinch-zoom/scroll.

### 2.5 Gamepad — research note + stub only

The Gamepad API has no "button pressed" event — `navigator.getGamepads()` must be polled once per frame (a natural fit for an `APP_PRE_PHYSICS` ECS system once this is ever implemented) and diffed against the previous frame's button/axis snapshot to synthesize press/release-style callbacks. `gamepadconnected`/`gamepaddisconnected` *are* real events and should gate when polling starts/stops. Analog sticks need per-axis deadzone handling before mapping to movement. Chrome only reports a gamepad via `getGamepads()`/fires `gamepadconnected` after the user presses a button on it at least once (privacy restriction) — relevant for any future "press a button to start" prompt.

```ts
// GamepadInput.ts — stub only, not imported anywhere yet
// TODO: implement navigator.getGamepads() polling + connect/disconnect event wiring,
// per-frame button/axis diffing, and a deadzone-aware axis query API. See
// docs/plans/p050_input-system-refactoring.md §2.5 for the research note. No call
// site wires this in yet — a future plan should cover full implementation.
export const pollGamepads = (): void => {
  // TODO
};
```

### 2.6 Default debug key bindings + override/collision mechanism

```ts
// DefaultDebugKeyBindings.ts
import { createKeyBinding, markChordReserved, type KeyBinding } from './KeyboardInput';
import { toggleDrawer } from '../../debug/DebuggerGUI';
import { getECSWorld } from '../ECS';
import { toggleDebugCamera, isDebugCameraActive } from '../CameraManager';
import { getConfig } from '../Config';

const DEFAULT_DEBUG_KEY_BINDINGS: KeyBinding[] = [
  {
    id: 'sc-toggle-debug-drawer',
    type: 'KEY_UP',
    chord: { key: 'h' },
    caseInsensitive: true,
    name: 'Toggle debug drawer',
    fn: () => toggleDrawer(),
  },
  {
    id: 'sc-toggle-debug-camera',
    type: 'KEY_UP',
    chord: { key: 'F1' },
    name: 'Toggle debug camera',
    fn: () => toggleDebugCamera(getECSWorld(), !isDebugCameraActive()),
  },
];

export const registerDefaultDebugKeyBindings = (): void => {
  const { debugKeys = [] } = getConfig();
  const overridesById = new Map(debugKeys.filter((k) => k.id).map((k) => [k.id as string, k]));

  for (const def of DEFAULT_DEBUG_KEY_BINDINGS) {
    const override = overridesById.get(def.id);
    if (override?.enabled === false) continue; // app explicitly disabled this default
    markChordReserved(def.id, override?.chord ?? def.chord); // reserve whatever chord actually ends up bound
    createKeyBinding(override ? { ...def, ...override } : def); // same id = sanctioned override, no warning
  }

  // Any app debugKeys entries that aren't overriding a default id register normally,
  // and will trigger createKeyBinding's collision warning if they reuse a reserved chord.
  for (const appKey of debugKeys) {
    if (appKey.id && DEFAULT_DEBUG_KEY_BINDINGS.some((d) => d.id === appKey.id)) continue;
    createKeyBinding(appKey as KeyBinding);
  }
};
```

`KeyboardInput.ts`'s `createKeyBinding` checks the reserved-chord list whenever `isDebugEnvironment()` is true (per decision 2 — fires regardless of the drawer's open/closed state):

```ts
if (isDebugEnvironment()) {
  for (const reserved of reservedChords) {
    if (reserved.id !== binding.id && chordsCollide(reserved.chord, binding.chord)) {
      lwarn(
        `Debugger shortcut key for "${reserved.chordLabel}" ("${reserved.id}") has been ` +
          `overwritten with app code ("${binding.id}"). Please overwrite it from the CONFIG.ts file instead.`
      );
    }
  }
}
```

This dependency direction (`DefaultDebugKeyBindings.ts` → `KeyboardInput.ts`) matches the existing pattern where debug modules import core input, never the reverse — `KeyboardInput.ts` has zero awareness of "debug defaults" beyond the generic `reservedChords` list, keeping it fully tree-shakeable independent of the debug module. `registerDefaultDebugKeyBindings()` is called directly from `InitApp.ts`'s existing `if (IS_DEBUG_ENV) { ... }` block (`InitApp.ts:90-98`), alongside `registerDebuggerGUI()` — see §5 for why this isn't behind the `_dbg__` lazy-import pattern. `_dbg__DebuggerGUI.ts`'s current inline `debugKeys`-reading loop (`initDrawerState()`, lines 41-71) is deleted; `toggleDrawer` no longer needs to know about `debugKeys` at all.

### 2.7 Migration of the 3 existing consumers

- **`Character.ts`** (`controls` param, lines 55-58): retype from `(KeyInputParams & {...}) | (MouseInputParams & {...})` to `KeyBinding | MouseClickBinding | MouseHoverBinding | MouseWheelBinding | MouseDblClickBinding`; swap `createKeyInputControl`/`createMouseInputControl`/`deleteKeyInputControl`/`deleteMouseInputControl` (lines 127, 137, and the delete path) for the new `createKeyBinding`/`createMouseBinding`/`deleteKeyBinding`/`deleteMouseBinding`. The old `data: { physObj, mesh, charObject }` injection is dropped (see §5) — real `fn` bodies already close over these directly.
- **`dynamicCharacter.ts:658-694`**: the single `KEY_LOOP_ACTION` mapping (4 key arrays + manual `keysPressed.some(...)` checks) becomes 4 separate `KEY_HELD` bindings (`charRotateLeft`, `charRotateRight`, `charMoveForward`, `charMoveBackward`), each `chord: inputMappings.rotateLeft.map((key) => ({ key }))`, `fn` calling straight into `controlFns.rotate('LEFT')` etc. — no more manual `.some()`/`keysPressed` bookkeeping (now internal to `pollHeldKeyBindings`). `charStopMoveAndRotate`/`charJump`/`charRun`/`charCrouch` migrate 1:1 to `KEY_UP`/`KEY_DOWN` bindings; the existing `e.preventDefault()`/`e.repeat` checks inside each `fn` are untouched (consumer responsibility, not the input system's).
- **`scene01.ts:250`**: one `KEY_DOWN` console-log mapping — trivial rename to `createKeyBinding`.
- **`largeWorld.ts:440`**: one `KEY_UP` mapping with `key: ['c', 'C']` — becomes `chord: { key: 'c' }, caseInsensitive: true`, dropping the manual dual-case array (the direct ergonomics win from decision 4).

### 2.8 Deletion of `InputControls.ts`

Once `MainLoop.ts` (3 call sites) and `PhysicsRapier.ts` (1 call site, `baseStepper`) import `pollHeldKeyBindings` from `KeyboardInput.ts` instead of `updateInputControllerLoopActions` from `InputControls.ts`, and all consumers above are migrated, `src/_engine/core/InputControls.ts` is deleted outright — no re-export shim, per decision 1.

---

## 3. Files touched

- New: `src/_engine/core/Input/InputSharedTypes.ts`, `KeyboardInput.ts`, `MouseInput.ts`, `TouchInput.ts`, `GamepadInput.ts`, `DefaultDebugKeyBindings.ts`
- `src/_engine/core/Raycast.ts` — add `castRayFromScreenPosition`
- `src/_engine/core/MainLoop.ts` — swap `updateInputControllerLoopActions` for `pollHeldKeyBindings` (3 call sites)
- `src/_engine/core/PhysicsRapier.ts` — swap `updateInputControllerLoopActions` for `pollHeldKeyBindings` (1 call site)
- `src/_engine/core/Character.ts` — retype `controls`, swap create/delete calls
- `src/_engine/utils/character/dynamicCharacter.ts` — migrate all key mappings
- `src/app/scene01.ts`, `src/app/largeWorld.ts` — migrate their single mappings each
- `src/CONFIG.ts` — drop the `['h','H']` array now that `caseInsensitive` exists
- `src/_engine/core/Config.ts` — `AppConfig.debugKeys` type updated to `KeyBinding`-shaped entries
- `src/_engine/core/Debug/_dbg__DebuggerGUI.ts` — remove the inline `debugKeys` registration loop
- `src/_engine/InitApp.ts` — add `registerDefaultDebugKeyBindings()` call inside the existing `IS_DEBUG_ENV` block
- Deleted: `src/_engine/core/InputControls.ts`
- `docs/plans/p062_add-undo-and-redo-ui.md` — rewrite §2.3 + `Blocked by` header (final phase)

---

## 4. Phased rollout

1. **Add `KeyboardInput.ts` + `InputSharedTypes.ts` standalone, no consumers yet.** Implement chord matching, `createKeyBinding`/`deleteKeyBinding`/`isChordHeld`/`pollHeldKeyBindings`/`markChordReserved`. `InputControls.ts` untouched, fully additive. Manual check (via the `run-aekasha-js` skill): wire one throwaway `createKeyBinding` into a scratch scene, verify keydown/keyup/case-insensitivity/modifier matching in the running app, then remove it.
2. **Migrate `MainLoop.ts` and `PhysicsRapier.ts`'s held-key call sites to `pollHeldKeyBindings`.** `InputControls.ts`'s own `updateInputControllerLoopActions` becomes dead code (no callers) but stays in place for now. Manual check: run `scene_thirdPersonGym.ts`, confirm character movement/rotation timing feels identical — this is the highest-risk phase.
3. **Migrate `dynamicCharacter.ts`, `Character.ts`, `scene01.ts`, `largeWorld.ts` off `InputControls.ts` onto `KeyboardInput.ts`.** Manual check: load each of the three app scenes, exercise every migrated binding (move/rotate/jump/run/crouch in the gym scene, the console-log key in scene01, the camera-toggle key in largeWorld).
4. **Add `MouseInput.ts` + `castRayFromScreenPosition` in `Raycast.ts`.** No production consumer exists yet — verify manually with a scratch binding in a debug scene: click/hover/wheel/left-dblclick/right-dblclick all firing correctly against a real mesh, then remove the scratch wiring.
5. **Add `TouchInput.ts`.** Manual check via a touch-capable device/emulator or browser touch emulation: tap, drag, and two-finger pinch against a scratch binding.
6. **Add `GamepadInput.ts` stub only.** Confirm it compiles and isn't imported anywhere (so it can't affect the production bundle) — no functional check needed.
7. **Add `DefaultDebugKeyBindings.ts`, wire it into `InitApp.ts`, remove the old `debugKeys` loop from `_dbg__DebuggerGUI.ts`, update `Config.ts`'s `AppConfig.debugKeys` type, simplify `CONFIG.ts`'s `key: ['h','H']` to `caseInsensitive: true`.** Manual check: `h` still toggles the drawer, `F1` toggles the debug camera; temporarily register a throwaway app-level binding with a different id and chord `F1` and confirm the console warning fires with the expected message; confirm overriding `sc-toggle-debug-drawer` via `CONFIG.ts` with a different key does **not** warn.
8. **Delete `src/_engine/core/InputControls.ts`.** Grep for any remaining import from it to confirm zero stragglers, then delete. Manual check: full app boot + a pass through all three migrated scenes once more.
9. **Update `docs/plans/p062_add-undo-and-redo-ui.md`**: rewrite its §2.3 "Keyboard shortcuts" section to register `Ctrl+Z`/`Ctrl+Shift+Z` as two more entries via this plan's mechanism (either `DefaultDebugKeyBindings.ts`'s array, or plain app-level `createKeyBinding` calls with `chord.ctrl: true` — leave the exact choice as a flagged call for p062's implementer) instead of "add four optional fields to `KeyMapping`"; add this plan's filename to p062's `Blocked by` header.

---

## 5. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Default value of `caseInsensitive` | Proposing default `true`, matching decision 4's goal (no more `['h','H']` arrays) and today's `sc-toggle-debug-drawer` behavior. Could instead default `false` for stricter matching with opt-in insensitivity — flagging as a judgment call. |
| Exact-modifier-match is a behavior tightening | A plain `{ key: 'h' }` binding now requires *no* modifiers held (old system fired regardless of modifier state). Needed to make `Ctrl+Z` unambiguous from bare `Z`. No existing consumer relies on the old "fires even with an incidental modifier held" behavior (confirmed via the migration in §2.7), but worth calling out explicitly since it's a real semantic change, not just a rename. |
| Mouse/touch raycast target population: explicit list vs. whole scene graph | Chose explicit `targets` (array or getter fn) per binding, not "raycast the whole scene graph" — better performance (hover raycasts every active binding once per frame) and avoids accidental hits on debug helpers/UI meshes. Downside: callers maintain their own target lists. A future optimization could resolve `targets` through the existing spatial index (`_DONE_p050_spatial-index.md`) instead of a flat array, without changing this plan's public API. |
| Hover raycasting cost on large scenes | Each active `MOUSE_HOVER` binding raycasts its own `targets` once per rendered frame (throttled off raw `mousemove`). Cheap for small/curated target lists as designed; could get expensive if an app passes hundreds of objects to many simultaneous hover bindings. No built-in guard — worth a code comment in `MouseInput.ts` flagging the cost model. |
| Text-input-focus guard (inherited from p062) | Still open after this plan. Colliding with native browser/textarea undo while a debug-tools text field has focus isn't solved here — this plan only provides the chord mechanism. Proposing `KeyboardInput.ts` stays unopinionated (each binding's own `fn` decides whether to check `document.activeElement`), leaving the actual guard decision to p062's implementer — flagged there in the final phase. |
| `data` bag removal from `fn` signature | Old `KeyMapping.fn(e, time, data)` let `Character.ts` inject `{ physObj, mesh, charObject }` generically. New `KeyBinding.fn(e, time)` drops this — call sites close over their own state instead (already true of every real `fn` body today). Intentional API narrowing; no current consumer needs it preserved. |
| `registerDefaultDebugKeyBindings()` isn't behind the `_dbg__` lazy-import pattern | Unlike `registerDebuggerGUI()`/`registerRaycastDebugGUI()` (dynamic `import()` via `loadDebugModuleAsync`), it's proposed as a plain module called directly from `InitApp.ts`'s `IS_DEBUG_ENV` block, since it only touches already-always-bundled, cheap functions (`toggleDrawer`, `toggleDebugCamera`/`isDebugCameraActive`, `createKeyBinding`). Same tradeoff `InputControls.ts` already accepts for `isDebugCameraActive` today. Flagging in case stricter prod-bundle hygiene is wanted instead. |
| Right-button double-click timing threshold | Proposed default `maxIntervalMs: 300` (common OS double-click threshold). Inherently a heuristic (no `e.detail`-based click-count equivalent exists for the right button, unlike native `dblclick`). |
| `icons?: string[]` on every binding — no consumer yet | Required by decision 9 but not wired into any UI in this plan (no keybinding-list/settings screen exists). Stored as metadata for a future UI to read. Confirm this metadata-only scope is intended. |

---

## Verification

No test runner exists in this repo — verification is manual, via the `run-aekasha-js` skill driving the dev server, following each phase's manual-check step in §4. The two highest-value end-to-end checks: (1) after Phase 3, `scene_thirdPersonGym.ts` character movement/rotation/jump/run/crouch must feel identical to pre-refactor behavior; (2) after Phase 7, `h`/`F1` must still work in the debugger, and the override/collision-warning behavior must be confirmed both ways (sanctioned override via `CONFIG.ts` id reuse = silent; accidental app-code collision on a different id = console warning) before deleting `InputControls.ts` in Phase 8.
