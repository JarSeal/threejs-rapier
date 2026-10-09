Status: backlog | not-implemented
Category: Backlog

# Follow-ups From Done Plans — Backlog

Not a plan. The open follow-ups, known limitations and deliberately deferred items of implemented plans whose files were removed (2026-10-01; the character debugging plans p067-p069 and the Ækasha Hub epic p550-p555 on 2026-10-09), kept here so they aren't lost. Items that belong to an open plan were moved into that plan instead (p059's probe method → p063, p101's open questions → p500, the p027/p140/p142 stats sources → the p220 profiler prompt in `docs/templates/todo-plan-prompts.txt`, p555's readme question → p621).

Each item names the plan it came from; the full plan text is in git history (e.g. `git log --all -- 'docs/plans/_DONE_p059_*'`, then `git show <commit>^:<path>`). `_DONE_p050_spatial-index.md` was kept as is: the engine's runtime warnings link to it, and it holds the deferred spatial index optimizations. Re-check an item against the code before acting on it. When an item gets its own plan or is fixed, delete it here; delete this file when it's empty.

## Physics and interpolation

- **`NONE` interpolation shows each step one frame late** (p059). `object3DSyncSystem` copies TRANSFORM → Object3D at `MAIN`, before physics writes that frame's pose. Syncing the mesh after physics would remove it; it was left as is so `NONE` stays byte-identical to the old behaviour.
- **The Physics API tab's position editor streaks once under interpolation** (p059). It doesn't go through `setTransform`, so the interpolation history isn't reset.
- **`FIXED_PHYSICS` + worker at matched 60/60 Hz has ~17% jitter** (p059, headless). The pairing is unsupported and warned about.
- **Unchanged p059 non-goals**: `FollowTool`'s write-direction lag, smoothing `camera.lookAt`, an `EXTRAPOLATION` interpolation mode.

## Ray casting and physics queries

- **A batched physics query message** (`WORLD_QUERY_BATCH`, p142/p143) if gameplay or a multi-ray tester needs many queries per frame in `WORKER_THREAD` mode.
- **Ray tester extensions** (p143): multi-ray fire patterns (fan, grid, cone) on the existing `rays[]` state, a shape-cast tester (`castShape`) with a shape outline helper, and `countInStats` on `PickOpts` (`Input/InputPicking.ts`) so a tester's pick click isn't counted as a Three.js ray.

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

## Rendering

- **More PostFX passes** (p070/p071): bloom, DoF, FXAA/SMAA/TRAA, SSR, god rays, … each a small follow-up on the existing pass registry (`core/PostFX.ts`); an AA pass also fixes the MSAA + screen-space AO edge problem (`docs/analysis/ambient-occlusion-options.md`). A per-pass stats readout (`getPostFxPassStats()` is console-only today) fits the p220 profiler.
- **Viewports** (p080): in the scene/asset JSON schema, and a debugger tab listing them.

## Debugger drawer

- **Migrate the draggable edit windows to the declarative pane builder** (p105). Their undo, scene and LS logic is the hard part (see p150).
- **Row-level patching for large `debuggerListCMP` lists** (p105): a toggle re-renders the whole list, O(n) for the large ECS test world's physics entities.

## Characters

- **`isMovingTowardsImpossibleSlope` is a dead field** (p067): `CharacterData` declares it (`core/Character/DynamicCharacter.ts`), but nothing writes it, and the character state window shows it as it is. Implement it or remove it (p610 restructures the controller).
- **Rebuilding the body for baked config keys** (p069's Phase 4, dropped): the character state window keeps the keys baked into the colliders (`config.bakedKeys`, eg. `_radius`) locked. A rebuild swaps the colliders in place (async in `WORKER_THREAD` mode; `PhysicsManager` has no helper that adds colliders to an existing entity), must keep the character on a moving platform, and must rebuild back on undo. Saved values are applied after the colliders exist, so saved baked values would need a rebuild right after creation, or to be read before `getDimensions` and kept out of `initialConfig`. The app owns the visual, so a resized capsule wouldn't match the model.
- **Saving tuned character values into the scene source** (p069): there's no character JSON schema yet, so the state window's copy-out (as code) is the bridge.
- **Configurable character gizmo colours** (p068): they're constants (`GIZMO_COLORS` in `core/Debug/Character/_dbg__CharacterGizmos.ts`).

## Ækasha Hub

- **The first real deploy** (p550, p551): check that the host's CDN keys its cache on the `?v=<hash>` query strings the Hub's `_assets/` references carry (`_headers` caches them as immutable). If it ignores them, switch to hashed file names. A host other than Netlify needs its own headers file.
- **A ringed-planet mark?** (p550): the homepage design's logo is a ringed planet, the brand's is the Æ. A combined mark (the Æ inside a ring) is a brand decision.
- **A standalone `yarn hub:dev`** (p551): the Hub's dev plugin in a bare Vite server, for content work without the engine's dev server. Not needed while `yarn dev` starts quickly.
- **A shared nav partial** (p551): every page renders its own copy of the nav. If a full rebuild gets slow with the API pages, the nav could become a partial the pages include.
- **Type hovers in code blocks** (p552): shiki's twoslash, checked against the real types. Heavy (a TS program per block), and the engine's types must resolve from a snippet. Worth a spike.
- **"Open in example scene" on an included snippet** (p552): a dev-only button that opens the scene the snippet comes from (`?startScene`).
- **The API docs** (p553): drop `yarn docs` / `docs-api/` once the Hub's Documentation covers everything it shows. Few engine files have a `@module` comment, so module summaries fall back to the first symbol's. A `@category` tag could group cross-folder APIs (input, UI) by subsystem instead of folder.
- **Leave the example scenes out of production builds?** (p554): they're in the app's scene list in every build. An `isExample` scene flag (like `isDebugScene`) could leave them out of the production data.
- **Live examples in the public Hub** (p554): the public Hub runs no engine, so its scene panels say how to run a scene locally. Hosting the built app next to it would make the "Open" links work there too.
- **More examples** (p554, p555): input and key bindings, characters, viewports, PostFX, the material editor, the spatial index. The Spatial index, Viewports and views, and Characters feature pages have no example scene; they point at app scenes (`physicsTiers`, `skyShowcase`, `space`, `thirdPersonGymScene`, `topDownTestScene`).
