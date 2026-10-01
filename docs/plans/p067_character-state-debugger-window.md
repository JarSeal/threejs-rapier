Status: draft | not-implemented
Category: Character, Debugger
Blocked by: p066_character-definitions-and-refactoring.md
Blocks: p068_character-debug-gizmos.md, p069_character-live-config-editing.md

# Character State Debugger Window — Plan

This plan revives the legacy per-character "Character data tracker" window as a fast **Character state** window. The window shows a character's `data` object split into three collapsible groups by name prefix (state / `_` properties / `__` internal memory). Each value has its own display: vectors on one line, booleans as green/red circle icons with the check or X cut out, and numbers with a fixed width. The window has an update-interval input. It updates only values that changed, and only in open groups, so it costs almost nothing per frame. It also shows timestamps as "ms ago", radians with degrees, flashes rows whose value changed, and can freeze the view or copy it as JSON. The legacy window showed an empty list until p066 restored its data link (see §2.1).

---

## 1. Goal

- Each character gets its own live window, opened from the character's edit window (the existing tracker button).
- Values are split into three collapsible groups by key prefix:
  1. **State** (no prefix, e.g. `position`, `isFalling`). Listed first and open by default. This is the most important debugging view.
  2. **Properties** (`_` prefix, e.g. `_height`, `_maxVelocity`). Mostly static but can change, so they keep updating while the group is open. Listed second and open by default.
  3. **Internal memory** (`__` prefix, e.g. `__isFallingStartTime`). Cached values the state machine uses to decide the next state (e.g. jumping vs. falling while `isGrounded = false`). Listed last and **closed** by default.
- A closed group is never updated.
- A header row holds the **update interval** input (ms; `0` = every rendered frame, `> 0` = at most once per that many ms) and the Flash, Freeze and Copy JSON controls.
- Values are easy to read:
  - vectors on one line
  - booleans as green/red circle icons with a cut-out check or X
  - numbers with a fixed width
  - timestamps as "ms ago"
  - radians with degrees
- The per-frame cost is close to zero, and the window shows its own measured cost.

---

## 2. Current state (grounded in the actual code)

### 2.1 The data link (restored by p066)

- The tracker reads `CharacterObject.data` (`src/_engine/core/Character/CharacterTypes.ts:10-24`, `data: Record<string, unknown>`, default `{}` in `createCharacter`, `src/_engine/core/Character.ts:73-79`). `CharacterObject` is the data of the character entity's `CHARACTER` component.
- Commit `22a72a0` ("Input system refactoring…") accidentally dropped `data: characterData` from `createDynamicCharacter`'s `createCharacter()` call, so `data` was always `{}` and the tracker rendered an empty `<ul></ul>`.
- p066 Phase 1 put it back: `createDynamicCharacter` (`src/_engine/core/Character/DynamicCharacter.ts:357`) builds the live `characterData` object at `:369` and passes it at `:866`. The legacy tracker shows values again.
- p066 Phase 2 removed the controller's private character map: `CharacterObject.data` (or the returned `DynamicCharacter.charData`, the same object) is the only way to the live data.

### 2.2 The legacy tracker (`src/_engine/core/Debug/_dbg__Character.ts:85-135`)

- **Content.** A plain-DOM `CMP()` with an `Update interval: …` text line. Its child CMP's `html` function rebuilds one string for the whole list:
  - arrays are joined with `', '`
  - objects become a nested `<ul>` one level deep
  - everything else is printed raw
- **Loop.** A `createSceneAppLooper` with `TRACKER_UPDATE_INTERVAL = 0.0000001`, so the window's `innerHTML` is rebuilt on every app frame.
  - App loopers run only while `loopState.appPlay` is on (`src/_engine/core/MainLoop.ts:157-166`), so the tracker freezes when the app is paused.
- **Bugs:**
  - `trackCharLoopIndex` and `debuggerTrackerWindowCmp` (`:31-32`) are single module-level variables. With two tracker windows open, the second overwrites the first's looper index, and closing one can delete the other's looper.
  - `onClose` is attached inside a `setTimeout(…, 200)` (`:128-133`, marked as a hack).
  - The window is opened (`:170-188`) with `removeOnClose: true`, which its own TODO describes as a workaround for "won't work the second time".
- **Wiring:**
  - The debug module is lazy-loaded by `Character.ts:188-201` (`loadDebugModuleAsync(() => import('../core/Debug/_dbg__Character'), true)`, which also loads in prod-test mode).
  - After a reload, `_updateCharactersDebuggerGUI` (`_dbg__Character.ts:348-375`) re-attaches content functions to windows restored from localStorage via `registerDraggableWindowCmp`.

### 2.3 Window and loop facts this design relies on

- **Window API** (`src/_engine/core/UI/DraggableWindow.ts`):
  - `closeDraggableWindow` (`:417-440`) only calls `windowCMP.elem.remove()` unless `removeOnClose` is set. The content CMP is never `CMP.remove()`d on a plain close, so its `onRemoveCmp` (`src/_engine/utils/CMP.ts:594`) fires only on remove.
  - `removeDraggableWindow` (`:972-982`) does remove the CMP tree.
- **Late main loopers:**
  - `createSceneMainLooper(fn, sceneId?, isLateLooper = true)` (`src/_engine/core/Scene.ts:394`) returns an index.
  - They run in `runSceneMainLateLoopers` (`MainLoop.ts:183`): after physics, the app loop and render, only on rendered frames (after the FPS-limiter `skipFrame` return), and **also while the app is paused**.
  - `deleteSceneMainLooper(index, sceneId?, isLateLooper?)` (`Scene.ts:431`) defaults to `currentSceneId`, so the owning scene id must be captured at creation and passed back.
- **Timestamps.** `getPhysGameTime()` (`src/_engine/core/PhysicsAPI.ts:628`) is pause-aware real time in ms. The character code stamps `__jumpTime`, `__isFallingStartTime`, `__isTumblingStartTime` and `__isGettingUpStartTime` with it (`DynamicCharacter.ts:1216, 1037, 1235, 969`) and resets them to `0`.
- **Nested objects are mutated in place** (since p066 Phase 1): `position`, `velocity`, `relVelocity`, `angularVelocity`, `groundNormal` and the platform velocities keep their object every tick, and only their fields change. Two consequences:
  - The diff must compare the components (§3.3). Comparing object references would never see a change.
  - The window still re-reads `data[key]` on every update and doesn't cache nested object references: the convention on `CharacterObject.data` keeps controllers free to replace them.
- **UI building blocks:**
  - `getSvgIcon(key, size?)` (`src/_engine/core/UI/icons/SvgIcon.ts`) takes Bootstrap-style 16×16 `fill="currentColor"` SVGs from `icons/svg/`, imported with `?raw`.
  - Window helper classes (`winSmallIconButton`, `winSmallLabel`, `winFlexContent`) are in `DraggableWindow.module.scss`.
  - Colours are Sass variables in `src/_engine/styles/variables.scss` (`$info #307b4d`, `$alert #700606`, `$debugTextColor #bbbcc4`).
  - `lsGetItem`/`lsSetItem` are in `src/_engine/utils/LocalAndSessionStorage.ts:75/92`; `addToast` is in `src/_engine/core/UI/Toaster.ts:278`.
  - There is no reusable collapsible-group DOM component. Tweakpane folders exist, but this window is plain DOM.

### 2.4 The data shape (`CharacterData`, `DynamicCharacter.ts:31-166`)

The comment at `:31-36` defines the convention: `_` = configuration, `__` = memory slot (not configurable). Every field has a one-line JSDoc (p066 Phase 1).

| Group                                        | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **State** (20)                               | `position` {x,y,z}; `velocity`, `relVelocity`, `angularVelocity` {x,y,z,length}; `charRotation` (rad); `groundNormal` {x,y,z}; booleans `isAwake`, `hasMoveInput`, `isGrounded`, `isFalling`, `isRunning`, `isCrouching`, `isNearWall`, `isOnStairs`, `isOnMovingPlatform`, `isSliding`, `isTumbling`, `isGettingUp`, `groundIsWalkable`, `isMovingTowardsImpossibleSlope`                                                                                                                                                                                                       |
| **Properties** (35, numbers but one boolean) | `_height`, `_radius`, `_crouchHeight`, `_skinThickness`, `_groundDetectorOffset`, `_groundDetectorRadius`, `_tumbling*` (7), `_gettingUp*` (4), `_rotateSpeed`, `_maxVelocity`, `_maxWalkableAngle` (rad), `_minSlidingVelocity`, `_moveYOffset`, `_jumpAmount`, `_jumpCooldown` (ms), `_inTheAirDiminisher`, `_accumulateVeloPerInterval`, `_isFallingThreshold` (ms), `_runningMultiplier`, `_crouchingMultiplier`, `_keepMovingAfterJumpThreshold`, `_wallMicroPush`, `_wallNormalMaxY`, `_wallCastDistance`, `_slopeSlideSpeed`; `_turnToMoveDirection` (bool, p066 Phase 3) |
| **Internal memory** (11)                     | timestamps `__isFallingStartTime`, `__isTumblingStartTime`, `__jumpTime`, `__isGettingUpStartTime`; `__lastIsGroundedState` (bool); `__maxWalkableAngleCos`, `__charAngDamping` (number); `__touchingWallColliders`, `__touchingGroundColliders` (`number[]`); `__lastAppliedPlatformVelocity`, `__currentPlatformVelocity` {x,y,z}                                                                                                                                                                                                                                              |

Since p066 Phase 3, `isRunning` and `isCrouching` follow the character's intent (`CharacterObject.intent`, outside `data`): the tick copies them from it. The intent's move, turn and jump fields are cleared by every tick, so a window reading them between frames sees zeros; `hasMoveInput` is the state field that shows the last sub-step's move input. Showing the intent is out of scope here.

---

## 3. Design

### 3.1 Data source: generic, prefix-driven

- The window keeps reading `CharacterObject.data`. It knows nothing about `DynamicCharacter` and classifies keys only by prefix: `__` → Internal memory, `_` → Properties, otherwise → State. Any future character type that follows the same naming convention gets the window for free.
- The doc comment on `CharacterObject.data` (`CharacterTypes.ts:19-21`, added by p066) describes the convention and says the debug tools rely on it.
- Key order within a group follows `Object.keys` order, which matches the declaration order in `DEFAULT_CHARACTER_DATA` (`DynamicCharacter.ts:192`).

### 3.2 Module layout

- New `src/_engine/core/Debug/Character/_dbg__CharacterStateWindow.ts`, following the `Debug/Camera/` and `Debug/Light/` subfolder pattern, plus `src/_engine/core/Debug/Character/CharacterStateWindow.module.scss`.
- It exports `_createCharacterStateWindowContent(winData)` and `_openCharacterStateWindow(character)`.
- `_dbg__Character.ts` imports it statically. It is already dynamically imported and gated, so the new module still tree-shakes out of production builds, and `InitApp.ts` doesn't change.
- `createTrackCharacterContent`, `debuggerTrackerWindowCmp` and `trackCharLoopIndex` are removed from `_dbg__Character.ts`. The tracker button (`:170-188`) and the `CHAR_TRACKER_WIN_ID` branch of `_updateCharactersDebuggerGUI` (`:365-369`) call the new module instead.
- The window id `characterDataTrackerWindow_<charId>` stays the same, so window positions and sizes already saved in localStorage keep working.
- The window title becomes `Character state: <name | [id]>`, and the button tooltip becomes "Open character state window".

### 3.3 Rendering strategy: build once, write only what changed

This answers the open question in the request: yes, updating only the changed values is clearly faster than rebuilding the list.

**What the legacy rebuild costs on every frame:**

- string concatenation of about 60 rows
- an HTML parse
- tearing down and creating about 100 nodes
- style recalculation and layout of the whole subtree
- string and DOM-node garbage, which adds GC pressure

**What a targeted update costs:** assigning `Text.nodeValue` on an existing text node invalidates only that node. With fixed-width cells, layout stays local.

The plan:

1. **Build once.** On open, build a row per key: a label element and one value cell per display part. Each row keeps its `Text` node and element references and its **last raw values** (numbers or booleans, never object references).
2. **Diff raw, format lazily.** On update, for each row in an _open_ group, read `data[key]` again and compare the raw primitives with `!==` (per component for vectors: they are mutated in place, §2.3). Only when something changed, format it and write `nodeValue`. Unchanged values cost one comparison and allocate nothing.
3. **Fixed widths.** Number cells use `font-variant-numeric: tabular-nums`, a monospace-ish stack and a `min-width` in `ch`, right-aligned. A changing number therefore never re-flows its neighbours.
4. **Structural rebuild only when needed.** If `Object.keys(data).length` changes or a key's detected type changes, rebuild that group. This is a rare, cheap check.
5. **Measure it.** Each update is timed with `performance.now()`. The average is shown in the header (`upd 0.03 ms`) and refreshed at most 4× per second, so the readout itself costs almost nothing. This gives a real number for the performance study (see §6).

### 3.4 Row types (detected with `typeof` at build time)

| Type                                                         | Display                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| boolean                                                      | Circle icon (§3.5) + label; `title` = `true`/`false`                               |
| number                                                       | `toFixed(3)`, right-aligned                                                        |
| vector-like object (only numeric keys from `x,y,z,w,length`) | One line: `x 0.000  y 1.234  z -0.500 · len 1.300`, one text node per component    |
| `number[]`                                                   | `(3) 12, 45, 7`, truncated after 8 items (`… +n`)                                  |
| anything else                                                | Truncated `JSON.stringify` (fallback, so an unknown field never breaks the window) |

- The key label shows its prefix (`_` / `__`) dimmed, so the name stays copy-pasteable and the prefix doesn't dominate.
- The row's `title` shows the full key and the raw unformatted value. It is refreshed lazily on `mouseenter`, not every frame.

### 3.5 Boolean icons (new SVGs)

- **New files:** `src/_engine/core/UI/icons/svg/circle-check-cutout.svg` and `circle-x-cutout.svg`, registered in `SvgIcon.ts` as `circleCheckCutout` and `circleXCutout`, so other debug panels can reuse them.
- **Shape:** each is a 16×16 single `<path>` with `fill="currentColor"` and `fill-rule="evenodd"`. The inner shape is a real hole, so the window background shows through: a negative, cut-out symbol, not a white glyph drawn on top. Because there is no `<mask>`/`<clipPath>`, there are no document-global ids to collide when many icons are inlined.

```svg
<!-- circle-check-cutout.svg (true) -->
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
  <path fill-rule="evenodd" d="M8 0a8 8 0 1 0 0 16A8 8 0 1 0 8 0Z M3.6 8.5 4.9 7.2 6.9 9.2 11.1 4.2 12.5 5.4 7 11.9Z"/>
</svg>

<!-- circle-x-cutout.svg (false) -->
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
  <path fill-rule="evenodd" d="M8 0a8 8 0 1 0 0 16A8 8 0 1 0 8 0Z M8 9.27 9.77 11.04 11.04 9.77 9.27 8 11.04 6.23 9.77 4.96 8 6.73 6.23 4.96 4.96 6.23 6.73 8 4.96 9.77 6.23 11.04Z"/>
</svg>
```

- **Geometry:**
  - The check is a closed polygon: short leg at 45°, long leg at about −50°, about 1.8 units thick throughout, with square end caps. Its box is x 3.6–12.5 and y 4.2–11.9, optically centred.
  - The X is a 45°-rotated plus: arms about 1.8 units thick with half-length 3.4, centred on (8, 8).
  - Both stay well inside the r = 8 circle.
- **Colour** is set in CSS through `color` on the icon span.
  - New Sass variables in `variables.scss`: `$debugBoolTrue: #3fb56b` (green) and `$debugBoolFalse: #d04848` (red).
  - The existing `$info` (#307b4d) and `$alert` (#700606) are too dark to read at 14px on the debug window background.
  - The icon is rendered at about 1.4rem, with `flex-shrink: 0` so it never squashes.
- **Updating:** the boolean row holds both icons (inline `getSvgIcon` markup) and toggles a single `isTrue` class on the row **only when the value changes**. CSS shows the matching icon and colour. No markup is rebuilt.

### 3.6 Header controls row

In this order, using `winSmallLabel` / `winSmallIconButton` / `winFlexContent`:

- **Interval `[ 0 ] ms`:** `<input type="number" min="0" step="10">`.
  - `0` = every rendered frame; `> 0` = update when `performance.now() - lastUpdate >= intervalMs`. This is real time, not app-speed-scaled time, so the value means what it says even at a changed play speed.
  - Empty, NaN or negative input is clamped to `0`. The value applies on `input`.
- **Flash:** a checkbox (§3.10).
- **Freeze / Copy JSON:** icon buttons (§3.11).
- **Cost readout:** `upd 0.03 ms`, dimmed, right-aligned (§3.3).

### 3.7 Collapsible groups

- Native `<details><summary>`, with the title and field count (`State (20)`, `Properties (35)`, `Internal memory (11)`). This is native, accessible and needs no JavaScript to toggle.
- The update loop checks `details.open` and skips the whole group when it's closed.
- When a group is opened, it is fully refreshed right away (the `toggle` event), so it never shows stale values until the next interval tick.
- The whole update is skipped when the window is collapsed (`getDraggableWindow(id)?.isCollapsed`) or Freeze is on.

### 3.8 Loop and lifecycle (fixes the §2.2 bugs)

- **One late main looper per window**, created with `createSceneMainLooper(fn, sceneId, true)`. `sceneId` is `getCurrentSceneId()`, captured at creation.
  - It runs after all physics sub-steps and render, so it always shows the last sub-step's values.
  - It also runs while the app is paused. Since nothing changes while paused, the diff makes those frames cost almost nothing, and you can still toggle groups and see full values when paused.
- **Per-window instance map.** `Map<charId, { looperIndex, sceneId, rows, ... }>` replaces the module-level variables, so two open windows can never delete each other's loopers.
- **Cleanup:**
  - It happens in the content CMP's `onRemoveCmp`: `deleteSceneMainLooper(looperIndex, sceneId, true)` and removing the map entry.
  - As a safety net, the looper deletes itself when `!rootElem.isConnected`. This covers any close path that detaches the DOM without removing the CMP.
  - This replaces the `setTimeout` `onClose` hack.
  - `removeOnClose: true` and `closeOnSceneChange: true` stay. Fixing close vs. remove inside `DraggableWindow` is out of scope (§5).
- **Deleted character.** If `getCharacterById(charId)` returns nothing, the window shows the `emptyState` text "Character not found (deleted?)" and stops updating. It doesn't throw.

### 3.9 Persistence (per viewer)

- localStorage key `AEK_charStateWin` holds `{ intervalMs: number, flash: boolean, groupsOpen: { state: boolean, props: boolean, internal: boolean } }`, shared by all character windows, read with `lsGetItem`/`lsSetItem`.
- Defaults: `{ intervalMs: 0, flash: true, groupsOpen: { state: true, props: true, internal: false } }`.
- It is written on change, never per frame.
- This is a debug-UI convenience only. It holds no scene or character data, so it doesn't need a clear-LS button entry. The Characters tab's clear-LS buttons stay permanently disabled (`_dbg__Character.ts:324-328`).

### 3.10 Readable values

A small `key → formatter` map, used only for known keys. Any other key uses the generic type formatter from §3.4.

| Keys                                                                                    | Display                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__jumpTime`, `__isFallingStartTime`, `__isTumblingStartTime`, `__isGettingUpStartTime` | `340 ms ago` (`getPhysGameTime() - value`), or `—` when `0`. The raw timestamp is in `title`. These rows update every tick while their group is open (4 rows, cheap). |
| `charRotation`, `_maxWalkableAngle`                                                     | `0.785 rad (45.0°)`                                                                                                                                                   |
| `__touchingWallColliders`, `__touchingGroundColliders`                                  | The generic `number[]` format with the count first: `(2) 14, 31`                                                                                                      |

### 3.11 Change flash

- **When a row flashes:** when its **raw** value changes, but only for booleans (all groups), arrays, every `_` value, and `__` scalars (a changed timestamp means an event just happened).
- **When it doesn't:** vectors and state-group numbers (`position`, `velocity`, `charRotation`, …) change almost every frame, so they never flash.
- **How:** the Web Animations API, `row.animate([{ backgroundColor: flashColor }, { backgroundColor: 'transparent' }], { duration: 400 })`. The `Animation` is kept per row and restarted with `anim.currentTime = 0; anim.play()`. There is no class toggling and no forced reflow (`void el.offsetWidth`), so it is safe at interval 0.
- **Why it helps:** it catches one-frame flips such as `isGrounded` flickering on stairs or slopes, which a normal refresh never shows.
- The Flash checkbox turns it off (persisted, §3.9).

### 3.12 Freeze and Copy JSON

- **Freeze** is a toggle icon button (`pause` / `playFill` icons, with a `current` class when active). While frozen, updates are skipped and the current snapshot stays on screen, so you can read a transient state after it has passed. The header shows "FROZEN".
- **Copy JSON** writes `JSON.stringify(character.data, null, 2)` with `navigator.clipboard.writeText`. On success it shows `addToast` "Character data copied". If the clipboard API is missing or rejects (e.g. an insecure context), it falls back to `llog('CHARACTER DATA:', data)` and a toast saying so. It always copies the _live_ object, even while frozen. This is documented in the tooltip.

---

## 4. Phases (each non-breaking and committable on its own)

### Phase 1: Restore the data link (bug fix) — done by p066

- p066 Phase 1 added `data: characterData` back to the `createCharacter()` call (`DynamicCharacter.ts:866`), and p066 Phase 2 added the doc comment on `CharacterObject.data` (§3.1). Nothing is left to do here.
- **Result:** the legacy tracker shows values again (still slow and ungrouped). This is the "before" baseline for the §6 measurement.

### Phase 2: New Character state window (core)

- Add `Debug/Character/_dbg__CharacterStateWindow.ts` and `CharacterStateWindow.module.scss`.
- Build rows once and update with the diff (§3.3, §3.4), including the cost readout.
- Add the two SVGs, the `SvgIcon.ts` keys and the colour variables (§3.5).
- Add the header with the interval input (§3.6), the `<details>` groups with skip-when-closed (§3.7), and the per-window late looper, instance map and cleanup (§3.8).
- Add LS persistence for interval and group state (§3.9).
- Update `_dbg__Character.ts`: remove the legacy tracker code and module-level variables, and point the tracker button and the `_updateCharactersDebuggerGUI` re-registration at the new module.

### Phase 3: Readability extras

- Add the readable-value formatters (§3.10), the change flash with its persisted toggle (§3.11), and Freeze and Copy JSON (§3.12).

---

## 5. Risks, notes, out of scope

- **Sub-step timing.** `characterData` is mutated in `APP_PHYSICS_STEP`, 0–N times per frame. The window reads it in the late loop, so it shows the last sub-step's state. A frame with 0 sub-steps shows no change, which is correct.
- **One-step-late fields.** `groundNormal`, `groundIsWalkable` and the wall-hit results come from async physics queries (worker-safe) and are one step behind by design (`DynamicCharacter.ts:397-402`). Mention this in the window as a `title` on those rows, so it isn't mistaken for a window bug. (`isAwake` is no longer late: since p066 it is derived from the velocities in the tick.)
- **Dead fields.** p066 removed `_groundedRayMaxDistance`, `_tumblingAngDamping`, `__wasOnMovingPlatformLastFrame` and `_roundVelocitiesScalingFactor`. Only `isMovingTowardsImpossibleSlope` is left: declared but never written. The window shows it as it is.
- **Out of scope (`DraggableWindow` quirks):**
  - close vs. remove semantics (the reason `removeOnClose` stays)
  - `updateDraggableWindow` being hard-wired to call `updateDebuggerCharactersListSelectedClass()` (`DraggableWindow.ts:611`)
  - `windowClassList.concat(...)` discarding its result (`:500, :634`)
  - the height clamp using `minSize.w` (`:753, :823`)
- **Undo plans.** p061's undo inventory (implemented) classed the tracker button as navigation-only (not recorded). That stays true: nothing in this window edits scene or character data. Editing arrives with p069.
- **Prod-test mode.** `_dbg__Character.ts` also loads in `?isProdTest=true`, but `_createCharactersDebuggerGUI` returns early unless `IS_DEBUG_ENV`. The window therefore stays debug-only, as today.

---

## 6. Verification

1. Run `yarn dev` and open `http://localhost:8080/?isDebug=true`. Load the third-person Gym scene (`src/app/scene_thirdPersonGym.ts`), which has two characters.
2. In the debugger (`h`), open **Characters** → a character's edit window → **Open character state window**.
   - All three groups fill.
   - State and Properties are open and Internal memory is closed.
   - Vectors show on one line, and booleans show green-check / red-X icons with the cut-out showing the window background.
3. Move, jump, run, crouch and fall off a ledge.
   - `isGrounded`, `isFalling` and the others flip, and the rows flash.
   - `__jumpTime` shows a growing "ms ago" value.
   - `charRotation` shows degrees.
4. Set the interval to `500`: values visibly update about twice a second. Set it back to `0`: every frame.
5. Collapse **State**. In DevTools → Elements, confirm its text nodes stop changing. Reopen it: it refreshes immediately.
6. Open the state windows of **both** characters and close one. The other keeps updating. Check in the console that the scene late-looper count doesn't grow after repeated open/close cycles.
7. Pause the app: nothing breaks and the values hold. Test Freeze and Copy JSON (paste the result into an editor). Change scene and come back: the window closes on scene change, and reopening works. Reload with the window open: it is restored and works.
8. **Performance study.** In the Chrome Performance panel, record 5 s at interval 0 with all groups open, on the Phase 1 build (legacy rebuild) and on the Phase 2 build. Compare scripting, style and layout time per frame against the in-window `upd` readout. Record the numbers in this plan when marking it `implemented`.
9. Run `yarn lint` and `yarn build` (type-check plus production build). Confirm with `dist-stats/bundle-stats.html` that the new module isn't in the production main chunk.

---

## 7. Follow-up plans

- `p068_character-debug-gizmos.md`: in-world 3D overlays (velocity and ground-normal arrows, ground detector sphere, grounded ray, wall shape-cast), toggled from this window's header.
- `p069_character-live-config-editing.md`: make the Properties (`_`) values editable in this window, with special handling for values baked into colliders and for derived `__` values.
