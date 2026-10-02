Status: draft | Phases 1-2 implemented
Category: Character, Debugger

# Character Live Config Editing — Plan

Makes the **Properties** (`_`-prefixed) values in the Character state window (p067) editable at runtime. Movement can then be tuned (speed, jump, slopes, tumbling thresholds) without code edits and reloads. Edits are recorded for undo, can be reset to the character's creation-time values, and can be copied out as a `charData` override. The values baked into the colliders stay read-only until the last, optional phase rebuilds the body in place.

p066, p067 and p068 have landed since the stub was written. This version is checked against the code they left. The §3 decisions answer the stub's open questions; they are proposals, so confirm or change them before Phase 1.

---

## 1. Goal

- Each Properties row in the state window gets an inline editor: a number input for numbers, a click on the icon for the one boolean (`_turnToMoveDirection`). A finished edit writes straight to `CharacterObject.data[key]`, the live object the controller reads every sub-step.
- Rows whose value differs from the character's creation-time value are marked and get a reset button. The Properties group gets "Reset all" and "Copy changes" (a `charData` snippet of only the changed keys).
- Every edit and reset is one undo step (slider-like changes coalesce).
- Tuned values survive a reload (Vite reloads the page on most saves): they are saved per scene and character id, deviation-only, and applied when the character is created (debug env only).
- Values baked into the colliders are shown locked, with a tooltip saying why, until Phase 4.

## 2. Current state (grounded in the code)

### 2.1 Where the values come from

- `createDynamicCharacter` (`src/_engine/core/Character/DynamicCharacter.ts:482`) builds the live data as `{ ...getDefaultCharacterData(), ...charData }` (`:496`). Without a `charData._turnToMoveDirection`, an input scheme sets it (`:497-499`, `SCHEME_TURNS_TO_MOVE_DIRECTION`).
- The same object goes to `createCharacter` as `data` (`:1024`, `src/_engine/core/Character.ts:110`). It becomes `CharacterObject.data` (`CharacterTypes.ts:214`), which the window reads.
- `DEFAULT_CHARACTER_DATA` (`DynamicCharacter.ts:250`) is not exported, and neither the `charData` override nor the merged result is kept anywhere. So nothing knows a character's creation-time values. Engine defaults alone are not enough for "reset": the gym passes `_height`/`_radius` (`src/app/scene_thirdPersonGym.ts:141-144`), and the scheme decides `_turnToMoveDirection`.
- Every `CharacterData` field has a one-line JSDoc (`DynamicCharacter.ts:43-201`). JSDoc doesn't exist at runtime, so tooltips need a runtime table (§4.3).

### 2.2 The 36 Properties keys

Each key's reads, checked in the code:

| Kind                                                    | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                              | Takes effect                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read live** (29)                                      | `_maxVelocity`, `_runningMultiplier`, `_crouchingMultiplier`, `_inTheAirDiminisher`, `_accumulateVeloPerInterval`, `_slopeSlideSpeed`, `_moveYOffset`, `_rotateSpeed`, `_jumpAmount`, `_jumpCooldown`, `_keepMovingAfterJumpThreshold`, `_isFallingThreshold`, `_fallStateDelay`, `_minSlidingVelocity`, `_wallMicroPush`, `_wallNormalMaxY`, `_wallCastDistance`, `_tumbling*` (7), `_gettingUp*` (4); `_turnToMoveDirection` (boolean, `:1123`) | The next sub-step. Exceptions: `_tumblingAngularDamping` is set on the body when tumbling starts (`startCharacterTumbling`, `:1460`), so it applies from the next tumble. `_wallCastDistance` is read when a cast fires (`:573`) and `_wallNormalMaxY` when one resolves (`:605`), so they apply from the next wall cast.                         |
| **Derived at creation** (1)                             | `_maxWalkableAngle` → `__maxWalkableAngleCos` (`:503`)                                                                                                                                                                                                                                                                                                                                                                                            | Never, unless the derived value is recomputed (§4.2). The tick reads only `__maxWalkableAngleCos` (`:669`).                                                                                                                                                                                                                                       |
| **Baked into the colliders and probes at creation** (6) | `_height`, `_radius`, `_crouchHeight`, `_skinThickness`, `_groundDetectorOffset`, `_groundDetectorRadius`                                                                                                                                                                                                                                                                                                                                         | Never, until the body is rebuilt (Phase 4). Only the body plan reads them (`HUMANOID_CAPSULE.getDimensions`/`getColliders`, `CharacterBodyPlans.ts:56`/`:75`). The controller keeps the result in a `const dims` (`DynamicCharacter.ts:500`), sizes the colliders from it once (`:989`) and sizes both casts from it every tick (`:563`, `:625`). |

The visual is not in this list: the controller never reads it (`DynamicCharacterOpts.visual`). The app sizes it from the same values (eg. the gym's `createCharacterVisual({ height, radius })`), so a rebuilt body would not resize it.

### 2.3 What p068 changed

- The body plan and dimensions are now on the controller: `CharacterController.probes` (`CharacterTypes.ts:192`) holds `body`, `dims` and `colliderRoles` (`CharacterProbes`, `:100`), created once at `DynamicCharacter.ts:1059`. The stub's "expose them on the controller first" step is done.
- The gizmos read `controller?.probes` every frame (`_dbg__CharacterGizmos.ts:706`), but size the floor sensor ball once per `probes` object (`sensorBalls`, a `WeakMap` keyed by it, `:346-377`). A rebuilt body must publish a **new** `probes` object, or the gizmos keep the old ball.

### 2.4 The state window

- `src/_engine/core/Debug/Character/_dbg__CharacterStateWindow.ts` stays prefix-driven (p067 §3.1): it knows nothing about `DynamicCharacter`.
- Each row is built once (`createRow`, `:269`) with a label, value text nodes and its last raw values. The looper (a late main looper, also while paused) re-reads `data[key]` and writes only what changed (`updateRow`, `:347`). An open Properties group is diffed every update. Every `_` row flashes on a change (`rowFlashes`, `:186`).
- The row's `title` shows the key and raw value, set on `mouseenter` (`:312`).

### 2.5 Undo and persistence precedents

- Undo engine (`core/Debug/_dbg__UndoRedo.ts`): `_registerUndoRedoActionHandler(type, { undo, redo }, scope)` (`:147`), `_recordUndoRedoAction` (`:155`) and `_recordOrCoalesceUndoRedoAction` (`:183`, keeps the first `prev` and the latest `next` within 800 ms). History is per scene and persisted in LS, so an entry can be undone after a reload. A handler that throws keeps the pointer where it was. The sky box records `skybox.param` (`Debug/SkyBox/_dbg__SkyBoxShared.ts:583-599`).
- Debug overrides read by runtime code: `resolveSkyBoxDef` (`core/SkyBox/SkyBox.ts:215`) reads `AEK_debugSkyBox` with `lsGetItem`, behind `isDebugEnvironment()`, so production never reads LS. The cameras keep theirs in `AEK_debugCams` (`CameraManager.ts:409`).
- The Characters tab's clear-LS button is permanently disabled because no character data is persisted (`_dbg__Character.ts:271-275`). This plan gives it data.

## 3. Decisions (proposed)

| Question (from the stub)                 | Proposal                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persist across reloads, or session-only? | Persist (Phase 3). A save in `src/app/**` reloads the page, so session-only tuning would be lost on the next code edit. Saved per scene and character id, only values that differ from the creation-time ones, and applied at creation (debug env only). The window marks saved values, and the Characters tab's clear-LS button clears them. Copy-out stays the way to make tuning permanent. |
| Collider-baked values                    | Locked (read-only) in Phases 1-3, with a tooltip. Phase 4 adds an in-place body rebuild. It is optional and can be dropped without affecting the rest. Recreating the character is not an option: `deleteCharacter` deletes its entity, which is the visual's.                                                                                                                                 |
| `State` group editing                    | Out of scope. The controller writes those values every sub-step, so an edit would be overwritten or would fight the physics body. The edit window's position/rotation controls and `setControlMode` cover the useful cases.                                                                                                                                                                    |

Other decisions:

- **Reset target = the creation-time value**, not the engine default: it is what the scene's code asked for (§2.1).
- **Copy changes copies the diff against the creation-time values**, so the snippet holds only what to add to the scene's `charData`.
- **Writes happen on the main thread, between frames.** `data` lives on the main thread in both worker targets, and the tick reads it there, so an edit applies from the next sub-step. Characters are not deterministic yet (CLAUDE.md, Physics), so an edit's frame timing doesn't break anything that works now.
- **The window stays generic.** It asks the controller which keys are baked and tells it when a key changed (§4.2). It doesn't hard-code `DynamicCharacter`'s rules. The per-key input hints (§4.3) are optional, with a generic fallback.

## 4. Design

### 4.1 Creation-time values (engine)

`CharacterObject` gets `initialConfig: Readonly<Record<string, number | boolean | string>>`: a copy of the `_` keys of `data` with primitive values, taken in `createCharacter` (`Character.ts:110`) before anything else touches them. That is after `createDynamicCharacter`'s merge and scheme default, so it is exactly what the scene's code produced. It works for any controller that follows the prefix convention. Debug overrides (§4.6) are applied after the snapshot, so the snapshot never contains them.

### 4.2 The controller's config hook (engine)

`CharacterController` (`CharacterTypes.ts:186`) gets an optional `config`:

```ts
export type CharacterConfigHooks = {
  /** `_` keys only read at creation (eg. sized into the colliders): editing them changes nothing
   * until `rebuildBody` runs. */
  bakedKeys: ReadonlySet<string>;
  /** Called after a `_` key of `data` was written outside the controller: recomputes what is
   * derived from it (eg. `__maxWalkableAngleCos`). */
  onChange: (key: string) => void;
  /** Added in Phase 4: recomputes the dimensions and replaces the colliders from the current data. */
  rebuildBody?: () => Promise<void>;
};
```

`createDynamicCharacter` fills it. `bakedKeys` lists the six §2.2 keys (the body plan reads them, so a body plan could later declare its own). `onChange('_maxWalkableAngle')` recomputes `__maxWalkableAngleCos`, and every other key is a no-op. A controller without `config` gets the generic behaviour: every `_` key is editable and nothing is recomputed.

### 4.3 Editable rows (window)

- **Numbers:** the value cell becomes an `<input type="number">` styled like the current cell (tabular numbers, right-aligned, no spinner). The looper leaves a focused input alone and refreshes it on blur, so an edit is never overwritten mid-typing. `change` (Enter or blur) commits; Escape restores the value and blurs; ArrowUp/ArrowDown step by the key's `step` (Shift ×10). A non-finite value is rejected, and the input shows the current value again.
- **Booleans:** the icon becomes a button that toggles the value.
- **Baked keys:** no editor until Phase 4. A lock icon (a new `lock` SVG in `core/UI/icons/svg/`; none exists) is shown, with the tooltip "Sized into the colliders at creation. Editing needs a body rebuild (not available yet)."
- **Changed marker:** a row whose value differs from `initialConfig[key]` gets an accent bar and a small reset button (the existing `arrowCounterClockwise` icon). A row with a saved override (Phase 3) also shows a small "saved" dot. The markers are re-checked only when the row's raw value changes (the diff already finds that), so they cost nothing per frame.
- **Input hints:** an optional `CONFIG_KEY_HINTS: Record<string, { step: number; min?: number; max?: number; unit?: 'ms' | 'rad' | 'm' | 'm/s'; note?: string }>` in the window module, for the dynamic character's keys. It gives the step, the clamping and a tooltip line taken from the field's JSDoc. An unknown `_` key gets `step 0.01` and no clamping. `_maxWalkableAngle` keeps its `rad (deg)` display, and its input edits **degrees** (a mental conversion nobody wants to do), stored as radians.
- **The Properties header** gets "Reset all" (enabled when a row differs) and "Copy changes". The Copy JSON button in the window header stays as it is.

### 4.4 The write path

One function in the window module, used by the inputs, the resets and the undo handler:

```ts
const writeConfig = (character: CharacterObject, key: string, value: number | boolean) => {
  character.data[key] = value;
  character.controller?.config?.onChange(key);
  // Phase 3: save or clear the override
};
```

A user edit then records the undo step (§4.5), and the row is refreshed at once (forced, without a flash, since the user caused the change).

### 4.5 Undo

- Action type `character.config`, scope `perScene`, payload `{ charId, changes: { key, prev, next }[] }`. One row edit is one change. "Reset all" is one entry with every reset key. A boolean toggle is not coalesced. A number edit is coalesced on `${charId}:${key}`, so ArrowUp held down is one step.
- The handler writes through `writeConfig`. A character that no longer exists (deleted, or a scene without it) is a quiet no-op, not a throw, so the pointer still moves. With Phase 3, an undo after a reload acts on the re-created character and its saved override, which is consistent.
- Label: `Character <name | id>: <key> <prev> → <next>`, numbers to 3 decimals.

### 4.6 Persistence (Phase 3)

- LS key `AEK_debugCharConfig`: `{ [sceneId]: { [charId]: { [key]: number | boolean } } }`. It holds only values that differ from `initialConfig` (an edit back to the creation value deletes the key, and empty objects are pruned). It is written on a finished edit, never per frame.
- Applied in `createCharacter`, right after the `initialConfig` snapshot, behind `isDebugEnvironment()` (the `resolveSkyBoxDef` pattern, §2.5). It reads LS synchronously, so production never reads it. Each applied key also calls `controller.config.onChange`. The controller is assigned after `createCharacter` resolves, so the hook runs right after that assignment. Alternatively, `createDynamicCharacter` applies the overrides before `getDimensions`. Decide in Phase 3; the latter is the only way baked overrides can take effect without a rebuild.
- Baked keys are not saved in Phases 1-3 (they are locked).
- A key the character no longer has (a renamed config key) is skipped with one `lwarn`.
- Clearing: the Characters tab's clear-LS button gets `hasData`/`onClear` for this key (the current scene's entries). Clearing does not touch the live values; the dialog says they return on the next creation. The window header shows `N saved` with its own clear button, for this character.
- Applied overrides log one dev line per character (`[Character] 'topDownChar': 3 debug config overrides applied`), so tuned values are never mistaken for code values.

### 4.7 Copy changes

- Builds `{ _maxVelocity: 4.2, _jumpAmount: 6 }` from the keys that differ from `initialConfig`, in `DEFAULT_CHARACTER_DATA` order. Numbers are rounded to 4 decimals with trailing zeros removed, and radians are written as given (with a `// 52.0°` comment).
- Clipboard with the Copy JSON fallback (`llog` and a toast, p067 §3.12). The toast says how many keys were copied. When a baked key changed (Phase 4), it adds "Resize the visual too (height/radius)".

### 4.8 Body rebuild (Phase 4, optional)

`rebuildBody()` in `createDynamicCharacter`:

1. Recomputes `dims = body.getDimensions(characterData)` (`dims` becomes `let`) and the colliders with `body.getColliders`.
2. Replaces the entity's colliders in place: `removeCollider` and `createCollider(params, rigidBodyId)` through the Physics API (`PhysicsAPITypes.ts:1494`, `:1525`; async in `WORKER_THREAD` mode), keeping the role order. It also updates the `COLLIDER` component array, `colliderIndexes`, `mainCollider`/`crouchCollider`, the crouch collider's enabled state for the current stance and the sensors' collision handlers.
3. Clears `__touchingWallColliders`/`__touchingGroundColliders`: the new sensors report their contacts again.
4. Publishes a new `probes` object (§2.3).
5. Holds the tick (a flag) while the rebuild is in flight, so no sub-step runs with half the colliders.

The window shows an "Apply body changes" button in the Properties header while a baked key differs from the value the body was built with. Baked edits are staged (written to `data`, no effect) until it is pressed, and the button is one undo step with every staged key. Undoing it rebuilds again.

Risks: collision-event handler registration for a replaced collider in both worker targets; the physics debug draw and the ray helpers keyed by collider; a character standing on a moving platform during the swap. If this turns out heavier than expected, the baked keys stay locked and the copy-out note (§4.7) covers them.

## 5. Phases

Each phase can be reviewed and committed on its own.

### Phase 1 — Engine hooks (no visible change) — done

- `CharacterObject.initialConfig` (§4.1), `CharacterConfigHooks` and `CharacterController.config` (§4.2), filled by `createDynamicCharacter`. JSDoc on both.
- Check: lint and type-check pass. In the gym, `initialConfig` holds the merged values (the gym's `_height`/`_radius`, the scheme's `_turnToMoveDirection`). Writing `_maxWalkableAngle` and calling `onChange` changes `__maxWalkableAngleCos`, and the gizmos' ground normal turns red/green at the new angle.
- (done) `CharacterConfigValues` (`Readonly<Record<string, number | boolean | string>>`) types `initialConfig`; the snapshot (`getConfigSnapshot` in `Character.ts`) takes the `_` keys with a primitive value, at the very start of `createCharacter`. `CharacterConfigHooks` has `bakedKeys` and `onChange` only: `rebuildBody` is added in Phase 4. In `DynamicCharacter.ts`, `BAKED_CONFIG_KEYS` is checked against `CharacterBodyData` (`satisfies Record<keyof CharacterBodyData, true>`), so a new body size key can't be left out. `DERIVED_CONFIG` is a key → derive function `Map` (not an object, so a key like `__proto__` can't hit an inherited property), run once at creation in place of the inline `__maxWalkableAngleCos` line, and by `onChange`. `Character.ts` re-exports both new types.
- (done) Verified in the gym (WORKER*THREAD) with a headless probe on all three characters: `initialConfig` is frozen, has the 36 `*`keys (no state or`**`keys) and equals the live data;`\_turnToMoveDirection`is`false`for the`TANK`character and`true`for the arrow-keys one (from its scheme);`bakedKeys`lists the six size keys; writing`\_maxWalkableAngle`= 60° and calling`onChange`moves`**maxWalkableAngleCos`from 0.7071 to 0.5 and back, leaving`initialConfig`untouched;`onChange`with a live key,`**proto**` or an unknown key does nothing. The gizmo colour change was not checked visually (the derived value it reads was).

### Phase 2 — Editable rows, reset, copy and undo — done

- The editors, markers, hints and Properties header buttons (§4.3), `writeConfig` (§4.4), the `character.config` undo action (§4.5), Copy changes (§4.7).
- Check in the gym (both worker targets): `_maxVelocity` and `_jumpAmount` change the motion at once; `_tumblingAngularDamping` applies from the next tumble; a focused input is never overwritten while the character moves; reset and Reset all restore the creation values; one undo per edit, a held ArrowUp coalesces into one step, undo of Reset all restores every key; Copy changes pastes into `createDynamicCharacter({ charData })` and reproduces the tuning after a reload; the window's update cost (`upd … ms`) stays where it was.
- (done) Editors: a text input (`inputmode="decimal"`), not `type="number"`, which shows a decimal comma in some locales next to the read-only rows' `toFixed` values; a typed comma is accepted. Enter commits and blurs, so the game gets its keys back. Keys typed in an editor don't reach the key bindings on `window` (`KeyboardInput` has no focus check, so ArrowUp would move the arrow-keys character and `h`/`u`/`i` would fire), except the F-keys; a keyup is held back only when its keydown started in the editor, so a held key can't stick. The toggle and the reset buttons never take the focus (a later Space can't press them). Committed values are clamped and rounded to 6 decimals in the editor's unit. The hints live in their own module, `_dbg__CharacterConfigHints.ts` (unit is a free string: `rad/s`, `m/s²`, `×r` …); `_gettingUpDuration` has min 1 (a divisor).
- (done) Markers: values match `initialConfig` within 1e-12 (relative), and a commit that close to the creation value writes it exactly (45° typed back is `Math.PI / 4`, unmarked). Locked rows get no marker or reset. The Properties header shows `N changed`, Copy changes and Reset all, only while the group is open (the markers are only up to date then). Every write goes through `applyConfigValues`, which refreshes the character's open window.
- (done) Undo: the payload is `{ charId, prev: { [key]: value }, next: { [key]: value } }`, not §4.5's `changes` array: `_recordOrCoalesceUndoRedoAction` needs top-level `prev`/`next` and replaces `next` whole on a coalesce. A row reset and Reset all are not coalesced. The engine keeps a coalesced entry's first label, so number edits are labelled with the value they started from (`_maxVelocity (from 3.7)`, `_maxWalkableAngle (from 45°)`); toggles `→ true`, resets `reset <key>` / `reset all (N)`. Keys the character no longer has, or holds with another type, are skipped.
- (done) Copy changes: the diff is read from the data, not the markers, in `initialConfig` order (the generic window can't import `DEFAULT_CHARACTER_DATA`; the merge keeps its order anyway). Baked keys are left out. Radians are written in full (4 decimals would move them up to 0.003°) with the degree comment.
- (done) Verified headless (Playwright, real Ctrl+Z / Ctrl+Shift+Z) in both worker targets on `arrowKeysChar`: peak speed 3.70 → 6.00 m/s, peak jump speed 4.86 → 7.88 (WORKER_THREAD) / 7.71 (MAIN_THREAD) m/s; `_tumblingAngularDamping` = 7 read back from the body during the next tumble; the copied snippet merged over `initialConfig` equals the tuned config for every key (the gym's code was not edited); update cost 0.034 / 0.037 ms against 0.038 / 0.036 ms at the Phase 1 commit (noise). Undo survives a reload, and is a quiet no-op for a deleted character.

### Phase 3 — Persistence

- `AEK_debugCharConfig` (§4.6): save, apply at creation, the `N saved` header, the Characters tab's clear-LS button.
- Check: a tuned character keeps its values after a reload and after leaving and re-entering the scene; another scene's character with the same id is not affected; clearing restores the code values on the next creation; a production build doesn't read the key (search the bundle for `AEK_debugCharConfig`).

### Phase 4 — Body rebuild (optional)

- `rebuildBody` (§4.8), staged baked edits and the "Apply body changes" button, unlocked baked rows.
- Check in both worker targets: a larger `_radius` grows the colliders (physics debug draw), the gizmos' floor sensor ball and the probes; crouching still swaps the capsules; the character keeps standing on the elevator through a rebuild; undo rebuilds back.

### Docs and version (with the last phase that lands)

- `CLAUDE.md`: one line on editing in the Character debugging bullet (the `config` hook, `AEK_debugCharConfig`).
- `readme.md`: the debug suite's character line, if it lists the state window's features.
- `CHANGELOG.md` and the engine minor bump (new `CharacterObject`/`CharacterController` fields), unless this branch's bump already covers it.

## 6. Out of scope

- Editing the State group (§3), the intent or the control mode.
- Editing `__` internal memory: it is the state machine's working memory, not configuration.
- Saving tuned values back into the scene source (there is no character JSON schema yet; copy-out is the bridge).
- Resizing the visual on a body rebuild: the app owns it.
