Status: implemented
Category: Debugger, Lines
Blocks: \_DONE_p142_physics-ray-debugging-and-stats.md, p143_ray-cast-tester-windows.md
Related: \_DONE_p058_line-rendering-system.md (amends its "no dashed lines" non-goal)

# Ray Debug Line Helpers — Plan

> Implemented in engine 2.2.0. §8 lists where the code differs from the design below.

Part of the ray casting plan set (index: `_DONE_p140_refactor-ray-casting.md` §1.1). Ray helpers today are
1 px THIN lines that are disposed the first frame their ray isn't cast. A ray that is cast for a
single frame is practically invisible, and it churns a line + material every time it flickers. This
plan replaces them with a shared, pooled, **thick-line** helper renderer. Its helpers stay visible
for a minimum time, then switch to an **inactive style (dashed, inactive color)** and fade out. It
adds opt-in screen-space dashes to the FAT line backend to make the inactive style possible, and
adds the helper settings and per-kind colors to the Ray Cast Controls tab. The renderer serves both
ray kinds: Three.js rays here, physics rays in p142.

---

## 1. Goal

- Each ray cast can request a helper with its own `id`, color, inactive color, width, hold and fade
  times.
- A helper is **active** (solid, active color) while its ray is cast, including a minimum hold time
  so one-frame rays are readable. It is **inactive** (dashed, inactive color, fading to transparent)
  after that. Then it is hidden and recycled.
- The hit point is marked. The line runs origin → hit, or origin → `far` on a miss.
- The Ray Cast Controls tab has helper settings and changeable colors **per ray kind** (Three.js and
  physics, with different default colors).
- No line or material is created or disposed per frame in steady state.

---

## 2. Current state (grounded in the actual code)

- `_dbg__Raycast.ts` `_drawRayHelper(origin, direction, far, debugOpts)`, called by p140's
  `castPrepared` only when a cast has `debug` (or the deprecated `helperId`): there is one
  `createLines({ capacity: 1, growth: 'FIXED', persistent: true })` per `debug.id`. The backend is
  AUTO at width 1, so THIN. The line is refilled with `writePolyline(beginWrite(), [origin, end])`
  each cast, where end = `far` (1000 when infinite). `setColor` is only called when the color changes.
- `_dbg__Raycast.ts` `_onRayCastFrameEnd`, called once per rendered frame by p140's core LATE_MAIN
  `rayCastFrameEndSystem` (`Raycast.ts`, default ECS world only, right after the stats `endFrame`),
  **disposes every helper not drawn this frame**. `_deleteAllRayHelpers` runs on scene exit
  (`SceneLoader.ts`, via `deleteAllRayHelpers()`).
- There is one global toggle, `showAllRayDebugHelpers`, and one default color, `#ff0000`. No real
  caller passes a `helperId`, so helpers effectively never show.
- **Line system** (`core/LineManager.ts`, `core/Lines/*`):
  - Width is in screen px. `backend: 'FAT'` pins the instanced-quad `LineNodeMaterial`
    (`Lines/LineBackendFat.ts`), which is lazy-loaded; await `preloadFatLineBackend()`.
  - One color/opacity per `LineObject`. `setColor(c, opacity?)`/`setColorStyle` are uniform writes,
    **except** crossing opacity 1.0, which toggles `transparent` and rebuilds the pipeline
    (`LineObject.ts:244`).
  - **No dashes in either backend.** The FAT material dropped `useDash` on purpose
    (`LineBackendFat.ts:33-35`). p058 lists dashed lines as a non-goal (`_DONE_p058…:378`) because
    `computeLineDistances` needs a cumulative per-segment distance attribute that complicates the
    refill path.
  - `LineObject.object3D` is not stable across a backend swap, so never cache it.
  - An example of a pooled, pinned-FAT, persistent line user is `_dbg__PhysicsDebugDraw.ts:652-737`.

---

## 3. Design

### 3.1 Opt-in dashes for the FAT backend (screen-space, per segment)

- New `LineProps.dash?: { dashPx: number; gapPx: number }`. Passing it at creation makes the line
  **dashable**: the FAT material is built with the dash branch. Lines without it compile exactly the
  shader they compile today, so there is zero cost for existing users (collider wireframes etc.).
- New `LineObject.setDash(dashPx: number, gapPx: number)`, a uniform write only. **`gapPx = 0` means
  solid**, so switching a helper between active (solid) and inactive (dashed) never rebuilds a
  pipeline. Calling `setDash` on a non-dashable line warns once and does nothing.
- **The pattern restarts at each segment's start and is measured in screen pixels.** This sidesteps
  p058's objection: no cumulative distance attribute and no change to the refill path. For ray
  helpers (one segment plus a few marker segments) this is exactly what is wanted. It is documented
  as a per-segment pattern for polylines.
- Shader (`segmentQuadClipPosition` already projects both ends to NDC):
  - Compute the segment's screen length in CSS px from `ndcEnd − ndcStart` and the viewport/DPR.
  - Emit the along-segment distance `d = clamp(templateY, 0, 1) × lengthPx` as a varying. The cap
    regions clamp to 0 and lengthPx.
  - `d` must interpolate **screen-linearly**. Use TSL's linear (no-perspective) varying interpolation
    if the installed three version exposes it. Otherwise use the classic workaround: pass `d · w` and
    `w` as perspective-corrected varyings and divide in the fragment shader.
  - Fragment: `mod(d, dashPx + gapPx) > dashPx` → discard, only when `gapPx > 0`.
- **Fallback:** THIN lines, and a FAT line while the backend is still loading, draw solid. A
  dashable line should pin `backend: 'FAT'`.
- p058's non-goal section gets a one-line note pointing here. The done plan stays otherwise
  untouched.

### 3.2 `RayDebugOpts` (shared by Three.js rays and physics rays)

```ts
export type RayDebugOpts = {
  /** Stable helper id; the same id reuses the same helper across casts/frames */
  id: string;
  color?: THREE.ColorRepresentation;          // active color (default: the kind's color)
  inactiveColor?: THREE.ColorRepresentation;  // default: the kind's inactive color
  width?: number;                             // screen px, default: the kind's width
  holdMs?: number;     // min time shown as active after the last cast (default: kind setting)
  fadeOutMs?: number;  // inactive fade duration (default: kind setting)
  showHit?: boolean;   // draw the hit marker (default true)
  depthTest?: boolean; // default false (helpers draw on top)
};
```

- It is defined in a type-only module (`core/RayDebugTypes.ts`), so `Raycast.ts` and
  `PhysicsAPITypes.ts` can import it without pulling in debug code.
- p140's temporary `{ id, color }` shape is replaced by this one. `RayCastOpts.helperId`/`helperColor`
  keep mapping onto `id`/`color`.

### 3.3 Shared helper renderer `src/_engine/core/Debug/_dbg__RayHelpers.ts`

It is debug-only and loaded through the existing `_dbg__` + `loadDebugModuleAsync` pattern. It is
called from `Raycast.ts` (and from PhysicsAPI in p142) via `useDebug(...)`.

```ts
type RayKind = 'THREE' | 'PHYSICS';
_drawRay(kind, origin: Vector3Like, dir: Vector3Like, far: number,
         hitDistance: number | null, opts: RayDebugOpts | undefined, nowMs: number): number /* token */;
_updateRayHit(token: number, hitDistance: number | null): void;   // late (async) results, p142
_clearRayHelpers(kind?: RayKind): void;                           // scene exit, toggles
```

- **Pool.** Each kind has a `Map<id, Helper>` plus a free list of hidden `LineObject`s. A helper line
  is created with:
  - `backend: 'FAT'`, `capacity: 4` (the ray segment plus a 3-segment hit cross), `growth: 'FIXED'`;
  - `persistent: true` (this module owns the lifetime) and `attach: 'ROOT_SCENE'`;
  - `depthTest: false`, `dash` enabled;
  - **opacity 0.99 from the start**, so fading is uniform-only and never crosses the 1.0 rebuild
    boundary.

  The pool awaits `preloadFatLineBackend()` once when helpers are first enabled.
- **Per helper state:** `lastCastMs`, `origin`, `dir`, `far` and `hitDistance`, stored in the
  helper's own vectors (no allocation), plus the resolved style.
- **Update pass**, one LATE_MAIN system in the same slot p140 uses for `endFrame`:
  - `now − lastCastMs ≤ holdMs` → **active**: solid (`setDash(dash, 0)`), active color, opacity 0.99.
  - Past the hold and `< holdMs + fadeOutMs` → **inactive**: dashed, inactive color, opacity
    `0.99 × (1 − t)`.
  - Past that → `setVisible(false)`, and the line is returned to the free list.
  - Style writes happen only on state changes, plus the opacity uniform while fading.
  - Timing uses `performance.now()`, so helpers keep fading while the app loop is paused.
- **Geometry** is rewritten only when a cast arrives (not every frame): origin → hit, or origin →
  `far` clamped to `maxHelperLength`, default 1000 (today's `DEFAULT_MAX_HELPER_LENGTH`). The hit
  cross is three short axis segments of size `hitMarkerSize`, drawn if `showHit` and there was a hit.
- **Anonymous rays.** Rays without `debug.id` are drawn only when the kind's "Show rays without an
  id" setting is on. They use the ids `anon_0…anon_N` in cast order per frame, capped by
  `maxAnonymousHelpers` (default 32). This covers mouse-picking rays.
- **Caps:** `maxHelpersPerKind` (default 256). Beyond that the least-recently-cast inactive helper is
  recycled, with a one-time warning.
- Scene exit (`SceneLoader.ts:504` → `deleteAllRayHelpers()`) calls `_clearRayHelpers()`. That hides
  and recycles everything; nothing is disposed. Turning a kind's helpers off disposes that kind's
  pool.

### 3.4 Ray Cast Controls tab: helper settings per kind

- The tab gets two folders: **Three.js rays** now, and **Physics rays** added by p142 with the same
  bindings. Each has:
  - Show helpers (replaces `showAllRayDebugHelpers`, which is migrated on load).
  - Show rays without an id.
  - Active color and inactive color.
    - Three.js defaults: `#ff3b30` / `#7a2a26`.
    - Physics defaults: `#30d5ff` / `#1f5f73`.
  - Default width (px, default 3).
  - Hold time (ms, default 250).
  - Fade-out time (ms, default 1500).
  - Dash / gap (px, defaults 8 / 6).
  - Force kind colors: ignore per-ray `color`/`inactiveColor`, for telling kinds apart at a glance.
- The state stays a flat object in the existing `debugRayCast` LS key (e.g. `threeActiveColor`,
  `physicsActiveColor`, …), ready for p105's declarative `state`/`lsKey`.
- Colors use `addBinding(state, 'threeActiveColor', { view: 'color' })` (the pattern in
  `Light/_dbg__LightGUI.ts:541`). Changes apply immediately to live helpers (a uniform write).
- **No undo recording**, consistent with p061 §2.2, which treats Ray Cast settings as
  cosmetic/dev-tool.
- The existing clear-tab-LS button keeps working, since it is the same key.

### 3.5 Wiring in `Raycast.ts`

- `castPrepared` (p140) calls `useDebug(helpers)?._drawRay('THREE', origin, dir, far, firstHitDistance,
  opts.debug, now)` after intersecting.
- The update pass hooks into `rayCastFrameEndSystem` (replacing its `_onRayCastFrameEnd` call), and
  the hit distance is added to `castPrepared`'s debug call.
- The old `_drawRayHelper`, `_onRayCastFrameEnd`, `_deleteAllRayHelpers` and `_toggleAllRayDebugHelpers`
  are removed from `_dbg__Raycast.ts`. The public `deleteAllRayHelpers()` wrapper stays and forwards
  to `_clearRayHelpers()`.

---

## 4. Phases (each non-breaking and committable on its own)

### Phase 1: FAT line dashes

- Add `LineProps.dash`, `LineObject.setDash` and the dashable FAT material variant (§3.1).
- Add a temporary visual check (not committed): one dashable line in a dev scene, toggling
  `gapPx` 0 ↔ 6, viewed at an oblique angle and crossing the near plane. The dashes must be even in
  screen space and the caps intact.
- Confirm that non-dashable lines produce the same shader as before. The collider wireframes must
  look unchanged.

### Phase 2: shared helper renderer (Three.js kind)

- Add `core/RayDebugTypes.ts` and `core/Debug/_dbg__RayHelpers.ts` (pool, update pass, hit cross,
  anonymous rays, caps).
- Wire `Raycast.ts` to the renderer. Remove the old helper code from `_dbg__Raycast.ts`.

### Phase 3: tab settings and colors

- Add the Three.js rays folder with the settings in §3.4, migrate `showAllRayDebugHelpers`, and apply
  settings live.

---

## 5. Risks, notes, out of scope

- **Shader change in a `_DONE_` subsystem (main risk).** It is mitigated by being opt-in through a
  separate material variant, so existing lines keep their exact shader. TSL varying-interpolation
  API drift is the likely snag, and the `d·w / w` workaround is the fallback. If dashes prove
  unworkable, the inactive style falls back to **inactive color + fade only** (no dashes). The
  helper renderer doesn't depend on dashes to function.
- **Transparency and sorting.** Helpers are transparent and drawn with `depthTest: false`. Order
  between overlapping helpers is not guaranteed, which is acceptable for debug use.
- **Backend swap.** Helper lines pin `'FAT'`, but the renderer still never caches `line.object3D`.
- **Per-segment dash pattern.** The dash restarts at each segment, which is documented. Cumulative
  polyline dashes remain out of scope.
- **Per-segment colors** (e.g. red past the hit point) are out of scope. The hit is shown with the
  marker instead.
- **Out of scope:** physics rays (p142), tester windows (p143), world-unit dash lengths, and
  animated (marching) dashes.

---

## 6. Verification

- `yarn lint` and `yarn build` are clean.
- `yarn dev`, open `?isDebug=true`, enable Three.js ray helpers and "Show rays without an id", then
  move the mouse:
  - The picking rays appear as thick lines with a hit cross.
  - A single click (one-frame ray) stays solid for about 250 ms, then turns dashed and fades over
    about 1.5 s.
- Change the colors, width, dash and gap in the tab. Live helpers update immediately, and the
  values persist across reloads.
- Pause the app loop while helpers are visible. They still fade out.
- Switch scenes. All helpers disappear and no errors appear.
- DevTools Performance: no line/material creation in steady state (the pool is reused). Pipeline
  rebuilds don't recur while helpers fade.
- Physics collider wireframes (the `DEBUG_PHYSICS_WIREFRAME` component) look unchanged.

---

## 7. Follow-up plans

- p142 adds the `'PHYSICS'` kind and uses `_updateRayHit` for async worker results.
- p143's testers use long-hold helpers.
- Possibly reuse the dashable FAT line for other debug visuals, e.g. p068 character gizmos and p125
  spatial index visualizer boundaries.

---

## 8. Implementation notes (where the code differs from the design)

- **No TSL linear (no-perspective) varying.** It exists (`setInterpolation('linear')`), but the WebGL2
  fallback compiles it to GLSL `noperspective`, which GLSL ES 3.00 doesn't have. The dash distance is
  always passed as `d·w` and `w` (`varyingProperty`s `vLineDashDistanceW`/`vLineDashW`) and divided
  per fragment. Verified on WebGPU and on the WebGL2 fallback.
- **The dash variant is chosen per material, not per pipeline.** `LineNodeMaterial(dashable)` picks
  one of two prebuilt vertex Fns (`buildSegmentQuadClipPosition(false | true)`); the non-dashable one
  is the pre-p141 body unchanged. `createFatLineBackend(positions, dashable)`, and `LineBackend`
  gained `setDash` (a no-op on THIN). `LineObject.isDashable` was added. Negative dash/gap values
  are clamped to 0.
- **The pattern anchors at the near-plane-trimmed start.** A segment starting behind the camera
  (e.g. a picking ray seen from another camera) restarts its dashes at the near-plane crossing, so
  they slide as the camera moves. Acceptable for debug helpers.
- **Found, not fixed: on the WebGL2 fallback a FAT line crossing the near plane is mostly missing**,
  dashed or not. `nearPlaneCrossing`'s near estimate appears to assume WebGPU's 0..1 depth range.
  Out of scope here.
- **The kind settings live in the renderer**, one object per kind (`getRayHelperSettings(kind)`,
  `setRayHelperSettings(kind, patch)` in `_dbg__RayHelpers.ts`), with the §3.4 defaults for both
  kinds already in place. Besides the tab settings they hold `hitMarkerSize` (0.3 world units, the
  length of each hit cross segment; the plan gave no default), `maxHelperLength` (1000),
  `maxAnonymousHelpers` (32) and `maxHelpers` (256, the plan's `maxHelpersPerKind`), which are not
  in the tab. A settings change bumps a per-kind version and live helpers restyle on the next update
  pass.
- **`RayHelperKind` (`'THREE' | 'PHYSICS'`)** is exported from `core/RayDebugTypes.ts` (re-exported
  by `Raycast.ts`) instead of a module-local `RayKind`.
- **Every Three.js cast reports to the renderer**, not only casts with `debug`, so anonymous rays
  can be drawn. It is a `useDebug` check and an early return while the kind is hidden.
- **A cast applies the active style immediately** (not on the next update pass): the update pass
  runs in LATE_MAIN, after the frame has rendered.
- **Casts are ignored until the FAT backend has settled** (the preload starts when a kind is first
  shown; a failed load still lets helpers draw, 1 px and solid), instead of drawing 1 px first.
- **At the cap with no inactive helper to recycle**, a new helper is skipped (the same one-time
  warning covers both cases).
- **Tokens** are `index · 2^21 + castSerial`; `_updateRayHit` only updates the helper's latest cast.
- **`_dbg__RayHelpers.ts` is loaded next to `_dbg__Raycast.ts`** in `registerRaycastDebugGUI`, and
  the tab imports it statically for the settings (same module instance).
- **The tab's per-kind folder is built by `helperSettingsFolder(prefix, kind, title)`** from a
  suffix → setting table (`HELPER_SETTING_KEYS`), so p142's "Physics rays" folder is the `'physics'`
  prefix plus one call. Every change, drag ticks included, is pushed with `setRayHelperSettings`.
- **`showAllRayDebugHelpers` is migrated by rewriting the LS object once**, before hydration (which
  only reads the persistKeys), to `threeShow`.
- **The clear-tab-LS button doesn't reset the live settings**, as before p141: the defaults come
  back on the next load.
