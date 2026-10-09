Status: in progress | Phases 1-2 implemented
Category: Instructions, Hub
Epic: p550_aekasha-hub-epic.md

# Hub Features & Homepage Content

The Hub's content beyond the generated sections and the examples: one page per key feature of the
engine, the Features landing page, and the homepage's final content. Written last, because a
feature page links its API (p553) and its example (p554).

---

## 1. Grounding

- **CLAUDE.md's Architecture sections** are the most exact description of each subsystem, checked
  against the code on every change. **readme.md's Features** is the public summary.
- The CLAUDE.md sections that are features: ECS core, the scene/asset data pipeline, physics
  (threads, determinism, tiers), the sky box, viewports, views and the material editor, the spatial
  index, instanced mesh pools, LOD chains, LOD selection, impostors and the debug system. Plus the
  asset optimization pipeline (Commands) and the dev file server (Debug system).
- Not features: the three-folder split, plans, bootstrap flow, build config notes.
- **`docs/issues/`** has three issues (p551 gives each a page). Two are three.js bugs that
  affect lights and instancing.
- **`CHANGELOG.md`**'s latest entry is exposed by p551 as `latestChange` in `hub-data.js`.
- **Landed on `main` after this plan was written** (impostor LOD Phases 4-5, `_DONE_p351`; alpha
  coverage mips, `_DONE_p341`; both in `CHANGELOG.md`'s `2026-10-08 — finalize-impostor-billboard-lod`
  entry, engine 4.13.0 and app 1.8.0). What the feature pages need from it:
  - **Exported impostors.** An impostor bakes at load (20-115 ms), or is exported once from the LOD
    tab's Impostors folder into the repo: `<id>.impostor.json` (`schemas/impostorSchema.ts`, union
    by `kind`: `OCTAHEDRAL` | `CROSS_QUADS`; written by the export, never by hand), its
    `<id>.textureAtlas.json` and the PNGs, which the asset pipeline encodes to KTX2 (about a quarter
    of a bake's GPU memory). A scene that lists the ids in its JSON's `impostors` loads them, and
    `generateOctahedralImpostor` / `generateCrossQuads` called with a listed `id` build from the
    export instead of baking. The debug env warns when the source mesh, material or options no
    longer match the export's fingerprint (`getImpostorSourceHash`); the export is used anyway.
    New exports go to `AppConfig.lod.impostorExportDir` (default `src/app/impostors`, where
    largeWorld's and lodShowcase's are). CLAUDE.md's Impostors section, "Exports".
  - **The `lodShowcase` scene** (`src/app/lodShowcase.ts`, `name: "LOD showcase"`): the LOD
    system's demo and verification scene, one feature per lane, every level of every lane on screen
    from the start camera (hand-made levels in a `*.mesh.json`, a generated chain with `AUTO`, a
    tree pool ending in exported cross-quads and a cull fade, a pool ending in an exported flat
    octahedral impostor, a baked and an exported impostor side by side, a static instance cell),
    under the `dayNight` sky held at 15:00. Its scene-scoped "LOD demo" tab has camera stops on
    both sides of every switch, a dolly down the lanes, the time of day and each lane's levels and
    triangles. `readme.md`'s LOD selection feature and its LOD example point at it.
  - **Numbers worth quoting, measured in `_DONE_p351` Phase 5** (WebGPU, Apple GPU): 400 knots at
    the impostor band's distances add 2.3 ms of GPU time as the 16,384-triangle mesh, 0.12 ms as
    the chain's 982-triangle last level, 0.07 ms as a flat impostor (`surfaceDepth: false`) and
    0.43 ms as one with surface depth (writing depth from the shader turns off early depth tests).
    So an impostor pays off against heavy meshes, not low-poly ones (largeWorld's 80-triangle
    rock). The no-pop recorder on the dolly: 200 level changes, 0 pops (176 with fades off).
  - **Alpha-coverage mips:** `optimize.alphaCoverage` (a `*.texture.json` or an atlas slot, set to
    the material's `alphaTest`) keeps an alpha-cut texture's coverage in its mip levels, so leaf
    cards and impostor edges don't thin out with distance. An exported impostor's albedo slot gets
    it by itself. `docs/techniques/asset-optimization.md` has two new sections: "Alpha-cut
    textures" and "Impostor atlases".
  - **Texture atlases:** a slot can be a ready-made `image` (every cell needs a `rect`) and
    `mipChain: "FULL"` builds every mip level down to 1 × 1.
  - **The dev file server's second writer:** the impostor export writes its four files in one
    `writeDevFiles` batch, shows the gather's result as a toast after the reload, and without the
    dev files (a LAN device, `AEK_DEV_FILES=false`) downloads them and lists the paths.
  - **Asset JSON types:** CLAUDE.md's suffix list now names all of them, `*.impostor.json` new
    among them (also `*.textureArray.json`, `*.textureAtlas.json`, `*.postFx.json`, which the
    list was missing before).

## 2. Design

### 2.1 Feature pages

`hub/pages/features/<slug>/`, one each:

| Slug                 | Feature                                                                                                                                            | Example (p554)                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `rendering`          | WebGPU renderer, WebGL fallback, PostFX                                                                                                            | Quick start                                         |
| `ecs`                | ECS: entities, components, plugins, stages, managed entities                                                                                       | Custom component & system                           |
| `physics`            | Physics API, threads, transform buffer, deterministic loads, simulation tiers                                                                      | Physics                                             |
| `scenes-and-assets`  | Scene and asset JSON (every suffix, the scene's `impostors` list), the gatherer, `__saveData`                                                      | Quick start                                         |
| `asset-optimization` | The asset pipeline: KTX2, meshopt/Draco, budgets, lock file, alpha-coverage mips, atlas images and full mip chains                                 | Toolkit                                             |
| `sky-box`            | The layered sky, presets, day-night                                                                                                                | Sky box & day-night                                 |
| `lod`                | LOD chains, selection, cross-fades, impostors (baked and exported), instanced pools                                                                | LOD & instancing, and `lodShowcase` (the full demo) |
| `spatial-index`      | Grids, domains, scene scope                                                                                                                        | —                                                   |
| `viewports`          | Viewports and views                                                                                                                                | —                                                   |
| `debug-suite`        | Drawer tabs (the LOD tab's overlay and Impostors export among them), profiler, GPU memory, undo, character tools, dev file server, material editor | Your own debug tab                                  |
| `characters`         | The dynamic character controller                                                                                                                   | —                                                   |
| `toolkit`            | What the toolkit holds and how to use or copy it                                                                                                   | Toolkit                                             |

Each page has the same shape:

- A summary: what it does and why, in the brand's voice.
- How it works, with short code blocks (snippet includes where an example has the code).
- Key APIs, as `api:` links.
- The example, through p554's `scene` directive and its card.
- Related issues, linked when an issue affects it.
- "Read more": the technique docs and, in dev, the CLAUDE.md section.

Metadata: `aek:tags`, `aek:icon`, `aek:featured` (4 pages: rendering, physics, ecs, debug-suite,
as in the design's "WebGPU Renderer / Physics / Modular Architecture / Developer Tools").

The content is checked against the code, like CLAUDE.md, not paraphrased from the readme.

The `lod` page carries the most since §1's additions:

- **How it works** in the order a developer meets it: a level is a screen size (`r × k / d`); levels
  are hand-made (a `*.mesh.json`'s `lod`, which a JSON include can show whole:
  `src/app/lodShowcase/lodShowcaseHandMade.mesh.json`), or `AUTO` from a chain; cross-fades; pools;
  impostors as the last level.
- **Impostors** as a choice with its costs: cross-quads for vegetation, octahedral for anything
  seen from above, `surfaceDepth: false` for objects standing on the ground, and only against heavy
  meshes (§1's numbers). Then bake at load against export, and the export's workflow: the LOD tab's
  Impostors folder, the four files, the scene's `impostors` list, the stale warning and re-export.
- **"Read more"** links `docs/techniques/asset-optimization.md#impostor-atlases` and
  `#alpha-cut-textures` next to the CLAUDE.md sections.
- **The example:** p554's `exampleLod` for the code, and `lodShowcase` for seeing every feature at
  once (p554 §5's question 5: the LOD example page ends with `::: scene lodShowcase` as the full
  demo).

### 2.2 The `cards` directive

`::: cards <source> [filter]` renders a grid of cards from the page tree:

- `features featured` gives the featured features as icon columns.
- `examples featured` gives image cards.
- `features` gives every feature.

Each card shows the page's `aek:icon` or `aek:image`, title, description and a link. Order comes
from `aek:order`.

### 2.3 Features landing page

An intro (what Ækasha is, the brand's principles: Primordial Performance, Modular Infinity,
Threaded Reality), then `::: cards features`, grouped as Core, World, Performance and Tools.

### 2.4 Homepage

Following the design's layout (p551's skeleton):

- **Hero:** "WELCOME TO THE / Ækasha Hub", the intro text, the section buttons, and the side text
  "BUILD / EXPLORE / CREATE" with the engine description from `package.json`
  (`engine_metadata.description`).
- **Featured features:** "Powerful and flexible." and `::: cards features featured`, with "View all
  features".
- **Featured examples:** "See it in action." and `::: cards examples featured` (Quick start, Physics,
  Toolkit, with their Hub images), and "View all examples".
- **Side column:**
  - "What's new": from `latestChange`, the date, the parts and their versions, and a link to the
    entry on the Version page.
  - Quick links: Documentation, Examples, Issues and GitHub (`package.json`'s repository).
  - A brand card ("Ækasha / Build. Explore. Create.").

### 2.5 Coverage check

A warning in `hub:build`: every CLAUDE.md `### ` section under Architecture that isn't in an ignore
list (`hub.config.ts`: the folder split, plans, bootstrap flow, build config notes) maps to a
feature page (by `aek:covers` in its head, eg. `content="Sky box"`). A new subsystem section without a
page is a warning, so the Hub rule (p550 §5) has a check behind it. It's skipped in `public` builds
outside the repo.

- `aek:covers` takes a comma-separated list: the `lod` page covers four sections (Instanced mesh
  pools, LOD chains, LOD selection, Impostors). The Impostors section now also holds the exports
  and the `lodShowcase` scene, so a change there is a change to the `lod` page.
- The ignore list also needs "Ækasha Hub" (the section `_DONE_p551` added): it's tooling, not a
  feature.

## 3. Phases

### Phase 1 — Feature pages — done

§2.1, §2.2 (the `cards` directive) and §2.3.

**Exit:**

- Every page in the table builds, with `api:` links that resolve.
- Each page's example link opens its scene in dev.
- A reviewer spot-checks three pages against the code.

As built:

- `::: cards` was p554's already (`::: cards <page path>`): §2.2's sources are page paths, and
  the filters are arguments after it, `featured` and `group=<name>` (a new `aek:group` meta).
  `featured` adds the class `hubCards_featured` for Phase 2's icon columns. The Features page
  groups with a heading per group, each with its own `::: cards features group=<name>`.
- Pages: one `index.html` with two slots each, `intro` (the summary and the example's
  `::: scene` panel) and `guide` (the rest). Titles and menu labels: Rendering, ECS, Physics,
  Scenes and assets, Asset optimization, Sky box ("Sky box and day-night"), LOD and impostors,
  Spatial index, Viewports and views, Debug suite, Characters, Toolkit. Groups: Core (rendering,
  physics, ecs, scenes-and-assets), World (sky-box, characters, viewports), Performance
  (asset-optimization, lod, spatial-index), Tools (debug-suite, toolkit). Featured: rendering,
  physics, ecs, debug-suite.
- Examples: rendering shows `exampleHubHero` (its bloom pass is the PostFX snippet) and links the
  quick start; asset-optimization and toolkit show `exampleToolkit`; scenes-and-assets
  `exampleQuickStart`. Spatial index, viewports and characters have none (open question 2); they
  point at app scenes by `?startScene` where one exists (`physicsTiers`, `skyShowcase`, `space`,
  `thirdPersonGymScene`, `topDownTestScene`).
- "Read more" needed two link kinds the Hub didn't have:
  - `repo:` links (`markdown.ts`, `repoFiles.ts`): a repo file, checked with its `#heading`
    (GitHub's slug) or `#L<line>`; GitHub at the build's commit in `public`, the editor in `dev`.
  - `aek:covers` (parsed now, not in Phase 3: the coverage check reuses it) and
    `::: claude-md` (`claudeMd.ts`): the dev-only line linking the page's CLAUDE.md sections.
    Both modes fail on a name CLAUDE.md doesn't have. `covers` per page: rendering `Snapshots`
    (added to CLAUDE.md after this plan), viewports `Viewports, Views`, the others as §2.5.
    Asset optimization, characters and toolkit cover no Architecture section.
- New regions (comments only, no version bump): `create-renderer` in `src/index.ts` and
  `dynamic-character` in `src/app/scene_topDownTest.ts`.
- 12 Lucide icons from `lucide-static` 1.53.0 (the version the Hub's others are).
- The search index was already over 1 MB (1.04); the changelog is now out of it
  (`hubSearchSkip` on the Version page's changelog), and with every page it's 971 kB.
- Fixed while checking the ECS page: `ECSSystemStage`'s comment in `src/AppECSRegistry.ts` put
  `APP_PRE_PHYSICS` in the app loop; it runs with `MAIN`, also while paused.

### Phase 2 — Homepage — done

§2.4.

**Exit:** the homepage has the design's sections with real content. "What's new" follows
`CHANGELOG.md` (adding an entry updates it on the next build). It holds up at 375 px.

As built:

- The homepage is a generated section (`devTools/hub/generated/home.ts`, path `''`) with three
  slots: `generated-hero-side` (`engine_metadata.description`), `generated-whats-new` and
  `generated-quick-links`. `hero-side.md`, `whats-new.md` and `quick-links.md` are gone.
- "What's new" is rendered at build time, not from `hub-data.js`: the date, the branch, a row per
  part (version and codename; Project as "Tooling") and "Read the changelog entry". Its anchor is
  the heading's `slugify`, since `latestChange.hash` is only filled when the Version page renders
  (after the homepage); the link is a `hub:` link, so `checkLinks` fails the build if it drifts.
- `hub.config.ts` has no `githubUrl` any more: the header's, the footer's and the quick links'
  GitHub links are `package.json`'s repository (`getRepoWebUrl`), like the source links.
- The quick start moved from a slot on the Examples page to its own page,
  `examples/quick-start/` (`intro` with its scene panel, `setup`, `first-scene`; `aek:order` 10),
  so it can be a card. Featured examples: Quick start, Physics, Toolkit.
- `::: cards` adds `hubCards_icons` when no card has an image: `.hubCards_featured.hubCards_icons`
  are the icon columns (4, 2 under 48rem, 1 under 26rem), featured image cards a row of 3 (1
  under 34rem). Both by container query on the cards' parent, since the main column narrows
  beside the side column.
- "View all features / examples" are `hubMoreLink`s in the page markup (with the arrow icon).
- The quick start scene's cube uses `triplanarCheckerboard` without its plus signs
  (`matOverrides`); the toolkit's legacy `checkerBoard` material is removed.
- Known: `yarn hub:build --no-api` fails on the feature pages' `hub:documentation/engine/…`
  folder links (Phase 1), since those pages exist only with the API built. For Phase 3.

### Phase 3 — Coverage check, docs and versioning

§2.5. CLAUDE.md's Hub section mentions `aek:covers` and the check. `readme.md` links the Hub's
Features from its own Features. `CHANGELOG.md` Project entry. Mark the plan done, and the epic
(p550) when its children are done.

## 4. Versioning

Project only (Hub content and tooling).

## 5. Open questions

1. **readme.md and the Hub:** the readme's Features list could shrink to a short list linking the
   Hub's pages once the Hub is public, so the two don't repeat each other.
2. **Features without an example** (spatial index, viewports, characters): examples for them go
   into p554's open question 4 when the pages show what's missing.
3. **Translations:** none planned. The page format (slots per `.md`) wouldn't stop a later
   `<id>.<lang>.md`.
