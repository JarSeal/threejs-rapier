# Changelog

One entry per branch merged to `main`, newest first, written in that branch's PR next to its version bumps (see "Versioning" in `.claude/CLAUDE.md`). Each entry has a section per part that changed: **Engine** (`src/_engine/`), **Toolkit** (`src/toolkit/`) and **App** (`src/app/` and the app-level files in `src/`). **Project** covers repo tooling that belongs to none of them. A part without a section kept its version.

Earlier releases are only recorded in the git history.

## 2026-10-02 — triple-buffered-physics-transform-buffer

### Engine 4.0.1 (Afternoon)

**Fixed**

- Physics reads no longer tear in `WORKER_THREAD` mode with the `SharedArrayBuffer` transport (`SHARED_MEMORY`). The worker used to rewrite the one shared transform buffer while the main thread read it, so a snapshot's step stamp could disagree with its poses, two systems in the same frame could see different steps, one pass over the bodies could mix two steps, and a single body could be half old, half new. This showed up as occasional interpolation spikes. The buffer is now a lock-free triple buffer: the worker publishes each finished, stamped write-back by an atomic bank swap, and the main loop latches the newest one at the start of every frame. Every reader in a frame (held keys, `APP_PHYSICS_STEP`, the TRANSFORM sync, interpolation, debug wireframes) sees the same complete snapshot, and a write-back that lands mid-frame is read from the next frame on. Memory: three banks, about 320 KiB at the default 2048 bodies. `MAIN_THREAD` and the `MESSAGE_BATCH` fallback are unchanged.

**Changed**

- `PhysicsTransformBuffer` (internal to the physics transport): `markWritten` is `publish`, `latch()` is new, the constructor and `createPhysicsTransformArrayBuffer` take a bank count (1 or `PHYSICS_TRANSFORM_SHARED_BANKS`), and `getWriteCount()` is gone. `CREATE_WORLD`'s response carries `bankCount`.
- `latchPhysicsSnapshot()` (`PhysicsAPI.ts`), called by every main loop variant right after `timer.update()`. Custom loops that drive `stepPhysics` themselves must call it first in each frame.

## 2026-10-02 — character-definitions-and-refactoring

### Engine 4.0.0 (Afternoon)

**Added**

- Characters are ECS entities: a `CHARACTER` component (`CharacterObject`) and a `TAG_IS_CHARACTER` tag. Deleting the entity (or leaving the scene) removes the character, its key and mouse bindings and its controller. `getCharacterById(id)`, `getCharacters(world?)` and `deleteAllCharacters(world?)`.
- Character intent (`CharacterObject.intent`, `core/Character/CharacterIntent.ts`): what the player or AI wants this sub-step (`moveX`/`moveZ` in world space, `moveForward` along the facing, `turn`, `faceYaw`, `jump`, `run`, `crouch`). Input, AI and game code write it, and only the controller's tick moves the body. Helpers: `createIntent`, `addIntentMove`, `hasMoveIntent`, `yawFromDirection` and `wrapToPi`.
- Input schemes (`createDynamicCharacter`'s `input`, `core/Character/CharacterInputSchemes.ts`): `TANK`, `WORLD_FIXED` (`moveNorth`/`South`/`West`/`East`) and `CAMERA_RELATIVE` (`moveForward`/`Backward`/`Left`/`Right` on screen). The `jump`, `run` and `crouch` mappings are optional, and `runMode`/`crouchMode` are `TOGGLE` (default) or `HOLD`. Binding ids are namespaced per character (`<id>:…`), so several input-driven characters work side by side.
- `_turnToMoveDirection` (default per scheme) turns the character toward its world move direction at `_rotateSpeed`.
- Body plans (`core/Character/CharacterBodyPlans.ts`): `HUMANOID_CAPSULE` derives the colliders by role (`MAIN`, `CROUCH`, `WALL_SENSOR`, `FLOOR_SENSOR`) and the probe dimensions from the size keys. `createDynamicCharacter`'s `body` takes a custom `CharacterBodyPlan`. `CharacterObject.kind` is the plan's kind (`'HUMANOID'`).
- Locomotion state: `data.locomotionState` (`IDLE`, `WALK`, `RUN`, `CROUCH`, `CROUCH_WALK`, `JUMP`, `FALL`, `SLIDE`, `TUMBLE`, `GET_UP`), with `onLocomotionStateChange(id, listener)` (returns the unsubscribe function) or the creator's `onLocomotionStateChange` option.
- Control mode: `setControlMode(id, 'CONTROLLED' | 'PHYSICS_ONLY')`. `PHYSICS_ONLY` leaves the body to physics (state `TUMBLE`). Back to `CONTROLLED`, the character gets up.
- Character config keys that replace hard-coded values, with the same defaults: `_tumblingAngularDamping`, `_gettingUpAngularDamping`, `_gettingUpMaxAngVelo`, `_gettingUpTorque`, `_wallMicroPush`, `_slopeSlideSpeed`, `_jumpCooldown`, `_wallNormalMaxY`, `_wallCastDistance`, `_crouchHeight` and `_fallStateDelay`. Every `CharacterData` field has a JSDoc line.
- `RigidBodyAPI.readVelocitiesInto(out, offset?)`: an allocation-free read of the linear and angular velocity, the twin of `readPoseInto`.
- Character state window (debug), opened from a character's edit window. It replaces the Character data tracker and keeps its window id, so saved positions and sizes still apply. It shows the character's `data` in three collapsible groups by key prefix: State, Properties (`_`) and Internal memory (`__`, closed by default).
  - Rows are built once, and an update writes only the values that changed, in open groups only. The update interval (0 = every rendered frame) is in the header, next to the update's measured cost.
  - Values are formatted for reading: booleans as green/red icons, vectors on one line, fixed-width numbers, timestamps as "ms ago" and angles with degrees.
  - A row flashes when its value changes. Vectors and State numbers don't flash, and the Flash toggle turns it off.
  - Freeze keeps the current values on screen, and Copy JSON copies the live data.
  - Several windows run side by side. A window stays open over a scene change when the next scene has a character with the same id.
  - The interval, flash and group states persist in `AEK_charStateWin`.
- `CharacterController.probes` (`CharacterProbes`): the controller's body plan, dimensions and collider roles, and its last floor ray and wall cast as it used them (`CharacterCastRecord`: origin, direction, stance, length, hit point and normal, and when the result arrived). Read-only diagnostics, written in place with no allocation per cast. Rejected wall hits and misses are kept too.
- Character debug gizmos, toggled in a second header row of the Character state window: velocity, velocity relative to a moving platform, facing, the ground normal (green walkable, red too steep), the floor ray (solid to the hit, dashed past it), the floor sensor (lit while grounded), the last wall cast (its cylinder and sweep, with the hit normal green when used as a wall and red when rejected) and a trail of the last ~2 s.
  - They start from the visual's pose of the frame being drawn, so they don't jitter against an interpolated mesh. Freezing the window freezes them too.
  - Drawn on top by default, with a Depth toggle, and a Scale for the velocity arrows (metres per m/s). The toggles, depth and scale persist in `AEK_charGizmos`.
  - Pin keeps a character's gizmos after its window closes, set from the window or from the character's row in the Characters tab. A pin is kept over a scene change when the next scene has a character with the same id (session only).
- `CharacterObject.initialConfig`: a frozen copy of the character's configuration (the `_` keys of its data) as it was created. `CharacterController.config` (`CharacterConfigHooks`): the keys sized into the body at creation (`bakedKeys`) and `onChange(key)`, which recomputes what is derived from a key written from outside (the dynamic character's `__maxWalkableAngleCos`).
- Live character config editing (debug), in the Character state window's Properties group:
  - Number values are edited in place (Enter or blur commits, ArrowUp/ArrowDown step, Shift ×10, Escape cancels), clamped and stepped per key, with the unit and the key's description in the tooltip. `_maxWalkableAngle` is edited in degrees. Booleans toggle with a click on their icon. Keys typed into an editor don't reach the game's key bindings (the F-keys still do).
  - The keys sized into the body at creation (`_height`, `_radius`, `_crouchHeight`, `_skinThickness`, `_groundDetectorOffset`, `_groundDetectorRadius`) are shown locked.
  - A value that differs from the creation-time one is marked and gets a reset button. The group's header shows the changed count, "Reset all" and "Copy changes" (a `charData` snippet of the changed keys, to paste into the scene's code).
  - Every edit, reset and Reset all is one undo step (`character.config`); a held arrow key is one.
  - Edits are saved per scene and character id in `AEK_debugCharConfig` (only the values that differ from the creation-time ones) and applied when the character is created, in the debug environment only. A saved row has a blue dot, and the window header shows the saved count with a clear button for that character. The Characters tab's clear button clears them for this scene or all scenes. Clearing leaves the live values as they are.
- `applySavedCharacterConfig(character)`: for controllers, applies the character's saved debug config values. Call it once, right after assigning `character.controller` (`createDynamicCharacter` does). A no-op outside the debug environment.
- `confirmClearScope`'s optional `note`, a second paragraph in the clear dialog.
- The character edit window (debug) shows `kind` and `controlMode`.
- The `circleCheckCutout`, `circleXCutout`, `pin` and `lock` icons, and the `$debugBoolTrue`, `$debugBoolFalse` and `$debugValueFlash` Sass colours.

**Changed**

- Breaking: the dynamic character moved from `utils/character/dynamicCharacter.ts` to `core/Character/DynamicCharacter.ts`, with the shared types in `core/Character/CharacterTypes.ts`.
- Breaking: `createDynamicCharacter` takes `DynamicCharacterOpts` (`id`, `name`, `visual`, `body`, `charData`, `input`, `onLocomotionStateChange`) and returns `{ character, data, intent, controlFns }`. `input` replaces `inputMappings`. The `sceneId` option and the `camera` return field are gone.
- Breaking: `CharacterObject`'s `keyControlIds`/`mouseControlIds` are `keyBindingIds`/`mouseBindingIds`, and `meshId` is `visualId`. `createCharacter` takes `visual` (an object with an entity, or its app id; was `meshOrMeshId`) and a required `kind`.
- Breaking: `controlFns` only write the intent. `move(direction)` and `rotate` lost their `delta` argument (the tick applies its sub-step delta).
- Breaking: `getCharacters()` returns an array (was an id → object map).
- Breaking: the character system registers itself (`Character.ts`, order -10 in `APP_PHYSICS_STEP`); `registerDynamicCharacterSystem` is gone.
- The move is a vector: speed holds through turns, with no lag between the velocity and the facing. Diagonals are normalized. Holding W+S cancels out and counts as no move input.
- Jump, run and crouch are applied by the tick, so a jump while moving in `WORKER_THREAD` mode is no longer overwritten by that sub-step's velocity write.
- `CharacterObject.data` is mutated in place: nested objects keep their identity, so re-read `data[key]`.
- The tick makes no `isMoving()` call each sub-step (an RPC per character in `WORKER_THREAD` mode), allocates nothing and doesn't round values. `isAwake` is derived from the velocities.
- The wall cast and the floor ray ignore sensors. The floor ray also runs while idle, with at most one in flight per character.
- `createCharacter` with an id already in use replaces the old character, with a warning.

**Removed**

- `deleteDynamicCharacter`.
- The config keys `_groundedRayMaxDistance`, `_tumblingAngDamping` (now `_tumblingAngularDamping`), `__wasOnMovingPlatformLastFrame` and `_roundVelocitiesScalingFactor`.

**Fixed**

- The capsule was the wrong size for anything but the default height and radius, so the collider didn't match the mesh.
- A second input-mapped character took over the first one's keys, and deleting either one removed both sets.
- `hasMoveInput` cleared when one move key was released while another was still held.
- The get-up torque never eased in after the first minute of a session.
- `CharacterObject.data` was always `{}`, so the debug tracker showed an empty list.
- Holding W+S ran the move twice per sub-step.
- A character could cross or stand on slopes steeper than `_maxWalkableAngle`. It now slides down them, pushed by `_slopeSlideSpeed`.
- A sensor in front of a wall cancelled the wall slide, the wall cast was off-centre while crouching, and all characters shared one wall-hit result.
- `controlFns` kept writing to the body after the character was deleted, which crashed Rapier in `MAIN_THREAD` mode.
- `ShapeCastHitAPI`'s docs had the witness and normal pairs the wrong way round: `witness1`/`normal1` are on the hit collider, in world space.

### Toolkit 1.2.0 (Crescent)

**Added**

- `SunShadowFit` (`ecs/effects/SunShadowFit.ts`, `registerSunShadowFitEffect`): a `SUN_SHADOW_FIT` component on a directional light fits its shadow camera to the main camera's view, up to `maxDistance`, plus `casterExtension` toward the sun. The fit is snapped to shadow texels and written only when it changes. Optional: `cameraEntityId`, `followEntityId`, `direction` (setting it turns the sun), `lightDistance` and `snapToTexels`. It skips non-directional lights and managed ones (like the sky box's sun), with a warning.
- `generateTerrain`'s `heightModifier(x, z, h)` option, applied per vertex so the mesh, `heights` and `getHeightAt` agree.

### App 1.4.0 (Preschooler)

**Added**

- `topDownTest` scene: a `WORLD_FIXED` character on a 300 × 300 ground with hills on the East side (`generateTerrain` with a `heightModifier`, a TRIMESH collider), 15 seeded static obstacles and 25 dynamic props. The follow camera looks from the South, so W moves straight up the screen, and `SunShadowFit` keeps the sun's shadow over the view.
- `characterVisual.ts` (`createCharacterVisual`): the capsule-and-beak character visual, used by the gym and the top-down scene.
- `SunShadowFit` is registered in `AppECSPlugins.ts`, and `AppECSRegistry.ts` has its component and `APP_RENDER_SYNC_ORDER.SHADOW_FIT` (-0.75: after the camera rigs, before frustum culling).

**Changed**

- The gym uses the new character API. The player is `TANK` on WASD. A second character, `arrowKeysChar`, is `CAMERA_RELATIVE` on the arrow keys, with Enter to jump. The dummy writes its intent from an `APP_PHYSICS_STEP` system.
- `AppECSPlugins.ts` no longer registers the character system (the engine does).

## 2026-09-29 — skybox-overhaul

### Engine 3.0.0 (Zenith)

**Added**

- Layered sky box definitions (`SkyBoxDef`): a `base` layer (`COLOR`, `EQUIRECTANGULAR` or `CUBE_TEXTURE`, with `rotate`, cube `flipY` and `intensity`) and an `env` layer (`backgroundRoughness`, `backgroundIntensity`, `environmentIntensity`, and the env bake's `size`, `dynamic`, `updateAngleDeg` and `maxUpdatesPerSec`). `preset` names a template (see Presets below).
- Procedural sky layers: `atmosphere` (Preetham scattering, a port of three's `SkyMesh`, with a sky-only `exposure`, `sunIntensity`, `twilightLength`, `nightSkyColor` and horizon/zenith tints), `suns[]` (disc and halo; `suns[0]` drives the atmosphere), `clouds` (SkyMesh's, with a tint and wind direction; they need the atmosphere) and `ground` (the lower hemisphere's colour, with a `height` and aerial perspective). A layer is on when its key is there, unless it says `enabled: false`.
- Sky boxes with a procedural layer composite every layer into one background node and bake their environment from it (`fromScene` into a fixed target, at most once per frame and never while a scene loads). `env.size` is 64, 128, 256 or 512; `env.dynamic: false` bakes only on activation, rebuilds and `bakeEnvironment()` (new). Texture-only and colour-only sky boxes are unchanged.
- Sky lights: `suns[i].light` adds a directional light that follows the sun (AUTO colour from the atmosphere, fading out below the horizon, shadows following the active camera snapped to shadow texels), and `ambientLight` a hemisphere or ambient light (off by default). Both are ordinary ECS lights.
- Day-night cycle (`dayNight`): the sun and moon are placed from a time of day (latitude, day of year, axial tilt, north offset), and the stars turn with the sky. It advances with the app loop by default (`timeSource: 'APP' | 'MAIN' | 'MANUAL'`) and is driven at runtime with `setTimeOfDay`/`getTimeOfDay`, `playDayNight`, `pauseDayNight`, `isDayNightPlaying`, `setDayNightSpeed`/`getDayNightSpeed` (negative runs it backwards) and `setDayNightCycleDuration`. `getSunDirection`, `getSunElevation`, `getMoonDirection` and `getMoonPhase` read the sky. Nothing is allocated per frame while it plays.
- While the cycle moves, the environment re-bakes once the sun or moon has turned `env.updateAngleDeg` (default 1°), at most `env.maxUpdatesPerSec` (default 1) times a second, and once more when it stops or reverses. `env.size` defaults to 128 with day-night.
- `moons[]`: a disc lit into its `phase` (fixed, or `phaseMode: 'CYCLE'` over `lunarCycleDays`), with earthshine, limb darkening and an optional `texture` (`DISC` or `EQUIRECTANGULAR`). `moons[i].light` is a managed directional light that only shines at night (scaled by the lit fraction; no shadow by default). Clouds get moonlight at night.
- `stars`: procedural stars (cube-projected, two grids, colour temperatures, twinkle), faded in through twilight by `fadeRange` and turning with the sky, with an optional `milkyWay` band. They cost nothing by day and are never baked.
- `isAppPlaying()` in `MainLoop.ts`: a cheap per-frame read of whether the app loop plays.
- Sky box debug tab: a Day-night folder (a runtime transport: play, ×−10…×100 speed buttons, a speed slider, a time scrub that pauses while dragged, and readouts; and the cycle's config), Moons (with a Light subfolder) and Stars folders, and a bakes-per-second readout.
- Managed entities: `CoreEntityOpts.managedBy` (code only) adds the new `MANAGED_BY` component. A managed light gets no saved debug overrides, and the Lights tab shows it read-only with a link to its manager's tab.
- `openDebuggerTab(id)`.
- Sky box debug tab: Suns (with a Light subfolder), Atmosphere, Clouds, Ground and Ambient light folders, and env bake settings and stats (bake count, CPU and GPU ms) in the Environment folder.
- Sky box API in `core/SkyBox/SkyBox.ts`: `registerSkyBox`, `setActiveSkyBox`, `getActiveSkyBox`, `updateSkyBox`, `activateSceneDefaultSkyBox`, `getSceneDefaultSkyBoxId`, `getActiveEnvironmentTexture` and `onSkyBoxChange`, plus the `SkyBoxDef` and `ActiveSkyBox` types.
- `gatherAppData` validates `*.skybox.json` files and inline scene sky boxes, keeps their `debugData` outside production, and deep-merges a scene's save entry into the definition.
- Sky box debug tab: Base and Environment folders (each with "Reset layer"), Copy JSON, and a clear button for the stored edits. Edits persist per scene and sky box, and only the values that differ from the definition are stored. Undo/redo covers every value, layer resets and the selection.
- `utils/deepMerge.ts`.
- `nebulae[]` (up to 8): procedural nebulae (`seed`, `direction`, `size`, `falloff`, `stretch`/`orientation`, 2–3 colour stops, `density`, `octaves`, `warp`, `dust` lanes, `brightness`). They are baked into one HalfFloat cube (`env.nebulaSize`: 256, 512 (default) or 1024 per face, no mipmaps) only when they change, at most once per 150 ms while a value is dragged, and the sky samples it with one lookup. They turn with the sky under day-night, and the env bake samples the same cube, so reflections take their colours. `starBoost` adds live stars inside a nebula.
- Up to 4 suns and 2 moons. An extra sun is a disc and glow with an `AUTO` or hex `color` and an optional managed light (no shadow by default); with day-night, `rotateWithSky` (default true) turns it with the sky from where it stands at the start time. `moons[1]` is a second orbit with its own phase. `suns[0]` still drives the atmosphere, the stars' fade, the clouds, the ground and the ambient light. `getSunDirection`, `getSunElevation`, `getMoonDirection` and `getMoonPhase` take an index (default 0). The debugger warns when more than two sky lights cast shadows.
- Presets: `preset: 'DAY_SKY' | 'NIGHT_SKY' | 'DAY_NIGHT' | 'SPACE'` (template version 1). The definition's keys merge over the template, and its arrays and `base` replace the template's. `gatherAppData` resolves JSON presets at build time, so the runtime only sees plain definitions; code definitions go through `resolveSkyBoxPreset`. `base` is optional with a preset. SPACE is a near-black base, dense always-visible stars, one sun with a light and two nebulae, with no atmosphere, ground or clouds.
- Sky box debug tab: a Nebulae folder (the nebula creator: a list with add at view, duplicate and remove; every param; "Randomize seed"; "Point at view"; and the nebula cube's size, memory and bake stats), Suns and Moons lists, and "Apply preset" (undoable, `skybox.applyPreset`). List edits are one undo step each.
- Scene-scoped debugger tabs: `createDebuggerTab({ sceneId })` removes the tab when that scene exits. If the tab was open, the drawer opens it again when the scene re-creates it, including after a reload.
- `hydrateDebuggerTabState` is exported, for values a module needs before its tab registers.
- Debug environment ball: a reflective sphere left of the axes gizmo that shows the environment map PBR materials sample (not the background) and turns with the active camera. Debug Tools → Helpers: "Show environment ball [F9]", "Show env ball in main camera" and "Env ball roughness" (persisted in `AEK_debugTools`).
- Debug shortcuts: F5 plays in production test mode, F6 toggles the main loop and F7 pauses or plays the app loop (both with a toast), F9 toggles the environment ball. With the main camera active, F9 and F10 on a hidden gizmo also turn on its "in main camera" option, and every gizmo toggle shows a toast. All of them can be rebound through `AppConfig.debugKeys`. Undo/redo toasts show the undo or redo icon.
- Production test mode keys: F5 stops production test mode, F6 toggles the main loop and F7 pauses or plays the app loop (no toasts). Each gives way to an app binding of the same key.
- `yieldToOtherBindings` on `KEY_UP`/`KEY_DOWN` key bindings: the binding doesn't fire for an event another binding also fires for.
- `registerPhysicsAPIDebugGUI()`: loads the Physics API debug module and restores its saved world settings before the first physics world is created (`InitEngine` calls it).

**Changed**

- Breaking: the sky box module moved from `core/SkyBox.ts` to `core/SkyBox/SkyBox.ts`.
- Breaking: `createSkyBox` takes a `SkyBoxDef`. The legacy `{ type, params }` props and JSON still work, with a dev warning. `isCurrent` becomes `isDefault`, `params.roughness` becomes `env.backgroundRoughness`, and `rotate` is in radians (the legacy cube rotate was a multiple of π).
- Sky boxes use three.js's standard orientation, and the background and the environment sample the same direction. Legacy definitions convert to `rotate: π` (equirect) or `flipY: true` (cube), which keeps their look. A cube's `flipY` now turns it upside down (a half turn about X).
- Activating a sky box sets `scene.environmentIntensity`, `backgroundIntensity` and `environmentRotation` from its definition; clearing resets them.
- The debug localStorage key `AEK_debugSkyBoxStates` is replaced by `AEK_debugSkyBox`. A saved background roughness is migrated once, and the old key is removed.
- `deepMerge` merges an index object (`{ "0": { ... } }`) into an array by index instead of replacing the array.
- The PostFX profiler's GPU timing moved to a shared debug timer (`_dbg__GPUTimer.ts`), also used by the env bake stats.
- `createPhysicsAPIDebugGUI()` is synchronous and needs `registerPhysicsAPIDebugGUI()` first.
- The axes gizmo shortcut moved from F8 to F10.
- Debug Tools → Helpers: the environment ball options come before the axes ones.

**Removed**

- `defaultRoughness`, `defaultSkyBoxState`, `SkyBoxState`, `SkyBoxProps` (now `LegacySkyBoxProps`), `LS_KEY_ALL_STATES`, `NO_SKYBOX_ID`, `extractSkyBoxParamsFromState`, `getEnvMapRoughnessBg`, `getCurSceneSkyBoxSceneId`, `deleteCurrentSkyBox` (use `setActiveSkyBox(null)`) and `applySkyBoxForScene`.
- `DebugToolsState.env` (the unused env ball state).
- `PROJECT_METADATA.mergeVersion` (deprecated in 2.1.0).

**Fixed**

- Materials got no view-dependent reflections and ignored their own roughness: the environment was sampled with the background's direction and roughness. Scenes can look more reflective; tune `env.environmentIntensity`.
- Cube sky boxes didn't light materials at all, and equirect lighting came in upside down relative to the background.
- A non-HDR equirect's `path` was dropped, a roughness of `0` was lost, and an empty `colorSpace` wasn't treated as unset.
- An equirect's orientation depended on where its texture loaded (main thread or assets worker).
- Sky box selections in the debugger could race each other.
- `setCurrentScene` didn't reset the root scene's `environmentNode`.
- `createRigidBody` ignored `gravityScale: 0` (a falsy check), so such a body still fell.
- The Physics API tab's saved world settings (gravity, timestep, solver iterations) were pushed into the running world after the start scene had loaded, overwriting what the scene set. They are now restored before the first world is created, and every world is built from them.
- While the drawer showed a fallback tab, its scroll position overwrote the saved tab's.

### Toolkit 1.1.0 (Crescent)

**Added**

- `generateAsteroid` (`geometry/generateAsteroid.ts`): a seeded, semi-low-poly asteroid (`radius`, `detail` 1–10, `seed`, `shape`, `noise` lumps, `craters` with raised rims, `flatShading`). It returns the `geometry`, the `hullVertices` for a `CONVEXHULL` collider, `volume`, `hullVolume` (what Rapier's mass uses) and `boundingRadius`.
- The `asteroid` material (`materials/asteroid.material.json` + `asteroid.tsl.ts`): procedural object-space mottling, pits and speckles, with roughness and a derivative bump from the same field. Every input sits on `colorNode`, so one `seed` override changes the colour, roughness and bump together.
- `MutualGravity` (`ecs/effects/MutualGravity.ts`): N-body gravity between dynamic bodies, in `APP_PHYSICS_STEP`, with Plummer softening, each pair computed once and no per-step allocations. `registerMutualGravityEffect`, `addGravityBody`/`removeGravityBody`/`clearGravityBodies`/`getGravityBodies` and `setMutualGravityConfig`/`getMutualGravityConfig`/`getMutualGravityDefaults` (`G`, `softening`, `enabled`). Its bodies are cleared on scene exit. It isn't deterministic in `WORKER_THREAD` mode.

### App 1.3.0 (Preschooler)

**Added**

- `skyShowcase` scene: a `dayNight` sky box with every procedural layer on a 5-minute day, rows of metal and dielectric PBR spheres (roughness 0 to 1) and a stone gate that casts long shadows. It is the verification scene for the sky box plans.
- `scene01_v2`: a row of PBR spheres (roughness 0 to 1) that show the environment.
- `space` scene: the `space` sky box (SPACE, plus a small blue second sun) around four procedural asteroids with zero world gravity and mutual gravity. Three start on loose orbits round the biggest, and one falls in to hit it. In the debug env, the scene's own "Space demo" tab has the gravity's G, softening and on/off, "Reset asteroids", "Spawn asteroid", the group's energy and an asteroid list.
- The showcase also lists the `space` sky box, to check the nebula reflections on its spheres.
- `MutualGravity` is registered in `AppECSPlugins.ts`.

**Changed**

- The app's sky boxes (`scene01`, `scene01_v2`, the gym and `basicSkybox.skybox.json`) use layered definitions, with the same look.
- `dayNight.skybox.json` uses `"preset": "DAY_NIGHT"` plus its own cycle, with the same look.
- The gym's environment intensity is set in its sky box definitions (`env.environmentIntensity`) instead of by hand on scene enter and exit.

## 2026-09-30 — add-on-screen-tools-disabler-settings

### Engine 2.3.0 (Morning)

**Added**

- "Disable on-screen tools" (debug only): the on-screen tool groups, the debug drawer handle, the stats panel and the axes gizmo become click-through, so clicks and drags reach the canvas under them. All but the gizmo (which renders into the canvas) are dimmed to a configurable opacity. Keyboard shortcuts and the drawer contents keep working. It is applied at boot, before the first scene load, and set with a body class (`aekOnScreenToolsDisabled`) and a CSS variable (`--aek-disabled-on-screen-tools-opacity`), so rebuilt tool groups keep it.
- The `§` debug shortcut (`sc-toggle-on-screen-tools`, rebindable through `AppConfig.debugKeys`) toggles it and shows a toast naming the key that was pressed. It also matches with modifiers held, for layouts where § is a shifted key.
- `toggleOnScreenToolsDisabled()` (`debug/DebugToolsManager.ts`).
- The axes gizmo slot has a global class, `aekAxesGizmoSlot`.

**Changed**

- The Debug Tools Controls tab's "Production test mode" folder is now "On-screen tools". It holds "Disable on-screen tools [§]", "Disabled on-screen tools opacity" and the existing prod test switch.
- `DebugToolsState.prodTestMode` is replaced by `onScreenTools` (`showOnScreenToolsInProdTest`, `disableOnScreenTools`, `disabledOnScreenToolsOpacity`). A saved `prodTestMode` is migrated on load and written back right away.
- The on-screen tool groups, the drawer handle and the stats panel fade their opacity changes (0.2s).

## 2026-09-29 — ray-casting-refactoring

### Engine 2.2.0 (Morning)

**Added**

- `castRayFromDirection(objects, origin, direction, opts?)` (what `castRayFromPoints` used to do).
- `RayCastOpts` (exported): `near`, `far`, `target`, `perIntersect` (return `false` to stop), `countInStats` and `debug` (`RayDebugOpts`: `id`, plus optional `color`, `inactiveColor`, `width`, `holdMs`, `fadeOutMs`, `showHit` and `depthTest`).
- Opt-in screen-space dashes for thick lines: `LineProps.dash` (`{ dashPx, gapPx }`, fixed at creation, FAT backend only) and `LineObject.setDash(dashPx, gapPx)`, a uniform write where a gap of 0 draws solid. The pattern restarts at each segment. Lines without `dash` keep their exact shader.
- Ray cast controls tab: a "Three.js rays" folder with the helper settings (show, show rays without an id, force kind colors, active and inactive color, width, hold, fade out, dash and gap), applied live and persisted.
- Ray cast statistics API, now in the core (it used to live in the debug module): `setRayCastStatsEnabled`, `isRayCastStatsEnabled`, `getRayCastStats` (one reused snapshot object, rays per rendered frame) and `resetRayCastStats`.
- `IntervalCounterStats` (`utils/stats/`): an allocation-free per-frame counter with rolling min/max and average windows.
- `createPercentagePie()`: a pie CMP updated with `set(percentage)`.
- Physics query statistics (`PhysicsAPI.ts`): `setPhysicsRayStatsEnabled`, `isPhysicsRayStatsEnabled`, `getPhysicsRayStats` (one reused `PhysicsRayStats` object: rays and shape casts per rendered frame, counted when issued, plus `pendingQueries` waiting for a worker reply) and `resetPhysicsRayStats`, reset on every scene enter.
- Physics queries can be drawn as `'PHYSICS'` ray helpers (debug only, `setPhysicsRayHelpersEnabled`). The line appears when the query is issued and gets its hit when the result arrives, about a frame later in `WORKER_THREAD` mode.
- An optional trailing `debug?: RayDebugOpts` parameter on `castRay`, `castRayAndGetNormal`, `intersectionsWithRay` and `castShape` (and their `*Sync` forms). It stays on the main thread.
- `PhysicsQueryObserver`/`PhysicsQueryKind`, and `EngineAPIType.setQueryObserver`, which a physics backend must now implement. With nothing observing, a query costs one null check, and the worker's engine never observes.
- Ray cast controls tab: a "Physics rays" folder with the same helper settings, an "Enable physics ray statistics" toggle and the physics stats (rays, shape casts and, in `WORKER_THREAD` mode, pending queries), persisted.
- `RAY_STATS_WINDOWS`: the stats windows shared by the Three.js and physics ray counters.
- A "Respect depth" helper setting per ray kind (Three.js and physics folders, persisted): geometry in front then hides the helpers. Off by default, so they still draw on top. A ray's `debug.depthTest` overrides it.
- `dynamicCharacter`'s floor ray and wall cast carry helper ids (`char_floor_<entityId>`, `char_wall_<entityId>`).
- Ray tester windows (debug only), opened from two new buttons in the Ray cast controls tab. The Three.js ray tester casts through `castRayFromDirection`/`castRayFromPoints` into the current scene or one entity. The physics ray tester runs `castRay`, `castRayAndGetNormal` or `intersectionsWithRay` in either `workerTarget` mode, with filter flags, filter groups and exclude-by-app-id. Each has three aim modes (origin + direction, origin → target point, active camera forward), its own helper settings, and a Fire button. The results list each hit's distance or toi, point, normal and entity/app id, with copy as JSON. The origin and target point can be picked with a click on the scene.
- The ray testers' params are saved per scene (`AEK_debugRayTester`), with a clear button in each window and one for both in the Ray cast controls tab. The tester state holds a list of rays, ready for multi-ray patterns.
- `RAY_TESTER_ID_PREFIX` (`'rayTester_'`): physics queries whose `debug.id` starts with it are drawn but not counted in the physics ray statistics.

**Changed**

- `castRayFromPoints(objects, from, to)` is point-to-point: `to` is the end point (it was treated as a direction), and hits beyond it are left out.
- `near`/`far` (and the deprecated `startLength`/`endLength`) are applied by the raycaster, so they filter the returned hits too, not only the per-hit callback. A passed `target` array is cleared before it is filled.
- The ray cast statistics count rays per rendered frame (frames skipped by the FPS limiter are no longer counted as frames).
- The Ray cast controls tab updates its statistics from cached elements five times a second while the tab is visible, instead of re-rendering the block every frame. The max and min rows are merged into one "max / min" row per window.
- `PercentagePieHtml` renders one element (a CSS conic gradient) instead of seven nested ones.
- `castRayFromAngle` no longer allocates a vector per cast.
- The Ray cast controls tab's Three.js stats heading is "Three.js ray stats:".
- `filterPredicate` on the physics query methods is documented as not supported yet (it was always ignored).
- Ray debug helpers are pooled thick lines with a hit cross, drawn by a shared renderer (`core/Debug/_dbg__RayHelpers.ts`, ready for physics rays). A helper stays solid for a hold time after its last cast, then turns dashed in the inactive color and fades out, instead of being disposed the first frame its ray isn't cast. Rays without an id can be shown too. `deleteAllRayHelpers()` hides and recycles them. The persisted `showAllRayDebugHelpers` toggle is migrated to the new `threeShow` setting.

**Deprecated**

- The `RayCastOpts` aliases `helperId`, `helperColor`, `startLength`, `endLength`, `perIntersectFn` and `optionalTargetArr` (use `debug.id`, `debug.color`, `near`, `far`, `perIntersect` and `target`).
- `PercentagePieHtml`'s `size` option (it has no effect).

**Removed**

- `countRayCastFrames` and `cleanUpRayHelpers` (internal plumbing).

**Fixed**

- `PercentagePieHtml` joined extra classes with a comma.
- The ray helper cleanup ran once per ECS world each frame instead of once.
- `castRayAndGetNormal` in `WORKER_THREAD` mode returned the raw worker message instead of the hit, with an unmapped collider id, and dropped the exclude filters. **Behavior change:** the character controller now really evaluates ground slopes in worker mode (its floor normal was always read as flat) and its floor ray no longer hits its own body.
- `intersectionsWithRay` threw in `WORKER_THREAD` mode (the worker replied with `hits` instead of `intersections`), and it ignored a callback returning `false`.
- The physics `pendingQueries` count was lowered by the results of queries it never counted (eg. issued while the statistics were off, with the physics helpers on).

## 2026-09-29 — spatial-index-system-visualizer

### Engine 2.1.0 (Morning)

**Added**

- Spatial index visualizer in the "Spatial index" debugger tab: wireframe boxes for the occupied grid cells and, separately, for the oversized tier's members, each with its own checkbox and color picker (persisted).
- `SpatialGrid.cellSize`, `SpatialGrid.getOccupiedCellBoundsInto(out)` and `SpatialGrid.getOversizedBoundsInto(out)`.
- `PROJECT_METADATA.toolkit`, the `x-toolkit` meta tag, the `%TOOLKIT_*%` HTML placeholders and a toolkit line in the boot console log.
- Optional `engineVersion`/`toolkitVersion`/`appVersion` in save data `__meta`. `gatherAppData` warns when an applied save entry was stamped under another major version.

**Changed**

- The version checksum also covers the toolkit version and codename, and no longer includes the merge version (existing checksum values change once).
- The boot log no longer writes versions into `#engineVersion`/`#appVersion` DOM elements (they no longer exist).

**Deprecated**

- `PROJECT_METADATA.mergeVersion`, to be removed in the next major version. The `x-merge-version` meta tag is removed.

**Fixed**

- The physics debug wireframe of heightfield colliders was drawn with the wrong layout (sheared and transposed).
- A heightfield collider's column count was read from `nrows`, which broke non-square heightfields.

### Toolkit 1.0.0 (Crescent)

**Added**

- Versioned on its own for the first time (`toolkit_metadata` in `package.json`; it was previously covered by the engine version). Its codenames follow the moon's phases.
- Included in the `yarn docs` TypeDoc output.

### Project

**Added**

- `yarn checkVersions` checks the versioning rules; `--against main` also checks each part's bump. The Stop hook runs the base check whenever `package.json` changes.
- `yarn tagRelease` tags a merge on `main` per part (`engine-v…`, `toolkit-v…`, `app-v…`).
- This changelog.
