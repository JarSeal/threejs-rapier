Status: draft | not-implemented
Category: Instructions, Examples, Scene
Epic: p550_aekasha-hub-epic.md
Blocks: p555_hub-features-and-homepage-content.md (its example links and cards)
Related: \_DONE_p342_dev-file-server.md (the Hub images are written through `writeDevFiles`), \_DONE_p300_asset-optimization-pipeline-plan.md (the Æ symbol GLB), p450 "Toolkit and asset housekeeping" (`docs/templates/todo-plan-prompts.txt`; the toolkit's public asset folder)

# Hub Examples, `?startScene` & Example Scenes

The Hub's Examples section, each page backed by a real scene in the app ("Example: …") that the page
opens in debug or prod test mode with a new URL parameter, `?startScene=<sceneId>`. Also the toolkit's
Ækasha symbol model and the engine-rendered images the Hub uses (example cards and the homepage hero).

---

## 1. Grounding

- **The start scene** is hard-coded in `src/index.ts` (`await loadScene({ sceneId: 'sceneTestECS' })`).
- **Its only override** is in `loadScene` (`core/SceneLoader.ts`). On the first load
  (`!firstSceneLoaded`), in the debug env or `IS_PROD_TEST_MODE`, it reads the Debug tools state
  (`getDebugToolsState(true)`, `AEK_debugTools`). When `scenesListing.useDebugStartScene` and
  `debugStartScene` are set, it replaces `sceneId` and clears `overrideNextSceneFn` (so the scene
  code comes from `sceneFileObjects`). In the debug env only, it also switches to the debugger's
  scene loader when `useDebuggerSceneLoader` is set.
- **URL params** are read in `core/Config.ts` with `new URLSearchParams(window.location.search)`
  (`isProdTest`, `isDebug`, both `=== 'true'`), with no shared helper. `physicsProbe` is read the
  same way in `_dbg__PhysicsDeterminism.ts`.
- **Scenes:** `*.scene.json` under `src/app/` with `id`, `sceneFile` (relative to `src/app`) and an
  optional `name` and `description` (`schemas/sceneSchema.ts`; `name` is stripped from production
  data). Both scene dropdowns show `name`, else `[id]` (`_dbg__DebugTools.ts`). The gatherer walks
  all of `src/`, so a scene in a subfolder is found.
- **Toolkit pieces the examples need:**
  - the `checkerBoard` and `triplanarCheckerboard` materials (`src/toolkit/materials/`);
  - `HoverEffect` (bobbing, `src/toolkit/ecs/effects/`) and `MutualGravity`;
  - `generateAsteroid` (`src/toolkit/geometry/`).
  - The toolkit has no models yet.
- **Imported assets** use a public-relative `fileName` (`testImport.importedAsset.json`:
  `/debugger/assets/testModels/box01.glb`). The asset pipeline can keep a GLB Draco-compressed
  (`codec: 'draco'`, `devTools/assetPipeline/gltf.ts`) or re-encode it with meshopt.
- **The Æ glyph** is one path with an inner hole in `src/public/favicon.svg` (viewBox 32×32).
  three's `SVGLoader` parses SVG text with the browser's `DOMParser`. `draco3dgltf` and
  `@gltf-transform/*` are devDeps.
- **Writing images into the repo from the browser:** `writeDevFiles` with `encodePNG` (debug env,
  `yarn dev`), into `src/app/`, `src/toolkit/` or `src/public/`, not `hub/`.
- **Scene-scoped debug tabs** are created from the scene file in the debug env through a dynamic
  `import()` of an `_dbg__` module (`app/_dbg__spaceDemo.ts`, `createDebuggerTab({ sceneId })`).
- **Landed on `main` after this plan was written** (impostor LOD Phases 4-5, `_DONE_p351`; alpha
  coverage mips, `_DONE_p341`):
  - **`lodShowcase`** (`src/app/lodShowcase.scene.json` + `lodShowcase.ts`, `lodShowcase/`) is
    already a full LOD demo: six lanes (hand-made levels in a `*.mesh.json`, a generated chain with
    `AUTO`, a tree pool ending in exported cross-quads, a pool ending in an exported flat
    octahedral impostor, a baked and an exported impostor side by side, a static instance cell),
    every level on screen from the start camera. It's an ordinary app scene in `src/app/`, not
    under `examples/`, named "LOD showcase" (not "Example: …"), and its `description` cites its
    plan file, so it isn't Hub text as it is. A lane is a module (`lanes/*.ts`, `ShowcaseLane`)
    placed by a layout engine (`lodShowcase/layout.ts`): good to run, too much code for a page.
  - **Its "LOD demo" tab** (`app/_dbg__lodShowcase.ts`, `createLodShowcaseTab`) is a second
    scene-scoped tab next to the space demo's, persisting one state key (`AEK_debugLodShowcase`).
    Its camera stops are exported (`setShowcaseCameraStop`, `getShowcaseCameraStops`), so a Hub
    image can be taken from a named stop; the dolly (`startShowcaseDolly`) is a scene app looper.
  - **Exported impostors** (CLAUDE.md, Impostors, "Exports"): the LOD tab's Impostors folder writes
    `<id>.impostor.json`, `<id>.textureAtlas.json` and two PNGs through `writeDevFiles` into
    `AppConfig.lod.impostorExportDir` (default `src/app/impostors`), or where the impostor's files
    already are. A scene loads them by listing the ids in its JSON's `impostors`. Without the dev
    files the export downloads the files and lists their paths, and after a write it shows the
    gather's result as a toast (`onDevDataGathered`). That is the precedent §2.4's "Save Hub
    image" follows.
  - **What the LOD lanes found** (`_DONE_p351` Phase 5) that an LOD example meets too:
    - `AUTO`'s default (`maxPixelError` 1 at 1080p) keeps a chain's finer levels only very near
      the camera. lodShowcase's knot stops its chain at 6 % and asks
      `{ auto: true, maxPixelError: 0.25 }`, resolving the levels with `resolveAutoLod` before
      placing the meshes.
    - An impostor pays off only against heavy meshes, and a flat one (`surfaceDepth: false`) for
      objects standing on the ground (§2.2's `exampleLod` row).
    - An exported impostor is only fresh while the call's geometry, material and options match the
      export's fingerprint; the debug env warns otherwise.
    - An `InstancedMesh` entity (a static instance cell) is placed through its `Transform`, not
      `mesh.position`.
    - A `*.mesh.json` is one entity at its own position; copies of it are placed in code.

## 2. Design

### 2.1 `?startScene=<sceneId>` (engine)

- `core/Config.ts` reads `startScene` next to `isDebug` / `isProdTest` and exports
  `getStartSceneQueryParam(): string | null` (null outside the debug env and prod test mode, so a
  production build never reads it).
- `loadScene`'s first-load block applies it before the Debug tools' start scene, which it wins over:
  it sets `sceneId` and clears `overrideNextSceneFn`, the same way. The debugger's scene loader
  option still applies in the debug env.
- An id with no scene data (`getGeneratedSceneData`) logs a warning (and a debug toast where the
  toaster exists) and falls back to the start scene it would have loaded without the param.
- It's read once. Later `loadScene` calls and HMR reloads that keep the URL work as before (the param
  only affects the first load of each page load).
- URLs: `/?isDebug=true&startScene=examplePhysics`, `/?isProdTest=true&startScene=examplePhysics`.

### 2.2 Example scenes (app)

In `src/app/examples/<name>/`: `<id>.scene.json` (`name: "Example: …"`, a `description` that the Hub
page reuses), `<id>.ts`, and any assets. They're ordinary app scenes: they appear in the scene
dropdowns (sorted together by their "Example:" prefix) and load in every mode. Each scene file marks
the code its Hub page shows with `// #region <name>` (p552 §2.3), so the page and the scene can't
drift.

| Scene id | Name | Shows | Hub page |
| --- | --- | --- | --- |
| `exampleQuickStart` | Example: Quick start | A cube with `checkerBoard`, hovering (`HoverEffect`), a camera and a light. The smallest complete scene. | `/hub/examples/` (with the dev environment set-up) |
| `examplePhysics` | Example: Physics | A static plane, with a box, sphere, capsule and cylinder dropping on it (`createPhysicsEntity`), and a key to drop more. | `/hub/examples/physics/` |
| `exampleToolkit` | Example: Toolkit | The Æ symbol model (§2.3) hovering, with `triplanarCheckerboard`. | `/hub/examples/toolkit/` |
| `exampleSkyBox` | Example: Sky box & day-night | A `DAY_NIGHT` preset, a few objects, and keys or a small HUD for `setTimeOfDay` / `playDayNight` / speed. | `/hub/examples/sky-box/` |
| `exampleEcs` | Example: Custom component & system | A `SPIN` component and its system: `AppECSRegistry.ts` types, `registerPlugin`, `addSystem` in a stage. | `/hub/examples/ecs/` |
| `exampleLod` | Example: LOD & instancing | `createInstancedLodPool` over a generated chain (`generateLodChain`), with the LOD tab's overlay to see levels change. | `/hub/examples/lod/` |
| `exampleDebugTab` | Example: Your own debug tab | A scene-scoped `createDebuggerTab` with a persisted setting and a button. | `/hub/examples/debug-tab/` |
| `exampleHubHero` | Example: Hub hero | The homepage art: the `SPACE` sky box, toolkit asteroids, and an emissive ring around a large asteroid (§2.4). No Hub page of its own. | — |

The pages explain the code (from the regions), list the APIs used (`api:` links once p553 is in) and
link the feature pages (p555).

`exampleLod` since lodShowcase (§1): it stays the small scene a page can show whole. A pool over a
heavy procedural mesh (lodShowcase's knot, not a low-poly one: a chain of a low-poly mesh has
nothing to remove) with its generated chain's levels and an impostor last. The impostor should be
exported, so the example loads without a bake: export it once from the LOD tab, move its files
next to the scene (a re-export then writes there) and list it in the scene's `impostors`. The page
links lodShowcase as the full demo (open question 5).

### 2.3 The Æ symbol model (toolkit)

`devTools/toolkit/buildAekashaSymbol.ts` (`yarn tsx`, run when the glyph changes; its output is
committed):

1. Reads `src/public/favicon.svg` and parses it with three's `SVGLoader`, with `linkedom`'s
   `DOMParser` set on `globalThis` for the call.
2. `SVGLoader.createShapes` per path (keeps the inner triangle as a hole), then `ExtrudeGeometry`
   (depth and a small bevel, curve segments enough for the rounded corners).
3. Flips y (SVG is y-down), centres it, scales it to 1 unit high, and computes normals.
4. Writes a GLB with gltf-transform (one mesh, one default material, `name: 'aekashaSymbol'`), then
   compresses it with `draco()` (`draco3dgltf`'s encoder).

Output:

- `src/public/toolkit/models/aekashaSymbol.glb`, the Draco source.
- `src/toolkit/models/aekashaSymbol.importedAsset.json` with its mesh codec set to `draco`, so the
  pipeline's output stays Draco as the prompt asks.

If p450 has given the toolkit a public asset folder by then, the GLB goes there instead. The
toolkit's readme section lists the model.

### 2.4 Hub images

A debug-only, scene-scoped "Hub" tab for the example scenes (`app/examples/_dbg__exampleHub.ts`,
created by each example scene in the debug env) with **Save Hub image**:

- renders the active camera's view into a render target at a fixed size (1600×1000 for cards,
  2880×1080 for `exampleHubHero`), with PostFX;
- writes `<sceneId>.hub.png` beside the scene through `writeDevFiles` + `encodePNG`.
- follows the impostor export (`core/Debug/Lod/_dbg__ImpostorExport.ts`) where the dev files
  can't write: it downloads the PNG and names the path to put it at.

The generator picks images up by reference (`aek:image` in a page's head or a `cards` entry,
p555): it converts them to webp at the sizes the layout uses (sharp) and records the PNG as the
page's dependency. The homepage hero switches from the placeholder (p551) to
`exampleHubHero.hub.png`.

### 2.5 Scene links on example pages

A `::: scene <sceneId>` directive (p551's directive registry):

- **`dev` mode:** "Open in debug" (`/?isDebug=true&startScene=<id>`) and "Open in prod test"
  (`/?isProdTest=true&startScene=<id>`) buttons, opening in a new tab. The id is checked against
  `src/_engine/generatedAppData.json`: an unknown one is a build error.
- **`public` mode:** nothing is rendered. Instead the page shows a short note on running the example
  locally (`yarn dev`, then the URL), the same for every example and written once in the directive.

## 3. Phases

### Phase 1 — `?startScene` (engine)

§2.1.

**Exit:**

- `?isDebug=true&startScene=space` boots into the space scene, also while the Debug tools' start
  scene is set to another one.
- `?isProdTest=true&startScene=space` does the same.
- An unknown id warns and loads the usual start scene.
- A `yarn build` production page ignores the param.

### Phase 2 — Scene links and Hub images

§2.4 (the tab and the generator's image references) and §2.5.

**Exit:**

- On a test page, the directive's buttons open the scene in both modes during `yarn dev`.
- `yarn hub:build` leaves them out and shows the note.
- An unknown id fails the build.
- "Save Hub image" in a scene writes its PNG, and the page shows it as webp.

### Phase 3 — Quick start, Physics, Toolkit (and the Æ model)

§2.2's first three scenes and pages, and §2.3. The Quick start page carries the dev environment
set-up: Node from `.nvmrc` (22.13.0, `nvm use`), yarn 1, `yarn`, `yarn dev`, opening
`http://localhost:8080/?isDebug=true`, `h` for the debug drawer, and `yarn dev:https` for a phone.

**Exit:**

- The three scenes load in debug and prod test.
- Their pages include their regions and show their images.
- The Æ model is Draco-compressed (`KHR_draco_mesh_compression` in the GLB), loads through
  `importAssetAsync`, and its hole is open.

### Phase 4 — The other examples and the hero

§2.2's remaining scenes and pages, and the hero image (`exampleHubHero`, §2.4).

**Exit:** every example page opens its scene. The homepage hero is the engine render.

### Phase 5 — Hub content and docs

- The Examples landing page: what each example shows, as cards.
- CLAUDE.md:
  - `?startScene` with the other URL flags.
  - The example scenes, their regions and the Hub tab, in the Hub section.
  - The toolkit model and its build script.
- `readme.md`: URL flags (`startScene`) and the toolkit's Features list (the model).
- `docs/techniques/hub-authoring.md`: the `scene` directive and Hub images.

### Phase 6 — Versioning and marking the plan done

§4.

## 4. Versioning

- **Engine minor:** `?startScene` and `getStartSceneQueryParam`, a new public behaviour.
- **Toolkit minor:** the Æ symbol model and its asset JSON.
- **App minor:** the example scenes and their Hub tab.
- **Project:** the model's build script, the Hub's directive and images.

## 5. Open questions

1. **Should the example scenes live in the toolkit** (ready-made for any app built on the engine)
   instead of the app? The app is where a developer starts and where the snippets make sense
   (`AppECSRegistry.ts`), so they stay in the app for now.
2. **Hide the examples from production builds?** They're in the app's scene list in every build.
   An `isExample` scene flag (like `isDebugScene`) could leave them out of production data.
3. **Live examples in the public Hub:** embedding the engine (or a built example) in `dist-hub/`
   pages. Out of scope: the public Hub is engine-free (p550 §1). Hosting the built app next to it
   would make the links work there too.
4. **More examples:** input and key bindings, characters, viewports, PostFX, the material editor.
   Added when their pages are written (p555 lists the gaps).
5. **`exampleLod` and `lodShowcase`** (§1): the showcase already shows every LOD feature, with a
   tab to explore it, but its code is spread over a layout engine and six lane modules. Options:
   - keep both: `exampleLod` for the page's code, and the LOD page's `::: scene lodShowcase` as
     "the full demo" (the directive takes any scene id). Recommended;
   - drop `exampleLod` and build the page on lodShowcase, including one lane's region per feature;
   - move lodShowcase into `src/app/examples/` as an example, renamed and with Hub text as its
     description (later LOD plans add lanes to it, so its home is a choice for them too).

   Whichever: lodShowcase is a strong featured-example card for p555's homepage (every level of
   every lane in one frame), taken from a camera stop.
