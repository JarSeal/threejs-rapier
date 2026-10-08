# Changelog

One entry per branch merged to `main`, newest first, written in that branch's PR next to its version bumps (see "Versioning" in `.claude/CLAUDE.md`). Each entry has a section per part that changed: **Engine** (`src/_engine/`), **Toolkit** (`src/toolkit/`) and **App** (`src/app/` and the app-level files in `src/`). **Project** covers repo tooling that belongs to none of them. A part without a section kept its version.

Earlier releases are only recorded in the git history.

## 2026-10-08 — aekasha-hub

### Project

**Added**

- The Ækasha Hub: the engine's instructions, examples and documentation as a static site, with its sources in `hub/` and its generator in `devTools/hub/`. This first version is the site itself; the code blocks and search, the API documentation, the example scenes and the feature pages come in later branches.
  - Pages: a folder under `hub/pages/` per URL, with an `index.html` (the title and the `aek:` menu metadata in its `<head>`, the page's markup in its `<body>`) and a Markdown file for each of its slots. The nav is built from the pages' metadata, at build time.
  - Markdown (markdown-it): heading anchors and an "On this page" table of contents, `hub:` links between pages that are checked at build time (a dead link or `#hash` fails the build with its file and line), `::: tip|note|warning|danger` callouts and a directive registry for later ones, and images converted to WebP.
  - The design shell: a top nav with dropdowns, breadcrumbs, a footer, a dark and a light theme (saved, else the system's), a mobile menu, keyboard navigation, self-hosted Inter and Lucide icons, and a homepage with a hero and the slots for its later content.
  - Generated sections: Issues (a page per `docs/issues/*.md`, listed by status) and Version (the engine, toolkit, app and project versions and the build, then the whole `CHANGELOG.md` with an anchor per entry).
- `yarn dev` serves the Hub at `/hub/` (`devTools/hubPlugin.ts`, dev server only; `AEK_HUB=false` turns it off). It builds on the first request, rebuilds on every save under `hub/` and in its other sources, and refreshes only the open Hub tabs whose page changed (a stylesheet change without a reload). It never reloads the app's tabs. A page with an error is served as an error page with the file and line, and comes back by itself when it's fixed.
- `yarn hub:build [--out <dir>]` builds the public site into `dist-hub/`: relative links (it works at a domain root and under `/hub/`), a `404.html`, a Netlify `_headers` file, and `?v=<content hash>` on every asset. An error fails it. `yarn hub:preview [--base /hub/]` serves the build as a static host would.
- `docs/techniques/hub-authoring.md`: how to write Hub pages.
- CLAUDE.md: the Hub's section, the issue-file convention (`**Title:**` on line 1, then `Key: value` lines with `Status:` first), and the rule that a change to an engine or toolkit feature or public API updates its Hub content in the same branch.

**Changed**

- `yarn build` and `yarn build:test` also type-check `hub/` (`tsc -p hub`) and build the Hub into `dist-hub/` at the end. `AEK_HUB=false` skips the Hub build, and `AEK_HUB_IN_DIST=true` also copies it into `dist/hub/` (off by default).
- The project metadata (versions, codenames, packages, build commit and time) is built by `devTools/projectMetadata.ts`, shared by `vite.config.ts` and the Hub. `__PROJECT_METADATA__` and `index.html`'s placeholders are unchanged.
- The Stop hook runs on changes in `hub/`, `devTools/` and `vite.config.ts` too, and type-checks `hub/`. ESLint ignores `dist-hub/`.
- New dev dependencies: `markdown-it` 14.3.1 and `@types/markdown-it` 14.1.2.

## 2026-10-08 — finalize-impostor-billboard-lod

### Engine 4.13.0 (Afternoon)

**Added**

- Exported impostors: an impostor can be baked once in the debug build, written into the repo, and loaded by a scene instead of baked at load. Both kinds export (octahedral and cross-quads).
  - The `*.impostor.json` asset type (`schemas/impostorSchema.ts`, `kind: "OCTAHEDRAL" | "CROSS_QUADS"`): the atlas id, the layout the bake used, `alphaTest`, the resolved shading, `surfaceDepth` (octahedral) or `normals` (cross-quads), a format version and a fingerprint of the source. Written by the export, not by hand.
  - A scene JSON's `impostors: [id]` loads the listed impostors' atlas slots with the scene's textures. `generateOctahedralImpostor` / `generateCrossQuads` called with a listed `id` then build from the export: no bake, and the export's layout, shading and flags win over the call's options. An impostor that isn't listed, or whose export is of another format version or didn't load, bakes as before (with a warning when it's listed).
  - Stale exports: in the debug env, using an export hashes the call's geometry, material and resolved options (`getImpostorSourceHash`) and warns when they no longer match the export's fingerprint. The export is used anyway; re-exporting it is the fix. Production skips the hash.
  - The bake and the build are split: `bakeOctahedralImpostorAtlases` / `bakeCrossQuadsAtlases` bake into unregistered targets, and `buildOctahedralImpostor` / `buildCrossQuads` build the quad (or planes) and the material from a layout and two atlases, with `vOrigin: 'TOP' | 'BOTTOM'` (a bake's render target against a loaded KTX2's v-up atlas).
  - `IMPOSTOR_EXPORT_FORMAT_VERSION`, the kinds and their atlas slots (`getImpostorDefSlots`) in `core/Lod/Impostors/ImpostorFormat.ts`; the impostor registry (`getImpostorRecord`, `getImpostorRecords`: every impostor generated this session, baked or loaded, with its bake time).
  - `AppConfig.lod.impostorExportDir` (default `src/app/impostors`): where a new export is written. A re-export writes where the impostor's files already are.
- Texture atlases: `slots.<name>.image`, a ready-made image of the whole layout (the slot isn't composed from its cells; every cell needs a `rect`), and `mipChain: "FULL"`, every mip level down to 1 × 1 instead of stopping where cells would mix. `TextureAtlasSlotInfo` gets `mipChain` and `fromImage`.
- Alpha-coverage-preserving mips: `optimize.alphaCoverage` on a `*.texture.json` or an atlas slot (the material's `alphaTest`, 0-1) scales each mip level's alpha so the share of it passing that cut stays level 0's, so thin alpha-cut features (an impostor's trunks and edges, leaf cards) don't break up with distance. Refused on a `normal` or `data` slot (their alpha isn't coverage). `AlphaCoverageSchema` and `NON_COVERAGE_SLOTS` in `schemas/assetsConfigSchema.ts`.
- Debug: the LOD tab's Impostors folder lists the impostors generated in the scene (kind, baked or loaded from its export, export state: not exported, up to date, stale or another format; atlas size, bake time) with Export / Re-export and Export all. An export bakes again from the impostor's source, reads the atlases back and writes the `*.impostor.json`, the `*.textureAtlas.json` and the PNGs in one dev files batch, and the gather's result is shown as a toast after the reload. The albedo slot gets `alphaCoverage` at the impostor's `alphaTest`. Without the dev files (a LAN device, `AEK_DEV_FILES=false`, no dev server) it downloads the files and lists the paths to put them at.
- The Assets tab's atlas slot info shows the mip chain and whether the slot is a ready-made image.

### App 1.8.0 (Preschooler)

**Added**

- The `lodShowcase` scene: the LOD system lane by lane, each lane running away from the start camera with an object in every level band (placed from the levels' screen sizes, `lodShowcase/layout.ts`), so every level of every lane is on screen at once, under the `dayNight` sky box held at 15:00. Left to right: an instanced tree pool ending in exported cross-quads and a cull fade; hand-made levels in a `*.mesh.json` (sphere geometries in `*.geometry.json`, the mesh's `lod` and `fadeSeconds`); a 16k-triangle torus knot with an `AUTO` lod, its chain simplified at load; the same knot as an instanced pool, its chain's levels then an exported flat octahedral impostor (cheaper than the chain's 982-triangle last level); largeWorld's rock as a baked and an exported impostor beside the mesh; and static instance cells (one `InstancedMesh` entity per cell) that swap and fade as a whole. A later LOD plan adds a lane with a module and a list entry.
- The scene's "LOD demo" debug tab: camera stops (the start view, overhead, and both sides of every lane's level switches and cull), a dolly down the lanes and back, the time of day, each lane's entities per level and triangles, and buttons to the LOD tab and the profiler. Only the camera stop is saved.
- Exported impostors for the scene: `lodShowcaseTreeCross` and `lodShowcaseKnotImpostor` (`src/app/impostors/`).

**Changed**

- largeWorld loads its rock and tree impostors from their exports (`src/app/impostors/`, listed in `largeWorld.scene.json`'s `impostors`): no bake at load (the scene loads in about 1,385 ms against 1,450 ms), and the atlases take about a quarter of the GPU memory (UASTC KTX2: 1.0 MB against 4.0 MB per rock atlas).
- largeWorld's impostor exports are re-exported with `alphaCoverage` on their albedo atlases: the trees' cross-quads no longer thin out at their switch distance (their area against the mesh they replace went from 0.86 to 0.94 on average; the runtime bake's is 0.99), and the rocks look as before.
- The `textureAtlases` scene gets a third test atlas, `p299TestAtlasImage`: a ready-made two-slot image with a full mip chain, each slot and cell drawn at every level. Its albedo slot uses `alphaCoverage`.
- `p341AlphaCutTest`, a test texture for `alphaCoverage` on a plain texture (thin twigs, a fence and grass blades; in no scene).

### Project

**Added**

- The asset pipeline builds atlas `image` slots (the image's size checked, no composition) and `mipChain: "FULL"` chains (exact 2 × 2 box, then area-filtered past an odd size). The cache key changes only for atlases that set them. A run labels such a slot "N cells in an image, full chain".
- The asset pipeline builds `alphaCoverage` textures and atlas slots (`devTools/assetPipeline/alphaCoverage.ts`): level 0's coverage measured at the cut with 4 × 4 bilinear sub-samples per texel on the 8-bit alpha, then each later level's alpha scale found by bisection, per cell on the levels the padding keeps apart and over the whole image past them. Each level is halved from the unscaled one. A plain texture with it builds its own box-filtered chain (`ktx create --levels`) instead of `--generate-mipmap`, measured on the source before `maxSize`. The cache key changes only for assets that set it (with `ALPHA_COVERAGE_VERSION`), and a run labels them "alpha coverage 0.5".
- The gatherer validates `*.impostor.json` files (their atlas must exist, have the slots the kind reads and be the layout's size) and expands a scene's `impostors` into the definitions on its generated data and the slots into its `textures`. An impostor of another format version is left out with a warning.

## 2026-10-07 — dev-server-implementation

### Engine 4.12.0 (Afternoon)

**Added**

- Dev files (`debug/DevFiles.ts`, implementation `core/Debug/_dbg__DevFiles.ts`): debug tooling writes files into the repo while `yarn dev` runs, through the dev server's file routes (see Project). Debug env with the dev server only; in a build, or with the routes off, it reports itself unavailable.
  - `getDevFilesStatus()`: whether this page can write and why not (`NOT_DEBUG_ENV`, `NO_DEV_SERVER`, `UNREACHABLE`, `NOT_ENABLED`, `NOT_LOCAL`, `NO_TOKEN`), with the server's settings. It never rejects.
  - `writeDevFiles(writes)`: a batch of `{ path, json }`, `{ path, blob }` and `{ path, saveData: { sceneId, entry } }` writes that all land or none does. Each has an optional `expectedHash` (the hash `readDevFile` returned; `null`: the file must not exist yet), and resolves per file with `created`, `updated` or `unchanged`. A refusal rejects with `DevFilesError` and its code (`CONFLICT` with the hashes on disk, `INVALID_SCHEMA` with the gatherer's issues, …).
  - A `saveData` write puts a save entry first in an asset JSON's `__saveData[sceneId]` (the older entries after it), stamped with the engine, toolkit and app versions and the date. It keeps `getDevFilesSaveHistorySize()` entries for that scene, and an entry equal to the latest one is `unchanged`.
  - `readDevFile(path)`: the bytes, the hash and, for a `.json`, the parsed value; `null` for a missing file.
  - `encodePNG(source, { flipY? })`: `ImageData`, an RGBA8 buffer or a canvas to a PNG `Blob`. Its own encoder keeps a fully transparent pixel's colour (a canvas loses it to premultiplied alpha), for atlases read back from render targets.
  - `onDevDataGathered(fn)`: how the gather after a write went (`done` / `failed`, the changed files, asset errors, whether the page reloads), before the reload. The reload waits up to 2 s for `fn`'s promise.
- `AppConfig.devFiles.saveHistorySize` (default 20): the save entries a save keeps per scene; -1 keeps every entry, 0 turns saving into `__saveData` off. Always 0 outside the debug env.
- The Debug tools tab's "File server" folder: whether this page can write files (on, LAN too, off, or unavailable and why), the save history size (overrides the config's in this browser, saved once changed) and what it means.

### App 1.7.0 (Preschooler)

**Added**

- `src/CONFIG.ts` sets `devFiles.saveHistorySize` (20).

### Project

**Added**

- The dev file server (`devTools/devFilesPlugin.ts`, `devTools/devFiles/`), part of `yarn dev` and never in a build. It serves routes under `/__aek/files/`: `status`, `read`, `stage` (a raw upload, kept 10 minutes) and `commit`.
  - Security: a token per server start in `index.html`, a `Host` and `Origin` check, and writes from the server's machine only. `AEK_DEV_FILES_LAN=true` allows the LAN (a phone under `yarn dev:https`); `AEK_DEV_FILES=false` turns the routes off.
  - Paths: only in `src/app/`, `src/toolkit/` and `src/public/` (not the pipeline's `aek-assets/`, `draco/` or `basis/`). No dot folders and no symlinks out; `.json` and image files only, 32 MB per file and 128 MB per batch.
  - JSON is validated against its gathered schema and written Prettier-formatted.
  - A commit writes through temporary files and renames, restores every file on a failure, and keeps the last 20 commits' backups in `.cache/dev-files/backup/`. A file whose bytes don't change isn't written.
  - Save entries are written on the server, which stamps the versions from `package.json` and trims the scene's list.
- `npx tsx devTools/devFiles/selfCheck.ts`: the dev file server's self-check. It starts its own dev server, or runs against one with `--url`, and covers every refusal, rollback (forced rename failures included) and save entry case, the last ones through a real gather.
- The scene gatherer's dev server plugin sends the custom HMR event `aek:gather` before each reload, and ignores a commit's temporary files. `gatherAppData.ts` exports `validateGatheredJson` and `hasGatheredSaveData`.

**Changed**

- `vite.config.ts`: `server.fs.strict: false` is now `server.fs.allow: [<repo root>]`. With the dev server on the LAN, any device could read any file the user can through `/@fs/`; now only the repo is served.

## 2026-10-07 — impostor-billboard-lod

### Engine 4.11.0 (Afternoon)

**Added**

- Cross-quad impostors (`core/Lod/Impostors/CrossQuads.ts`): `generateCrossQuads(geometry, material, opts?)` bakes an object into two or three intersecting alpha-cut planes through its vertical axis, a far LOD level for vegetation. It returns a registered `{ geometry, material, albedo, normal }`, which goes straight into `createInstancedLodPool`'s last level.
  - The bake renders the object (a per-group material array works) from each plane's direction with an orthographic camera fitted to its bounds, into one albedo atlas (sRGB) and one normal atlas, with mipmaps. Transparent texels take the nearest opaque colour, so filtering and mips leave no dark fringes.
  - Nothing is lit in the bake: the impostor material shades with the scene's lights, shadows and environment at runtime, with each texel's baked normal. It uses the shading model of the source material drawing the most triangles (Phong, Lambert, unlit, else standard). The planes are double-sided, cast alpha-cut shadows, and a plane seen from behind is lit correctly.
  - Options: `id` (default `${geometry id}#crossQuads`), `planes` (2 or 3, default 3), `frameSize` (default 128), `gutter`, `alphaTest`, `normals` and `shading`. Its assets are owned by the loading scene and released with it; a later call with the same `id` returns them while they're registered.
  - The bake helpers both kinds of impostor share (bake materials, frame and atlas targets, the dilating copy, the shading model pick) are in `core/Lod/Impostors/ImpostorBake.ts`.
- Octahedral impostors (`core/Lod/Impostors/OctahedralImpostor.ts`): `generateOctahedralImpostor(geometry, material, opts?)` bakes an object from a grid of directions on a sphere into two atlases, and draws it with one quad per instance that faces the camera from any angle, overhead included. A far LOD level for rocks, buildings and anything seen from above. It returns a registered `{ id, layout, geometry, material, albedo, normalDepth }`, which goes into `createInstancedLodPool`'s last level (or onto a plain mesh).
  - The atlases hold albedo and coverage, and the object-space normal with the depth in alpha; never light, so the impostor is lit by the scene's lights, shadows and day-night cycle at runtime. `hemi: true` bakes the upper hemisphere only, for objects never seen from below: twice the frames per direction.
  - The material blends the three frames nearest to the view direction with barycentric weights, each sampled where the pixel's view ray meets the object's surface (a depth parallax), so the frames line up and nothing pops as the camera orbits. A hemi impostor seen from well below the horizon draws its horizon frames flat.
  - Shadows: in the shadow pass the quad faces the light and casts the silhouette seen from it. The impostor writes its surface's depth in both passes and receives shadows on that surface, so it meets the ground and shadows itself like the mesh. `surfaceDepth: false` draws the flat quad and receives no shadows instead: about a quarter of the GPU cost where impostors cover many pixels, for objects standing on the ground.
  - Options: `id` (default `${geometry id}#octahedral`), `frames` (2-32, default 12), `hemi`, `frameSize` (default 64), `gutter`, `alphaTest`, `shading` and `surfaceDepth`. Owned by the loading scene, and a later call with the same `id` returns the registered assets, like cross-quads. It gets `enableLodDither` from the pool like any level material, so switching to and from it cross-fades.
  - The octahedral maps and frame bases, on the CPU and in TSL (`Octahedral.ts`), and the material's nodes (`createOctahedralImpostorNodes`, `createOctahedralImpostorQuad` in `OctahedralImpostorMaterial.ts`) are exported for custom materials.
- Dithered LOD cross-fades (`core/Lod/LodFade.ts`): a level change, and hiding or showing at `cullScreenSize`, no longer pops. For `fadeSeconds` both levels are drawn and dissolve into each other through a screen-space dither. Everything stays opaque, so there's no sorting, and shadows and post effects work as before. Shadows dither with the same split, so they don't darken during a fade.
  - `fadeSeconds` on a `LodDef` (and `lod` in `*.mesh.json`, scene mesh overrides, `AUTO` LODs and `createInstancedLodPool`'s `lod`), else `AppConfig.lod.fadeSeconds` (default 0.25), changed at runtime with `setLodFadeSeconds` / read with `getLodFadeSeconds`. 0 switches at once and leaves the level materials undithered.
  - Instanced LOD pools fade per instance: during a fade the instance is in both level meshes, so a fade adds no draw call. Plain meshes and `InstancedMesh` entities draw the outgoing level through a temporary copy of the mesh for the fade. Skinned meshes don't fade.
  - `lodDither(fade)` (a TSL mask for custom node materials), `enableLodDither(material)` (pools and LOD meshes call it on their level materials; it keeps an existing `maskNode`), `createLodFadeAttribute(mesh)` and `setLodObjectFade` / `clearLodObjectFade`.
  - `TAG_LOD_TRANSITIONING` (runtime only) marks a fading entity, and `lodFadeSystem` runs right after `lodApplySystem`, over the fading entities only (about 0.3 ms for 3,000 fading pool instances). `LodFrameStats` gets `fading` and `fadeMs`.
  - `LodTarget`: `applyLevel` and `setCulled` get a `fade` flag, and a target fades when it has the new optional `setFade(entityId, world, progress)`. Existing targets keep switching at once.
  - Debug: the LOD tab's Fades folder (a global fade seconds override and a time scale for slow motion, `setLodDebugOptions`'s `fadeTimeScale`), the fading count in its stats and rows, and the LOD window's fade state, progress and duration.

**Changed**

- LOD changes cross-fade by default (0.25 s). Set `AppConfig.lod.fadeSeconds: 0` (or a LOD's `fadeSeconds: 0`) for the old instant switch.

### App 1.6.1 (Preschooler)

**Changed**

- largeWorld's trees get a third LOD level, cross-quads, below a screen size of 0.032 (about 180 m from the overview camera); level 1 now ends there.
- largeWorld gets 300 rocks in an instanced LOD pool: a toolkit asteroid (500 triangles), the same rock at 80 triangles from a screen size of 0.05 (about 50 m) and a hemi octahedral impostor below 0.025 (about 100 m), a third of each in the ground.
- largeWorld also lists the `dayNight` sky box (its default stays `basicSkybox`). While a sky box with a sun light is active, the scene's own sun and ambient light are off, so its night falls on the whole scene.

## 2026-10-06 — physics-simulation-tiers

### Engine 4.10.0 (Afternoon)

**Added**

- Physics simulation tiers (`core/PhysicsTiers.ts`, types in `Physics/PhysicsTierTypes.ts`): a dynamic body made by `createPhysicsEntity` can be `FULL` (simulated as created), `STATIC` (switched to `FIXED`: it still collides, but nothing moves or wakes it), `DISABLED` (out of the broad phase, contacts and queries; pose and velocities kept exactly) or `REMOVED` (the body and its colliders leave the physics world and free their transform-buffer slot; the entity and its visual stay).
  - `requestPhysicsTier(entityId, tier, world?)` applies at the start of the next `APP_PHYSICS_STEP` sub-step, so a request from a step system or scene-load code is deterministic; requests made before then collapse into the latest. It returns `false` (with a debug-env warning) for a character, a body not yet created, or one not created `DYNAMIC` by `createPhysicsEntity`. `getPhysicsTier(entityId, world?)` returns `{ tier, pending, inFlight }`.
  - `STATIC` and `DISABLED` move the entity to `BODY_STATIC` (no per-frame sync or interpolation). `REMOVED` takes its bucket and `COLLIDER` components away, and `world.setTransform` moves only its visual until it's back.
  - Bodies connected by impulse joints change tier together; `REMOVED` is refused for a body with joints.
  - A `REMOVED` body keeps its ids and proxies, so app references to it and its colliders, collider event callbacks and later collider changes survive. A body at rest comes back exactly as if it had never left. A moving one keeps its pose, velocities and sleep state, but Rapier's contact and solver state starts over. In `WORKER_THREAD` mode a full transform buffer refuses the return: the entity stays `REMOVED` and a `PhysicsCapacityError` is logged.
  - Engine side: `detachRigidBody` / `reattachRigidBody` (plus `*Sync`, `PhysicsAPI.ts` and `EngineRapier.ts`) and the worker requests `RIGID_DETACH` / `RIGID_REATTACH`.
- The physics tier distance policy (`core/PhysicsTierPolicy.ts`): `setPhysicsTierPolicy({ rings, focus?, hysteresis?, cadence?, interval?, sceneId? } | null, world?)`. Each member gets the tier of the ring around the focus it's in (default focus: the world's main camera; or a position, or an entity id), with hysteresis moving out (default 0.15) and a joint group taking its nearest member's tier. A refused tier isn't requested again until the entity's ring changes.
  - `cadence: 'STEPS'` (default) measures the members and the focus on fixed steps that are multiples of `interval` (default 10) and decides `interval` steps later, so with a deterministic focus a scene plays out the same on every load and in both worker targets. `focus` gets the step index. `'FRAMES'` runs every `interval` frames at `APP_LOGIC` from the members' `TRANSFORM` positions.
  - Members: `createPhysicsEntity`'s `tierPolicy` option (the new `PhysicsEntityOpts`), or `setPhysicsTierPolicyMember(entityId, member, world?)`.
  - `getPhysicsTierPolicy`, `getPhysicsTierPolicyStatus` (cadence, interval, last measured step, pending measurements), `setPhysicsTierPolicyFrozen(frozen, source?, world?)` (each source freezes on its own), `isPhysicsTierPolicyFrozen` and `getPhysicsTierPolicyFreezeSources`. A policy with `sceneId` is removed when that scene exits.
- Step plumbing (`PhysicsAPI.ts`):
  - `getPhysicsSubStepIndex()`: inside an `APP_PHYSICS_STEP` system, the index of the fixed step about to run (a write made in step `k` shows in the snapshot stamped `k + 1`), else -1.
  - `addPhysicsStepGate(step)` returns a release function: no sub-step at or past `step` runs while it's held (several gates: the lowest holds). It also cuts the frame's batch it was added in. Time keeps accumulating while it holds (at most `maxSubSteps` steps of it) and is caught up after. A new physics world drops every gate. `getPhysicsStepGateStats()` counts the holds and their time.
  - `readBodyPositionsAtStep(ids)` / `readBodyPositionsSync(ids, out)`: body positions read right before the current step runs, the same values in both worker targets (also for a `REMOVED` body; NaN for an unknown id). Engine side `readBodyPositions` and the worker request `RIGID_READ_POSITIONS`.
- `getPhysicsBodyCapacity()` (`WORKER_THREAD`: transform-buffer slots used, max and refused creates) and `getLastPhysicsBodyActivity()` (awake and sleeping dynamic bodies, measured with the step stats, in the worker too).
- `getPhysicsBodyOwner(rigidBodyId)` (`PhysicsManager.ts`): the entity, world and created rigid type of a `createPhysicsEntity` body. `hasJoints()` and `forEachJointBodyPair(fn)` (`PhysicsAPI.ts`).
- `setBodyMovedListener` / `setBodyMovedObserver`: told about every `setTranslation` / `setRotation`, so a body moved directly reaches its entity's transform when it isn't synced every frame.
- Physics API debug tab:
  - "Bodies (live)": slots used / max, refused creates, awake and sleeping dynamic bodies.
  - "Simulation tiers (live)": counts per tier, pending and in-flight transitions, the policy's rings, cadence and state, its last measured step, measurements waiting for their step, step gate waits, and a "Freeze tier policy" toggle (its own freeze source, session only).
- Collider wireframes have two more colour states, `tierDisabled` and `tierStatic`, which lead the priority list (`PhysicsWireframeColors` in `AppConfig.debugPhysicsWireframe`, the tab's palette and the per-entity overrides).

**Changed**

- Fixed bodies take no transform-buffer slot in `WORKER_THREAD` mode, and `physicsToTransformSystem` no longer syncs `BODY_STATIC` every frame: a fixed body moved by `world.setTransform` or a direct `setTranslation` / `setRotation` is synced when it moves. A body whose pose didn't change no longer marks its transform dirty, so a sleeping body costs one pose read and compare per frame.
- `ECSWorld.setTransform`, `setVelocity` and `setDisabled` treat an entity with a physics tier as dynamic, and `setDisabled` keeps a `DISABLED`-tier body disabled.
- Determinism probe: an entity in a tier other than `FULL` hashes its tier too (scenes without tiers keep their hashes), and a `REMOVED` one its transform. While armed it freezes `FRAMES` tier policies; a `STEPS` policy keeps running, so the probe tests it.
- The `runtime` view icon is redrawn.

**Fixed**

- A full transform buffer (`maxBodies`) threw in the worker, the create never settled and a scene load hung. A create is now refused: `createPhysicsEntity` removes what it made and rejects with a `PhysicsCapacityError`, and `CREATE_RIGID_BODIES` is all or nothing.

### App 1.6.0 (Preschooler)

**Added**

- The `physicsTiers` demo scene (`physicsTiers.ts`): 686 crates in 49 piles on a 600 m ground, every crate in a `STEPS` tier policy (rings `FULL` 40, `STATIC` 90, `DISABLED` 160, `REMOVED` beyond) around a kinematic plough ball that mows a serpentine through the piles on fixed steps. Crates are tinted by tier and the rings are drawn around the plough. `C` switches between the overview and a chase camera. A visit plays out the same every time, in both worker targets.

## 2026-10-06 — editor-creator-view

### Engine 4.9.0 (Afternoon)

**Added**

- Views (`core/ViewManager.ts`): a view is what the whole canvas shows and what the main loop ticks. The built-in **Runtime** view is the loaded scene; editor views are registered by debug modules with `registerView({ id, title, icon, orderNr?, scene, getCamera, getCameraRig?, onEnter?, onExit?, mainUpdate?, update?, toggleDrawer? })` and switched with `setActiveView(id)` (calls run one after another; a failed `onEnter` returns to the Runtime view and resolves `false`). Also `unregisterView`, `getViews`, `getActiveViewId`, `getActiveView`, `getActiveViewCamera` and `isRuntimeViewActive`.
  - While an editor view is active the scene is suspended: no ECS stage of any world, no scene looper, no held keys and no physics step run, and `getElapsedTime()` stands still. Physics resumes without catching up, so a visit to an editor view keeps a scene deterministic. The loop runs the view's `mainUpdate` and, while it plays, its `update`, then renders its scene and camera (no PostFX) with the viewports on top.
  - `toggleViewPlay()` / `isViewPlaying()`: the active view's own play flag (in the Runtime view, the app loop's). The pause button and F7 call it.
  - `addViewFrameListener(fn, 'BEFORE_UPDATE' | 'AFTER_RENDER')` for debug tools that must run in every view (the axes gizmo, the env ball and the profiler's samplers use it), and `addViewChangeListener`.
  - The active view and each view's play flag are saved (`AEK_debugViews`), and `restoreSavedView()` switches back to the view after a refresh.
  - `renderFrameWhileMasterPaused()` (`MainLoop.ts`) renders one frame, so a switch shows the new view while the master loop is paused.
- A view tools group in the top on-screen row, left of the play group: Runtime, then each editor view, with a toast on every switch. It shows only when an editor view is registered. New icons: `runtime` and `material`.
- Editor view rules for the rest of the debugger:
  - Input: `setAppInputsSuspended` (`Input/InputState.ts`) stops mouse, touch, held keys and every key binding without `isDebugKey`, which the engine's debug keys and the CONFIG.ts `debugKeys` have. A scene load doesn't lift it.
  - HUD: `<body>` gets `aekEditorView` and `aekView_<id>`, and the scene's HUD is hidden as it was. `KEEP_IN_VIEWS_CLASS` (`core/HUD.ts`) keeps an element (the top row, undo/redo, stats, the toaster, the viewports layer, debug dialogs), and a draggable window kind registered with `keepInViews: true` (the profiler) is kept too.
  - The scene drawer keeps its open state while a view is active (`setDrawerSuspendedByView`) and leaves `debugDrawerOpen` to the editor's own drawer.
  - Undo: `perScene` actions recorded in an editor view go to that view's own history.
  - Profiler: in an editor view the census counts the view's scene against its camera, under the view's title.
- Camera rigs (`ViewCameraRig`, `core/Debug/Camera/_dbg__CameraRig.ts`): the axes gizmo follows, aligns and orbits the active view's camera, and the env ball follows it and shows the view scene's own environment.
- `createViewCamera({ viewId, defaultPose, near?, far?, store? })` (`core/Debug/Editors/_dbg__ViewCamera.ts`): every editor view's orbit camera, with its rig and a pose saved per view and per pose key (eg. per material) in `AEK_debugViewCams` or the editor's own store. `createViewCameraLSStore` and `clearViewCameraPoses(viewId)` go with it.
- `createEditorDrawer` (`core/Debug/Editors/_dbg__EditorDrawer.ts`): an editor view's right drawer, built like the scene debug drawer and mounting ordinary debugger tab definitions. Each editor creates its own.
- The **material editor**, the first editor view (`materialEditor`, the `material` icon, `debug/MaterialEditor.ts` → `core/Debug/Editors/Material/`):
  - A stage of its own: a preview ball (points, lines or a sprite for those material types, a notice for types it can't preview), its own lights, a studio environment (`RoomEnvironment`) and a grey background. The scene's sky box and lights aren't used.
  - It shows an editor copy of the material (`__matEditor__<id>`), so the scene's own instance is never changed. The copy lives only while the view is active, and the material's textures are loaded on demand. A material that fails to load shows a toast and a magenta ball.
  - A bottom drawer lists every project material (`*.material.json`) as a card with a swatch, its type and a `TSL` badge, filtered by id and name. Its right edge follows the right drawer.
  - The right drawer's **Params** tab shows the material's info (status, id, name, type, source, description, TSL file and textures) and its editable params, in Base, Surface, Transparency, Rendering and Points / lines folders. One list covers every material type: a param shows only when the material has it. A TSL material's inputs are edited live through their uniforms (numbers, colours, booleans, vectors); its texture inputs and `staticDefines` are read-only, and so are the asset params no binding covers. "Reset params" removes the material's edits.
  - The **Settings** tab holds the material's stage settings (background, studio environment on or off and its intensity, key, fill and hemisphere light intensities), auto-rotation (paused with the view), and the camera's FOV, pose and "Reset camera to default". "Clear editor data of all materials" asks first.
  - Each material keeps its own record (`AEK_debugMatEditorMat_<id>`): its edits, deviation-only in the material JSON's `params` / `nodes` shape (a value set back to the JSON's follows the JSON again), its settings and its camera pose. Both tabs' clear button removes it. A refresh brings everything back, plus the selected material, both drawers, the tab, the filter, the scroll positions (`AEK_debugMatEditorUI`) and the folder states (`AEK_debugMatEditorTabsUI`).
  - Undo and redo for every edited value, in the editor view's own history, with a slider drag as one step. Undoing an edit of another material selects that material first.
- `confirmClearLS({ message, confirmText, onConfirm, note? })` (`core/Debug/_dbg__ClearLSButtons.ts`): a confirm dialog for a clear without a scope to pick. `createClearLSButton`'s `icon` takes any icon.
- `ViewCamera.setFov(fov, save?)`.
- `lsGetKeysWithPrefix(prefix)` (`utils/LocalAndSessionStorage.ts`).

**Changed**

- The play group moved into a centred top row (`onScreenTopRow`) with the view tools; it still shifts with the open drawer.
- In an editor view, `h` toggles the view's own drawer (`toggleActiveViewDrawer()`), F1 and F5 do nothing, and `o` / `p` do nothing (the switch tools aren't built there).
- The debug camera is a camera rig too: the gizmo's align and drag suspend its controls through `setDebugCameraControlsSuspended`, and its pose is saved to `AEK_debugCams` when a gizmo move ends.

## 2026-10-05 — ecs-lod-selection

### Engine 4.8.0 (Afternoon)

**Added**

- LOD selection (`core/Lod/LodSystem.ts`): an entity with the `LOD` component gets a level from its projected screen size (bounding-sphere diameter / viewport height, perspective or orthographic), with hysteresis (default 0.1). Below `cullScreenSize` it's hidden by the new `TAG_LOD_CULLED`, a fourth reason in `reconcileObject3DVisibility`.
  - `lodSelectionSystem` and `lodApplySystem` run at `APP_RENDER_SYNC_ORDER.LOD_SELECTION` (-1.5): after frustum culling, so they skip frustum-culled and disabled entities, before light culling. They use the main camera.
  - Each level has a `screenSize` and optional `geo`, `mat` and `castShadow` (omitted ones come from the previous level). A plain mesh swaps its geometry, material and `castShadow`. The component holds a ref on every level's assets, which are released with it. A mesh with `preWarm` pre-warms every level.
  - Global bias: `AppConfig.lod.bias` (default 1), `setLodBias` / `getLodBias`. A definition has its own `bias`.
  - Selection budget: `AppConfig.lod.maxSelectionsPerFrame` (default Infinity), `setLodMaxSelectionsPerFrame` / `getLodMaxSelectionsPerFrame`. With a cap, the selection walks the `LOD` entities round-robin from where it stopped. Entities that come into view (frustum culling, `DISABLED` removed) or just got their `LOD` are still selected in that frame, past the cap. `getLodFrameStats` has `lapFrames`, the frames the last full walk took.
  - `setLodDebugOptions` / `getLodDebugOptions` (`freeze`, `forceLevel`, `useActiveCamera`) and `getLodFrameStats(world)` (selections, swaps, selection time in the debug environment).
- Mesh LODs: `setMeshLod(entityId, def, world)` / `removeMeshLod(entityId, world)` (`MeshManager.ts`), and `lod` on `createMeshEntity`'s props, in `*.mesh.json` and in a scene's mesh overrides (`schemas/lodSchema.ts`, levels checked to be strictly descending). `setMeshLod` returns `Promise<boolean>`: whether the LOD was set.
  - `lod: 'AUTO'` (or `{ auto: true, maxPixelError?, cullScreenSize?, hysteresis?, bias? }`) reads the geometry's LOD chain: a level is used while its error projects to at most `maxPixelError` pixels (default 1) at 1080 px high. It waits for a chain that is still requested or generating, also one an import has asked for but not started. A geometry without a chain warns and gets no LOD.
  - `setMeshGeometry(mesh, geometry)` moves a mesh's geometry ref, like `setMeshMaterial`. `preWarmMesh(mesh, label)` is `createMeshEntity`'s pre-warm, exported.
  - `getPendingLodChain(baseId)` (`LodChains.ts`).
- Instanced mesh pools are an engine system (`core/Instancing/InstancedMeshPool.ts`, they were in the toolkit). Their component is the core `ComponentType.INSTANCED_MESH_SLOT`, and their sync system registers itself with the module. `spawn` takes `InstancePlacement` (the toolkit's `ScatterPlacement` is one).
  - `despawn(world, entityId)` frees an instance's slot with a swap-remove (the pool's last instance moves into it), as do deleting the entity and removing its slot. Read an instance's `index` from its component, never keep it.
  - `createInstancedLodPool({ world, levels: [{ geometry, material, screenSize, castShadow? }], maxInstances, lod?, ... })`: one `InstancedMesh` per level, each instance an entity with `INSTANCED_MESH_SLOT` and `LOD` that moves to its level's mesh. A LOD-culled instance is in no mesh. Every level mesh gets the bounds of every placement at spawn.
  - `registerLodTarget(componentType, target)` lets `LOD` work on entities without a plain mesh (`LodTarget` in `Lod/LodTypes.ts`): the target resolves and applies the levels and handles LOD culling, and the entity's `Transform` gives its world position and scale.
- An `InstancedMesh` entity (eg. a static instance cell, `OBJECT3D` + `TAG_IS_MESH`) can have a mesh LOD: the whole mesh switches levels, measured by level 0's bounds over all its instances (`Lod/LodBounds.ts`) instead of one instance at the mesh's origin. `refreshLodBounds(entityId, world?)` re-reads them after the instances change. Its levels pre-warm on instanced stand-ins, and `AUTO` thresholds account for the instances' scale.
- "LOD" debug tab (`lodControls`, last in the default tab order): entities per level on screen, LOD culled and out of view, the last frame's stats, and the global bias, selection cap, freeze, force level and "use active camera" controls (runtime only).
  - Level overlay: a wire box per LOD entity in the selection camera's view, coloured by the level it shows, around the sphere the selection measures.
  - LOD window per entity (from the tab's mesh list, "Nearest in view" for pool instances, or the profiler's heaviest objects): the live screen size, distance and state, and each level's threshold as the distance it switches at with the current camera and biases.
  - `getLodSelectionCamera`, `measureLodEntity` and `getLodWorldSphere` (`Lod/LodSystem.ts`) measure an entity the way the selection does.

**Fixed**

- Deleting a pooled instance's entity left its matrix drawn: the pool had no despawn.
- A pool took no registry ref on its geometry and material(s) but released one when its mesh was deleted. It now takes them, and its mesh has `userData.entityId`, so `setMeshGeometry` / `setMeshMaterial` move them and `deleteScene` deletes its mesh entity.
- Pre-warm stand-ins aren't frustum culled: `compileAsync` culls against its own camera, which skipped a mesh far from the origin.

### Toolkit 1.3.1 (Crescent)

**Changed**

- `ecs/InstancedMeshPool.ts` and `ecs/InstancedMeshPoolTypes.ts` are deprecated re-exports of the engine's pool until the toolkit's next major version. `InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT` is the core key, and `registerInstancedMeshPoolEffect` does nothing (the engine registers the sync system).

### App 1.5.1 (Preschooler)

**Changed**

- largeWorld's trees and bushes are instanced LOD pools. Their levels are the same generators at lower segment counts (the default tree and bush are too low-poly for a LOD chain): trees 30 → 18 triangles, bushes 120 → 36, and bushes hidden far away. From the overview camera that cuts the foliage from 285k to 91k triangles.
- `AppECSRegistry.ts` has the `LOD_SELECTION` order and no longer merges the toolkit pool's component, and `AppECSPlugins.ts` no longer registers the pool's effect.
- `testDebugScene` has a sphere with three hand-made levels (`p348LodSphere`, a colour per level) for checking LOD switches, and a static instance cell on the same levels (`p348LodCell`, 25 spheres in one `InstancedMesh` entity).

## 2026-10-05 — lod-chain-generation

### Engine 4.7.0 (Afternoon)

**Added**

- LOD chains (`core/Lod/`): `generateLodChain(geometryId, opts?)` simplifies a registered geometry with meshoptimizer into levels registered as geometries `${baseId}#lod${n}`. Each level records its triangle count and error, relative to the chain's `extent` (the base's largest bounding box side) and including the normal and uv deviation.
  - Levels share the base's vertex attributes (only the index differs) unless `compactVertices` gives each its own. A non-indexed base is welded first. Material groups are simplified per group and rebuilt.
  - Options: `ratios` (default `[0.5, 0.25, 0.1]`), `maxError` (0.05), `attributeWeights`, `compactVertices`, `lockBorder` (tiling geometry) and `permissive` (flat-shaded geometry doesn't simplify without it). A chain without levels warns.
  - Skinned and morph-target geometry is refused. Nothing selects a level yet.
  - Also `getLodChain`, `getLodChains`, `getLodChainOfLevel`, `isLodChainPending` and `releaseLodChain`. The chain holds a ref on each level and is released with its base (`onGeometryDeleted` in `core/Geometry.ts`). Levels take the base's scene owner.
- The simplifier runs in the assets worker (new kind `SIMPLIFY`) or on the main thread. `AppConfig.assets.simplifyWorkerTarget` (env `VITE_ASSETS_SIMPLIFY_WORKER_TARGET`, plus a boot override in the Assets tab) defaults to `WORKER_THREAD`, whatever `workerTarget` is. meshoptimizer loads on first use on both threads.
- `lodChain` (`true` or the options) on `*.importedAsset.json` and `ImportAssetParams`: `importAssetAsync` generates a chain for each rendered geometry after the import, without being awaited.
- Build-time chains: a GLB built by the asset pipeline carries its chains (levels as meshes `<mesh>__lod<n>` that no node uses, described by the root's `aekLodChains` extras). The import registers them (`LodChain.origin: 'BUILD'`) and doesn't simplify on the client. The generated data's `__lodChain` lists each primitive's levels for tooling.
- Assets tab: the geometry info window shows a geometry's chain (per level: triangles, error, bytes, shared or own vertices), with "Generate LOD chain" and release buttons.
- The Ækasha symbol, a black and white Æ with rounded corners: a UI icon (`getSvgIcon('aekasha')`, `core/UI/icons/svg/aekasha.svg`, in `currentColor`) and the favicon: `favicon.svg` (white on a dark browser theme), `favicon.ico` (16, 32, 48, with a white halo for dark tabs) and `apple-touch-icon.png` in `src/public/`, linked from `index.html`.
- About Ækasha dialog (`core/Debug/_dbg__About.ts`, `openAboutDialog()`), opened by the Æ button left of undo / redo (debug mode): the engine, toolkit and app versions, the version checksum and the build (commit, local changes, time), the runtime packages and main build tools, the runtime (environment, renderer, GPU, viewport, browser) and physics (every backend in `ENGINES` with its package version, status, thread, transform transport, SharedArrayBuffer availability, timestep and sub-steps, solver, gravity, interpolation, background behavior, body counts). "Copy info" copies it all as text, for bug reports.
- A physics backend in `Physics/ENGINES.ts` has a display `name` and its npm `packageName`.
- `PROJECT_METADATA` (`__PROJECT_METADATA__`, from `vite.config.ts`) has `license`, `packages` (the runtime dependencies), `buildTools` (vite, typescript) and `build` (`commit`, `hasLocalChanges`, `time`).

**Changed**

- The workers build as ES modules (`worker: { format: 'es' }` in `vite.config.ts`), so they can load chunks on demand.
- `meshoptimizer` is a runtime dependency (it was a dev dependency).

### Project

**Added**

- The asset pipeline builds an imported asset's `lodChain` into its GLB (`devTools/assetPipeline/lodChains.ts`), with the mesh side on. Uses of one file share one output, with the first use's options; a use with other options is warned. The cache key has the resolved options, the simplifier version and the GLB format version, so assets without `lodChain` keep their keys.

## 2026-10-04 — asset-optimization-pipeline

### Engine 4.6.0 (Afternoon)

**Added**

- KTX2 textures: `loadTextureAsync` loads a `.ktx2` file (picked by the resolved URL's extension) through a shared `KTX2Loader` on the main thread (`core/Import/KTX2.ts`). The loader is imported on first use and transcodes in its own workers, into what the device supports (BC7, ASTC, ETC2). It loads the Basis transcoder from `${BASE_URL}basis/`. `getKTX2Loader()` replaces the loader when the renderer has changed, and `disposeKTX2Loader()` disposes it. The sync `loadTexture` / `loadTextures` refuse `.ktx2` with an error that points to `loadTextureAsync`.
- Meshopt and KTX2 in GLBs: `GLTFLoader` gets the meshopt decoder (`MeshoptDecoder.ts`, imported only when a file uses `EXT_meshopt_compression`) and the KTX2 loader for `KHR_texture_basisu`. Both are set per file from its `extensionsUsed` (`GLTFExtensions.ts`), on the main thread and in the asset worker. The worker gets the main thread's transcoder path and detected formats (`KTX2WorkerSettings`), and `TextureTransfer.ts` sends a compressed texture's mip levels back.
- Pipeline outputs at runtime: `loadTextureAsync` and `importAssetAsync` load an asset's generated `__url` instead of its `fileName` (`resolveAssetUrl`, `core/Assets/AssetUrl.ts`). Generated URLs resolve against `BASE_URL`. In dev data, an asset without an output loads its `__sourceUrl`, with a warning. A relative `fileName` with neither is an error that names `yarn assets`. A packed texture (a `__url` and no `fileName`) loads too. An import keeps its id and source key on the declared `fileName`, so scenes still share one import.
- Asset JSON keys:
  - `*.texture.json` and `*.importedAsset.json` take `optimize`: a profile, a slot (textures), texture and mesh settings, a `budget`, or `false`.
  - Their `fileName` can be relative to the JSON (`./`, `../`).
  - `*.texture.json` takes `pack` (channel packing from several sources) in place of `fileName`.
  - The generated data has `__url`, `__sourceUrl`, `__bytes`, `__vramBytes` and, for textures, `__codec`.
  - `assets.config.json`'s schema is `AssetsConfigSchema` (`schemas/assetsConfigSchema.ts`), compiled to `.schemas/assetsConfig.schema.json`.
- `AppConfig.assets.optimization` (`enabled`, `textures`, `meshes`, each default true): the asset pipeline's project switches. Build time only: the runtime never reads them.
- Assets debug tab, Asset loading folder: "Load source files (boot)" loads the source files instead of the pipeline outputs from the next reload (debug env only). A production build ignores it with a warning, and a packed texture keeps its output. The "Resolved" box has a `Files:` line.
- The texture and geometry info windows show the file this page load loaded and what it is: a pipeline output, a pass-through source, a packed output, or the source (the override, or no output). A new "Asset pipeline" section shows the output, the source, the codec, and the download and VRAM estimates as in → out.
- GPU memory: a compressed texture counts its uploaded mip levels in the format the device transcoded it to (`installCompressedTextureSizer`). three r186 counts it as 1 B. This applies to every figure of the GPU memory tab and the profiler, and to the Assets tab's info window.
- `isKTX2(fileName)` (`utils/helpers.ts`).

**Changed**

- Imported HEIGHTFIELD colliders refuse a quantized position attribute (any array other than `Float32Array`) with an error that names the fix (`"optimize": { "mesh": { "quantize": false } }`), and the collider is skipped, as with Draco. Interleaved float attributes now work.
- Scene-inline textures and a scene's `backgroundTexture` have their own schemas (`InlineTextureSchema`, `InlineTextureOverridesSchema`) and take no relative `fileName`: the pipeline reads only `*.texture.json` files.

**Fixed**

- Imported CONVEXHULL colliders sit on their meshes. The derivation centred the hull's vertices on their bounding box while the body stayed at the node's origin, so a hull whose mesh isn't centred on its origin sat off it (57.8 mm on `obstacles`). This moves the hulls in existing scenes (eg. the gym's Suzanne). Hulls made in code (`vertices` given) are unaffected.
- CONVEXHULL colliders from quantized geometry: the hull was built from the raw integer values (32.7 km off). It now reads positions through the attribute getters, like TRIMESH. A quantized HEIGHTFIELD no longer throws in `mergeVertices` (see Changed).

### App 1.5.0 (Preschooler)

**Added**

- The `assetCompare` debug scene and its "Asset compare" tab, where the pipeline's profiles were chosen. It has a tiled ground at grazing angles, a MetalRust sphere and a Poly Haven prop. Two slots each hold one texture variant (PNG, ETC1S, UASTC with RDO λ 0–4, normal mode on or off), and V switches between them instantly. The tab lists each texture's VRAM, file size and encode error. "Measure all variants" and "Copy results" record per-device formats and timings, and "Run collider check" compares colliders from quantized and meshopt geometry with their sources. Its sky box is `assetCompare.skybox.json`.
- `testDebugScene` (`debugScene.scene.ts`) has PNG / KTX2 texture pairs and meshopt / KTX2 GLB copies, which check the decoders.
- `src/CONFIG.ts`: the `assets.optimization` switches, all on. It imports `AppConfig` with `import type`, because the asset pipeline imports the file in Node.

**Changed**

- `testTexture` and `testImport` load their pipeline outputs: a 1K UASTC KTX2 (VRAM 22.4 → 1.4 MB) and a meshopt GLB (46.7 → 14.7 KB).

### Project

**Added**

- The asset optimization pipeline (`devTools/assetPipeline/`, guide in `docs/techniques/asset-optimization.md`). `yarn assets [--only <id|glob>]` encodes the sources of `*.texture.json` / `*.importedAsset.json` into `src/public/aek-assets/`:
  - textures as KTX2 (UASTC or ETC1S) through KTX-Software's `ktx`;
  - GLBs through glTF Transform, with meshopt (lossless for collider sources) or Draco, and their textures as KTX2. Without `importTextures`, a GLB's textures are dropped.
  - Settings come from defaults, profiles and glob rules in `assets.config.json`, then the asset's own `optimize`. Channel packing and resizing use sharp.
  - A content-hash cache: the committed `assets.lock.json` plus `.cache/asset-pipeline/store/`, so a clone needs no encoder. Only a full run removes stale outputs and lock entries. Run stats go to `.cache/asset-pipeline/last-run.json`.
  - Opt-outs: `"optimize": false` (JSON or rule), the `src/CONFIG.ts` switches, and `AEK_ASSETS_OPTIMIZE=false` for one run. A skipped asset is passed through as it is.
- `yarn gatherAppData` and the dev server run the cached pipeline before they gather. The dev server's plugin (`devTools/sceneGathererPlugin.ts`, moved out of `vite.config.ts`) builds only what a change touched and shows a failed asset in the error overlay.
- Production builds:
  - The gather fails when an asset that a shipped scene uses has no output (encoder missing, or a failed encode) or is over its budget. Budgets are a `budget` per profile or asset, plus a per-texture ceiling from the profile's `maxSize` and codec.
  - `AEK_ASSETS_ALLOW_UNOPTIMIZED=true yarn build` ships the assets without `ktx` unoptimized instead.
  - `dist/aek-assets/` gets only the outputs the build loads (`devTools/assetOutputsBuildPlugin.ts`).
- `yarn setupAssetTools [--force]` downloads the pinned KTX-Software 4.4.2 into `.tools/` (Linux incl. WSL2, macOS; x64, arm64), checks its SHA-256 and unpacks it in Node. The pipeline runs the same setup before its first encode. It needs `ktx` ≥ 4.4.0, and names a skipped one that is too old or broken. A download times out after 120 s, and the dev server doesn't retry a failed one for 5 minutes.
- `yarn dev:https` (port 8443, a self-signed certificate through `@vitejs/plugin-basic-ssl`): a phone on the LAN needs a secure context for WebGPU and `SharedArrayBuffer`.
- `.nvmrc` (22.13.0) and `.claude/hooks/use-node.sh`, which the hooks and Claude's commands source.
- `devTools/assetPipeline/phase1Variants.ts` builds the `assetCompare` scene's variants into `src/public/debugger/assets/testOptimized/phase1/`.
- Dev dependencies: `@gltf-transform/core`, `/functions`, `/extensions` and `/cli` 4.5.1, `meshoptimizer` 1.1.1, `draco3dgltf` 1.5.7, `sharp` 0.35.5, `@vitejs/plugin-basic-ssl` 2.3.0.

**Changed**

- `yarn copyDracoDecoders` is now `yarn copyDecoders`. It also copies the Basis transcoder to the gitignored `src/public/basis/`.
- The dev server sets COOP / COEP on every response, 304s included (`crossOriginIsolationPlugin` replaces `server.headers`). With Web Inspector open, Safari revalidated the physics worker and blocked it.
- `tsconfig.json` lists `"types": ["node"]`: yarn 1 installs the stub `@types/wrap-ansi@8.1.0` for `@gltf-transform/cli`, and tsc failed on it (TS2688; `docs/issues/gltf-transform-cli-types-wrap-ansi-stub.md`).

**Fixed**

- A failed production gather stops `yarn build`. Its result was ignored before.

## 2026-10-03 — spatial-domains

### Engine 4.5.0 (Afternoon)

**Added**

- Spatial domains (`core/Spatial/SpatialIndexSystem.ts`): an ECS world can hold several named spatial grids, each with its own cell size, capacity and update policy. `registerSpatialDomain(world, { id, cellSize, maxMembers, update?, oversizedRadiusMultiplier? })`, `getSpatialDomain`, `getSpatialDomainIds`, `getSpatialDomainOptions`. The existing grid is the `DEFAULT` domain (`getSpatialGrid` still returns it); an app can register `DEFAULT` itself to set its settings. Registering an id again with other settings re-creates its grid and re-inserts the members.
- Update policies: `DYNAMIC` (refreshed and rebuilt every frame, as before), `STATIC` (rebuilt only in a frame where a member joined or left) and `MANUAL` (rebuilt only by `rebuildSpatialDomain`). `invalidateSpatialDomain(world, id)` refreshes and rebuilds any domain at the next frame; `rebuildSpatialDomain(world, id)` does it now.
- Membership: `joinSpatialDomain`, `leaveSpatialDomain` and `isInSpatialDomain`. An entity can be in several domains. `DEFAULT`'s membership is still `SPATIAL_INDEXED`; the others' is the new runtime `SPATIAL_DOMAINS` component (a bit mask, at most 31 domains besides `DEFAULT`). A full non-default domain refuses a member with one dev warning, where `DEFAULT` still throws.
- Radius providers: `registerSpatialRadiusProvider(componentType, fn, { scaleIndependent? })` replaces the hard-coded mesh and light radii. `refreshSpatialRadius(entityId)` re-reads a member's radius after what its provider measures changed, and `getConservativeGeometryRadius(geometry)` is the mesh provider's measure.
- `core/Spatial/CellKey.ts`: the cell maths (`worldToCell`, `packCellKey`, `unpackCellKey`, `isCellInRange`, `cellBounds`, the axis constants), shared by every cell-keyed structure so a cell key means the same thing everywhere for a given cell size.
- `SpatialGrid.getRadius(entityId)` and `memberAt(index)` (iterating the members without an allocation).
- Scene-scoped domains: `registerSpatialDomain`'s `sceneId` makes the settings that scene's. They win over the domain's world settings (registered without `sceneId`) until the scene exits, when the domain goes back to its world settings or, without any, is unregistered. `setSpatialGridCellSize(world, cellSize, sceneId?)` and `getSpatialDomainSceneId(world, id)` take and tell the scope. The scene loader releases the previous scene's settings right after its entities are deleted (`releaseSceneSpatialDomains`).
- `unregisterSpatialDomain(world, id)`: every member leaves the domain, its grid is dropped and its bit is reused by the next registration. `DEFAULT` can't be unregistered.
- Scene JSON `spatialDomains`: the domains a scene registers for itself, before any of its entities join one (`registerSceneSpatialDomains`). `DEFAULT` takes a partial entry merged over its world settings; other domains need `cellSize` and `maxMembers`.
- "Spatial index" debug tab: a domain dropdown; stats, histogram, oracle, overlays and the cell size apply to the selected domain, and each domain's overlays have their own colours, so several can be shown at once. New rows show how often the selected domain rebuilds and when it last did, and an "All domains" summary lists every domain's policy, members, rebuilds per frame and rebuild time (`getSpatialDomainRebuildStats`, debug env only). A cell size set in the tab now holds when the app registers the domain again, and "Reset to the app's cell size" goes back to the app's.
- The brute-force oracle works per domain (`setSpatialGridOracleEnabled(world, enabled, domainId?)` and the other oracle functions take a domain id, default `DEFAULT`; `getOracleCheckedQueryCount` is new). While on, it also runs 8 probe queries near random members every frame, so a domain nobody queries yet is checked too.

**Changed**

- A member's radius follows its Transform scale: the provider's local radius is multiplied by the largest scale axis on every refresh (light ranges are scale-independent). Mesh radii are `|center| + radius` of the geometry's bounding sphere, so geometry that isn't centred on its origin is covered (eg. `largeWorld`'s crate stack: 1.885 → 2.667).
- `SpatialGrid.addMember`, `removeMember` and `updateRadius` are O(1): the largest indexed radius is only ever raised between rebuilds and made exact by `rebuild()`. This also removes the O(n²) re-insert when the cell size changes.
- `setSpatialGridCellSize` re-registers `DEFAULT` with the new cell size.
- The tab's saved settings are kept per domain (`AEK_debugSpatialGrid`); the old flat settings become `DEFAULT`'s.
- `DEFAULT`'s grid is per scene: built on demand (by its first `SPATIAL_INDEXED` member, a `getSpatialGrid` call, or the rebuild system when persistent members are left) and freed on every scene change, so a scene that indexes nothing has no grid. Its settings outlive the grid, and registering `DEFAULT` without one only stores them. `getSpatialDomain(world, 'DEFAULT')` can now be undefined after a scene change, where it used to return the session's grid. Light object culling reads it that way and no longer creates the grid.
- The tab's cell size override is saved for the scope it was edited in (the world settings, or one scene's), and a scene's settings don't fall back to the world value. A "Scope" row shows which is in use, the dropdown lists only registered domains (plus unregistered ones with a value saved for the current scene or the world), and `DEFAULT` without a grid shows as `DEFAULT (no grid)`.
- The Lights tab's distance edits refresh the light's radius in the spatial index.

**Fixed**

- A mesh's spatial radius no longer goes stale when its scale changes.
- A query between a member's removal and the next rebuild no longer hands `-1` to the visitor.

### Toolkit 1.3.0 (Crescent)

**Added**

- `InstancedMeshPool`'s `spatialDomain` option: `spawn()` joins every instance to that domain, so pool instances can be indexed. The pool registers a radius provider for `INSTANCED_MESH_SLOT` (the pool geometry's radius, scaled by the instance's Transform).

**Changed**

- `InstancedMeshPool`'s component keys and data moved to `ecs/InstancedMeshPoolTypes.ts`, which `InstancedMeshPool.ts` re-exports, so the pool can import the engine's spatial index without an import cycle.

### App 1.4.1 (Preschooler)

**Changed**

- `largeWorld`'s trees are in their own `STATIC` spatial domain, `FOLIAGE` (cell size 16), apart from `DEFAULT`'s light culling members. It rebuilds once when the trees spawn and when they're deleted, never in between. It belongs to the scene, so leaving `largeWorld` unregisters it.
- `largeWorld.scene.json` sets `DEFAULT`'s cell size to 24 for that scene (`spatialDomains`).
- `AppECSRegistry.ts` imports the pool's component types from `InstancedMeshPoolTypes.ts`.

## 2026-10-03 — small-changes-and-refactorings-20261003

### Engine 4.4.0 (Afternoon)

**Added**

- Debug shortcut: F8 opens and closes the profiler window. In production test mode it does the same when the profiler is enabled there, and gives way to an app binding of the same key. It can be rebound through `AppConfig.debugKeys` (`sc-toggle-profiler`).
- Physics entity and character edit windows: a "Set position and cancel velocities" button under "Set position". It moves the body and zeroes its linear and angular velocity (undo restores the position only).
- Characters tab: each row has a Character state window toggle (lit while the window is open) next to the gizmo pin. It follows the row click rule: opens the window, brings it to the front, or closes it when on top. The edit window's button still opens it too.

**Changed**

- The profiler button in the top on-screen tools uses the small icon size, matching the drawer's tab icons.
- The Character state window's false boolean icon is a light grey (the debug text colour) bold X instead of a red circled X, so it no longer looks like the true icon and doesn't dominate the list. New `xBold` icon; `circleXCutout` removed. `$debugBoolFalse` changed with it; the GPU memory tab's over-budget red is now `$debugAlertLight`.

## 2026-10-03 — profiler-mega-window

### Engine 4.3.0 (Afternoon)

**Added**

- Profiler window (debug builds, and production test mode when it is enabled there): a draggable window with a row of icon tabs. It opens from three places: a click on the on-screen stats panels (a setting can turn this off), the Statistics tab's Profiler folder, and a speedometer button next to pause in the top on-screen tools (shown active while the window is open). It measures only while it is open, and releases every measurement it turned on when it closes.
  - Overview: one table of key figures, refreshed 1, 2, 4 or 10 times a second. Shown by default: TFPS estimate (from CPU and GPU time, or labelled CPU-bound without GPU timing), FPS, frame time (average and worst), CPU, GPU, physics (step, dispatch and write-back, plus sub-steps per frame, flagged at the maximum), draw calls and triangles drawn, triangles / vertices / meshes / entities in view and in total, JS heap, and three's GPU memory estimate. Hidden by default: instances, lights and shadow passes, physics bodies, ray casts, PostFX GPU time, long tasks and the scene. A row that can't be measured says why ("WebGPU only", "Chromium only").
  - Objects: breakdowns by kind and by owner (count, triangles, vertices) with two-tone bars (in view solid, culled faded), measured in triangles, vertices or objects; ECS entities per world and entities per component type; the 10 heaviest objects in view, with an Edit button where the entity has an edit window (debug env only); and sparklines of triangles in view, meshes in view and draw calls.
  - GPU memory: the drawer's GPU memory tab, moved here (see Changed).
  - Settings: the update rate, which Overview rows show and in what order, the stats panel entry point, GPU timing, leaving debug helpers out of the counts, and enabling the profiler in production test mode.
  - "In view" comes from a census that repeats three r186's frustum and layer culling against the active camera (the debug camera when it is active), at the update rate. It costs about 0.2 ms per sample in `largeWorld`. Draw calls and triangles drawn (`renderer.info`) remain the ground truth.
- `debug/Profiler.ts`:
  - Tabs: `createProfilerTab`, `openProfilerTab`, `updateProfilerTab` and `isProfilerTabOpen`, the drawer tab contract without `sceneId`.
  - Window and settings: `toggleProfilerWindow`, `isProfilerWindowOpen`, `isProfilerAvailable`, `isProfilerLoadedInThisMode`, `isProfilerEnabledInProdTest`, `getProfilerSettings` / `setProfilerSettings`.
  - `registerStatsSource({ id, label, acquire?, release?, read, availability? })`: a refcounted figure from engine or app code that the profiler views can show.
  - `markDebugHelper(obj)`: the census counts a debug object in its own row. The engine marks its light and camera helpers, physics wireframes, ray helpers, character gizmos, spatial grid overlays and 3D symbols.
  - `registerEntityWindowOpener`: an edit window the Objects tab's Edit button can open. Characters and physics entities register one.
- `setPhysicsStepStatsEnabled(on)` / `isPhysicsStepStatsEnabled()` (`PhysicsAPI.ts`): physics step stats can be switched on and off at runtime in every worker target, through a new one-way `SET_STEP_STATS` worker message. The `stepStatsEnabled` boot setting is the initial value. The PHY stats panel still follows the boot setting only. The `SharedArrayBuffer` stats buffer is now allocated at every `CREATE_WORLD`.
- `getPhysicsObjectCounts()` (bodies, colliders, joints) and `getPhysicsSubStepTotal()` (fixed sub-steps since boot) in `PhysicsAPI.ts`.
- `setFrameProbe(probe | null)` (`MainLoop.ts`): `begin(now)` and `end(now, rendered)` around every frame, in the debug loop and both production loops. While no probe is set, it costs one null check per frame.
- Draggable windows take an `icon`, shown in the header and persisted.
- `profiler`, `objectsCubes` and `gear` icons.

**Changed**

- The GPU memory tab moved from the debug drawer into the profiler window. Its id is `gpuMemory` (was `gpuMemoryControls`), and its settings are kept. The Statistics tab's "Draw calls, memory" button opens it there. It now also shows in production test mode when the profiler is enabled there, without the budget toast and the links to drawer tabs. `registerGPUMemorySource` registers wherever the profiler loads.
- `DEFAULT_DEBUG_DRAWER_TAB_ORDER` no longer lists `gpuMemoryControls`. An app `tabOrder` that still lists it is unaffected (unknown ids are ignored).
- The drawer's tab lifecycle moved into a tab host (`core/Debug/_dbg__TabHost.ts`) that the profiler uses too. The drawer behaves as before.
- The Physics API tab's "Track physics step time (reloads)" shows the boot setting, not the runtime state the profiler switches.
- While the profiler holds the ray stats, the Raycast tab shows live stats with its checkbox off.

**Fixed**

- Physics step stats in `WORKER_THREAD` mode: `dispatchMs` and `writeBackMs` were off by the worker's start time (about ±1.3 s), because a worker's `performance.now()` counts from the worker's creation. The worker now puts its stamps on the main thread's clock (`INIT_PHYSICS` carries `mainTimeOrigin`).

## 2026-10-03 — gpu-memory-debug-tab

### Engine 4.2.0 (Afternoon)

**Added**

- GPU memory tab in the debug drawer (debug builds only, after Renderer). Its figures are three's own bookkeeping of what it created (`renderer.info`), not a driver measurement, and the tab labels the backend (WebGPU or WebGL2).
  - Totals: `info.memory.total` and one row per category (bytes and count), plus render target and geometry counts. A budget bar against a budget in MB (default 512, persisted in `AEK_debugGPUMemory`), with a debug toast once per scene when it's over. The peak since boot and since the last scene enter, with the time it was reached.
  - Frame: draw calls, triangles, render calls and compute calls of the last frame, with min / avg / max over 500 ms. A debug `LATE_MAIN` system samples them right after the render, so the peaks and the budget toast work while the tab is closed too.
  - By owner: registered textures and geometries, the textures a registered material holds alone (eg. clones) and the sources below, summed per owner with three's per-object bytes, so the owners and "untracked" add up to the total. Owner keys of the form `sceneId#cellKey` are listed as cells under their scene. Untracked has its own table per category.
  - Sources: GPU resources that aren't registered assets. Built in: the renderer's output target (MSAA, output pass), shadow maps (VSM blur targets included), the PostFX chain (every render target reachable from its nodes), instance buffers of every `InstancedMesh` in the scene, the sky box env bake, nebula cube and texture-sky PMREM, each viewport, and the debug 3D symbols. Untracked is under 1 % of the total in `skyShowcase`, `space` and `largeWorld`.
  - Cube textures: three r186 counts a cube's faces as 1×1 each, so the tab estimates what's left out (eg. ~12 MB for `space`'s nebula cube) and shows it per source and under "By owner", outside every total.
  - Snapshot and live diff, for leak hunting across scene switches: changed categories; "Left behind", what earlier scene visits since the snapshot created and is still allocated (grouped by kind, label, scene visit and call site, with how many were garbage collected without being destroyed); and registered assets new, gone or changed. "Log diff to console" logs it all, and "Call sites" records where each allocation was made.
  - The Stats tab's "Draw calls, memory" button opens it.
- `registerGPUMemorySource({ id, label, getResources, owner? })` (`debug/GPUMemory.ts`): names a GPU resource that isn't a registered asset for the GPU memory tab. `getResources` returns the three objects (textures, render targets, geometries, attributes), and the tab counts three's bytes for them. Returns a function that removes the source; a no-op outside the debug env.
- `onRendererCreated(fn)` (`core/Renderer.ts`): runs `fn` once with the renderer, right after it is constructed and before its `init()`, or right away if it exists.
- A `memory` icon.

**Changed**

- `DEFAULT_DEBUG_DRAWER_TAB_ORDER` has `gpuMemoryControls` after `rendererControls`.

**Known issues**

- three r186 never deletes a removed `InstancedMesh`'s instance attributes, so `renderer.info.memory` grows by ~3.7 MB of counted attributes on every `largeWorld` visit (the GPU memory tab's diff names them). Fixed in three r187; see `docs/issues/three-instanced-node-attribute-leak.md`.

## 2026-10-02 — triple-buffered-physics-transform-buffer

### Engine 4.1.0 (Afternoon)

**Added**

- One debug edit window per entity: the Light, Camera, ECS world, PostFX pass, physics entity, asset info and character edit windows open a window per entity, so several can be open at a time.
  - A list row opens its entity's window. A second click brings it to the front when another window covers it, and closes it when it is on top. The list shows every entity with an open window as selected.
  - An edit, an undo/redo or a list toggle rebuilds only its entity's window. A global action (eg. toggling all light helpers) rebuilds every open window of the tab.
  - A new window opens where that tab's last window was moved, resized or closed, offset by one header height per window of the tab that is already open.
  - The windows come back after a reload, and stay open over a scene change when the next scene has their entity.
  - Deleting a light, a camera or an ECS world closes only its window. A sky light that the sky box re-creates under the same id keeps its window.
  - The character edit window now stays open over a scene change like the others (it used to be removed).
- Window kinds (`core/UI/DraggableWindow.ts`), for several windows of one kind: the `kind` open prop, `getKindWindowId(kind, key)`, `registerDraggableWindowKind(kind, { content, onClose, sceneTargetResolver })`, `getDraggableWindowsOfKind`, `updateDraggableWindowsOfKind` and `toggleDraggableWindow` (the list row rule above). A kind's options cover each of its windows, also one restored from LS. Closing a kind window removes it, so closed ones don't pile up in LS.
- `registerDraggableWindow(id, { content, onClose, sceneTargetResolver })`: the same once-at-module-load registration for a single window.
- A real stacking order: each layer (app and debug windows) keeps its windows in click order, and a reload restores it. `bringDraggableWindowToFront(id)` and `isDraggableWindowOnTop(id)`.
- Fit to screen: double-clicking a draggable window's header (not a dialog's) moves it to the top center, and shrinks a resizable one that still overflows, never below its min size. `fitDraggableWindowToScreen(id, cascadeIndex?)`, and `fitAllDraggableWindowsToScreen()`, which fits every open window cascaded so every header stays visible. The Debug tools tab's "Center and fit all windows" button runs it.

**Changed**

- Windows are dragged and resized with per-window pointer events, which write at most once per frame (touch dragging works as a side effect).
- Z-indexes follow the stack: app windows from 100 up (below the loaders' 1000), debug windows from 20000 up, two levels per window (its backdrop sits right below it). `getDraggableWindowsDefaultZIndexes`'s active values are the current top window's.
- A draggable window's position is stored and rendered in px. A non-px position (`%`, `vw`, `vh`, the window's centre) is converted when the window mounts. A non-draggable window with a non-px position, like a dialog, stays CSS-centred. Without a `position`, a window opens at the viewport's centre.
- The default max size is the viewport (`100vw` × `100vh`), not its size when the window opened.
- Windows stay reachable. A drag keeps 80 px of the title and the whole header on screen. A viewport resize, a mount and a restore from LS move a window fully on screen (to the top left when it is larger than the viewport). A manual resize stores that axis in px.
- A closed window keeps no DOM: closing tears its content down, and reopening builds it fresh.
- `updateDraggableWindow` rebuilds only the content: it no longer runs `onClose`, brings the window to the front or resets its scroll.
- `DraggableWindowConfig` is the persisted part of a window, with `geometry: { x, y, w, h }` in place of `position` and `size`. `getDraggableWindow` still returns the live objects too (`windowCMP`, `content`, …). The LS key (`AEK_popupWindows`) is the same and old entries load. A kind's last place is stored in it under `__kindGeometry`.
- The ray tester buttons follow the list row rule (open, bring to front, close).
- One time: a Light, Camera, ECS world, PostFX pass, physics entity or asset info window that was open before this update doesn't reopen. Its saved place becomes where the tab's next window opens.
- `PhysicsTransformBuffer` (internal to the physics transport): `markWritten` is `publish`, `latch()` is new, the constructor and `createPhysicsTransformArrayBuffer` take a bank count (1 or `PHYSICS_TRANSFORM_SHARED_BANKS`), and `getWriteCount()` is gone. `CREATE_WORLD`'s response carries `bankCount`.
- `latchPhysicsSnapshot()` (`PhysicsAPI.ts`), called by every main loop variant right after `timer.update()`. Custom loops that drive `stepPhysics` themselves must call it first in each frame.

**Deprecated**

- `registerDraggableWindowContentFn`, `registerDraggableWindowSceneTargetResolver`, `registerDraggableWindowCmp` and `addOnCloseToWindow`: use `registerDraggableWindow` or `registerDraggableWindowKind`.
- `getDraggableWindowsStartingWith` and `closeAllDraggableWindowsStartingWith`: use window kinds.

**Fixed**

- Physics reads no longer tear in `WORKER_THREAD` mode with the `SharedArrayBuffer` transport (`SHARED_MEMORY`). The worker used to rewrite the one shared transform buffer while the main thread read it, so a snapshot's step stamp could disagree with its poses, two systems in the same frame could see different steps, one pass over the bodies could mix two steps, and a single body could be half old, half new. This showed up as occasional interpolation spikes. The buffer is now a lock-free triple buffer: the worker publishes each finished, stamped write-back by an atomic bank swap, and the main loop latches the newest one at the start of every frame. Every reader in a frame (held keys, `APP_PHYSICS_STEP`, the TRANSFORM sync, interpolation, debug wireframes) sees the same complete snapshot, and a write-back that lands mid-frame is read from the next frame on. Memory: three banks, about 320 KiB at the default 2048 bodies. `MAIN_THREAD` and the `MESSAGE_BATCH` fallback are unchanged.
- Draggable windows:
  - Windows with a non-px position no longer jump by half their size when a drag starts, and come back at the same place after a reload.
  - A window can no longer be lost off screen after a viewport resize or a reload on a smaller screen, or left with only its header buttons on screen (which can't be grabbed).
  - A reopen with `resetPosition` / `resetSize` moves a live window. It used to overwrite the stored position while the window stayed where it was.
  - `onClose` ran twice for a `removeOnClose` window, and on every `updateDraggableWindow`.
  - Array `windowClass` / `backDropClass` values were ignored, and the height was clamped by the min width.
  - The last saveable window removed stayed in LS, and every window lookup parsed LS.
  - The clear-LS scope dialog opened under the debug windows.

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
