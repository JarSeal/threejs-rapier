Status: backlog | not-implemented
Category: Backlog

# Follow-ups From Done Plans — Backlog

Not a plan. The open follow-ups, known limitations and deliberately deferred items of implemented plans whose files were removed (2026-10-01), kept here so they aren't lost. Items that belong to an open plan were moved into that plan instead (p059's probe method → p063, p101's open questions → p500, the p027/p140/p142 stats sources → the p220 profiler prompt in `docs/templates/todo-plan-prompts.txt`).

Each item names the plan it came from; the full plan text is in git history (e.g. `git log --all -- 'docs/plans/_DONE_p059_*'`, then `git show <commit>^:<path>`). `_DONE_p050_spatial-index.md` was kept as is: the engine's runtime warnings link to it, and it holds the deferred spatial index optimizations. Re-check an item against the code before acting on it. When an item gets its own plan or is fixed, delete it here; delete this file when it's empty.

## Physics and interpolation

- **`NONE` interpolation shows each step one frame late** (p059). `object3DSyncSystem` copies TRANSFORM → Object3D at `MAIN`, before physics writes that frame's pose. Syncing the mesh after physics would remove it; it was left as is so `NONE` stays byte-identical to the old behaviour.
- **The Physics API tab's position editor streaks once under interpolation** (p059). It doesn't go through `setTransform`, so the interpolation history isn't reset.
- **`FIXED_PHYSICS` + worker at matched 60/60 Hz has ~17% jitter** (p059, headless). The pairing is unsupported and warned about.
- **Unchanged p059 non-goals**: `FollowTool`'s write-direction lag, smoothing `camera.lookAt`, an `EXTRAPOLATION` interpolation mode.

## Ray casting and physics queries

- **A batched physics query message** (`WORLD_QUERY_BATCH`, p142/p143) if gameplay or a multi-ray tester needs many queries per frame in `WORKER_THREAD` mode.
- **Ray tester extensions** (p143): multi-ray fire patterns (fan, grid, cone) on the existing `rays[]` state, a shape-cast tester (`castShape`) with a shape outline helper, and `countInStats` on `PickOpts` (`Input/InputPicking.ts`) so a tester's pick click isn't counted as a Three.js ray.
- **Remove the deprecated `RayCastOpts` aliases** (p140, the `@deprecated` fields in `core/Raycast.ts`) in a later major release.

## Debugger undo/redo

- Physics-object and character pose undo restores the pose only (p061): velocity isn't rolled back, and whatever drives the body keeps doing so (e.g. `thirdPersonGym`'s `dummyCharLooper`).
- Undo doesn't refresh the staged position/rotation fields of the physics-object and character edit windows (p061).
- Entities with generated app ids aren't recorded, since they can't be found again after a reload (p061).
- The 800 ms coalescing window is an untuned default (p061).
- Recordable but not wired (p061): the renderer's tone mapping exposure and device pixel ratio, and the physics global timestep (open question: do global perf/timing knobs belong in undo history at all?).
- The Debug Tools tab's "clear LS" button clears `AEK_debugTools` but not `AEK_debugUndoRedoSettings` (p062).
- "History size (per scene)" is per bucket, so the merged timeline (scene bucket + `'_global'`) can hold up to twice that many entries (p062).
- Toasts stack on rapid repeated undo/redo, one per action, with no collapsing (p062).

## Sky box

- **Retune the default day sky** (p112): with the sun at 30° it is very pale toward the horizon, and the default ground colour (`#3b3a36`) reads as nearly black against it. Both are SkyMesh's defaults and were never retuned. A preset change is a visible change: bump its template version and note it in the changelog.
- **three.js upgrades** (p110): `layers/atmosphere.ts` is a port of `examples/jsm/objects/SkyMesh.js` (r186, recorded in its header). On a three upgrade, diff that file and re-check the sky against SkyMesh side by side.
- **Deferred epic ideas** (p110 non-goals): auto-exposure / eye adaptation for night scenes (a PostFX pass), a precomputed-LUT atmosphere layer (Hillaire 2020 multiple scattering), volumetric 3D clouds and weather (the surface side of weather, i.e. wetness, puddles, rain ripples and snow coverage as global state that materials read, is planned in `p307_wet-and-dry-surface-states.md`; precipitation, clouds and a weather driver remain open here), day-night events (`onSunrise` / `onSunset`; today games poll the getters), a JSON write-back endpoint (the Skybox tab's "Copy JSON" covers authoring), the sky in viewports other than the env ball, sky boxes in secondary ECS worlds.
- **A lit material-preview env ball** (p115): a metal and dielectric pair next to the unlit ball. Overlaps with the material editor (p084).

## Bundle size and rendering

- **The line core (~12 kB) ships in production** although the app draws lines only in debug tooling (p058). Registering the line time system on the first `createLines` and having `LineManager` hook into scene teardown itself (instead of `SceneLoader` importing `disposeNonPersistentLines`) would make it ~0 for apps that don't draw lines.
- **Every SVG icon's raw string is in the main chunk** (p071, ~0.5 kB per icon), because `SvgIcon.ts` imports them all statically and is imported by always-bundled code. Fixing it means restructuring the icon registry for all icons.
- **More PostFX passes** (p070/p071): bloom, DoF, FXAA/SMAA/TRAA, SSR, god rays, … each a small follow-up on the existing pass registry (`core/PostFX.ts`); an AA pass also fixes the MSAA + screen-space AO edge problem (`docs/analysis/ambient-occlusion-options.md`). A per-pass stats readout (`getPostFxPassStats()` is console-only today) fits the p220 profiler.
- **Viewports** (p080): in the scene/asset JSON schema, and a debugger tab listing them.

## Debugger drawer

- **Migrate the draggable edit windows to the declarative pane builder** (p105). Their undo, scene and LS logic is the hard part (see p150).
- **Row-level patching for large `debuggerListCMP` lists** (p105): a toggle re-renders the whole list, O(n) for the large ECS test world's physics entities.
