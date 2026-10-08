Status: draft | not-implemented
Category: Dev tooling, Hub, Documentation
Epic: p550_aekasha-hub-epic.md
Blocked by: p552_hub-code-blocks-and-search.md (signature highlighting and search entries)
Blocks: p555_hub-features-and-homepage-content.md (its `api:` links)

# Hub API Documentation

The Hub's Documentation section: every exported engine and toolkit symbol with its JSDoc, rendered
in the Hub's own style and linked from the other pages, instead of TypeDoc's default theme in a
separate `docs-api/` site.

---

## 1. Grounding

- **TypeDoc 0.28.20** runs from `typedocOptions` in `tsconfig.json`: `entryPoints`
  `["src/_engine/**", "src/toolkit/**"]`, `out: "docs-api"`, `theme: "default"`,
  `excludePrivate: true`, `readme: "none"`. No plugins, no JSON output. `yarn docs` writes HTML
  to the gitignored `docs-api/`.
- **What's documented:** about 3,390 `/**` blocks in `src/_engine` outside `_dbg__` files. About 62% of
  its 1,922 top-level exports have a JSDoc right above them. `src/toolkit` has 116 blocks.
- **What shouldn't be:** the `_dbg__*` files are the debug implementations behind the public
  `debug/*.ts` entry points (CLAUDE.md, Debug system). `generatedAppData.json` and
  `generatedAppFns.ts` are generated from the app. The glob entry points include all of them today.
- **`{@link}` is used** across the engine's JSDoc (`{@link LoadSceneProps}` in
  `core/SceneLoader.ts`).
- **The repo URL** is in `package.json` (`repository`, `engine_metadata.repository`).
- **Landed on `main` after this plan was written** (impostor LOD Phase 4, `_DONE_p351`; about 60
  more `/**` blocks in `src/_engine`, the toolkit unchanged):
  - `core/Lod/Impostors/` has four new modules: `ImpostorExports.ts` (`getImpostorExport`,
    `warnIfImpostorExportStale`), `ImpostorFormat.ts` (`IMPOSTOR_EXPORT_FORMAT_VERSION`,
    `IMPOSTOR_KINDS`, `getImpostorDefSlots`, `ImpostorAtlasVOrigin`; no imports, since the gatherer
    and the schema share it), `ImpostorRegistry.ts` (`getImpostorRecord`, `getImpostorRecords`) and
    `ImpostorSourceHash.ts` (`getImpostorSourceHash`). The generators split into bakes
    (`bakeOctahedralImpostorAtlases`, `bakeCrossQuadsAtlases`) and builds
    (`buildOctahedralImpostor`, `buildCrossQuads`). With `Octahedral.ts` and the material, the
    folder is nine modules: the landing page's `core/Lod/Impostors/` group.
  - `schemas/impostorSchema.ts` (`ImpostorAssetSchema`, a `z.discriminatedUnion` by `kind`;
    `ImpostorDef`, a conditional type over its `z.infer`). Like `SkyBoxDef` (Phase 1's exit), it
    shows how TypeDoc's model renders Zod-derived types, and is worth a look in the same check.
  - `AppConfig.lod.impostorExportDir` (`core/Config.ts`), a new documented config property.
  - The export's implementation, `core/Debug/Lod/_dbg__ImpostorExport.ts`, is a `_dbg__` file:
    §2.1's exclude leaves it out.

## 2. Design

### 2.1 Extraction

`devTools/hub/api/extract.ts` runs TypeDoc through its API:
`Application.bootstrapWithPlugins({ … })` with the `typedocOptions` entry points minus `_dbg__*` and
`generatedApp*` (`exclude`), then `app.convert()` and `app.serializer.projectToObject(project)`, written
to `.cache/hub/typedoc.json` with a hash of the inputs (the source files' paths and mtimes, the
TypeDoc version). An unchanged hash reuses the file.

The `typedocOptions` in `tsconfig.json` get the same excludes, so `yarn docs` documents the same set.

### 2.2 Pages

`devTools/hub/api/render.ts` turns the JSON model into Hub pages under `/hub/documentation/`:

- **Two subtrees:** `engine/` (`src/_engine`) and `toolkit/` (`src/toolkit`).
- **One page per module (file):** `documentation/engine/core/SceneLoader/`. Sections by kind,
  in this order: functions, classes, interfaces, type aliases, enums, variables. Every symbol gets
  an anchor (`#loadScene`) and a heading with its kind badge.
- **A symbol:** its signature(s), highlighted with p552's shiki. Its summary and body comment
  through markdown-it (with the Hub's plugins). Tables for `@param` and the return value. `@example`
  blocks as Hub code blocks. A `@deprecated` badge and note. `@see` links. A "Source" link to
  the line on GitHub (`<repository>/blob/<commit>/<path>#L<line>` in `public` mode; in `dev` it opens
  the file in the editor through Vite's `/__open-in-editor?file=`).
- **Interfaces and types:** their properties in a table (name, type, optional, comment), with the
  types linked when they're documented symbols.
- **Classes:** constructor, properties and methods, without private members.
- **Undocumented exports** are listed too, marked "No description", so the gaps are visible. The
  landing page shows the coverage per subsystem.
- **The landing page** (`/hub/documentation/`) groups the modules by folder (`core/Physics/`,
  `core/SkyBox/`, `debug/`, …) with a one-line summary per module (its `@module` comment or its
  first exported symbol's summary), and an A-Z symbol index.

The nav gets only the two subtrees and their folders. The module pages are reached through the
landing page, search and links, so the dropdown stays usable.

### 2.3 Links

- **`{@link X}`** in comments resolves to the symbol's page and anchor (TypeDoc's model already
  resolves the target). `{@link X | text}` keeps its text. An unresolved link renders as code with
  a warning.
- **`api:` links** for every Hub page: `[loadScene](api:loadScene)` or `api:SceneLoader.loadScene`
  for a name that isn't unique. An ambiguous or unknown name fails the build with the candidates.
- **Types in signatures** link to their symbols.

### 2.4 Search entries

One search document per symbol (p552 §2.4): name, kind, module path and the summary's first sentence,
not the full comment. Keeps `hub-search.js` reasonable for about 2,000 symbols.

### 2.5 Dev staleness

The dev plugin (p551) doesn't rebuild the API docs on engine changes (p550 §3.6):

- A change under `src/_engine/` or `src/toolkit/` only marks the docs stale (a flag, no work).
- The next request for a `/hub/documentation/` page while they're stale starts the rebuild and
  serves a "Rebuilding the API documentation…" page that reloads itself when the rebuild's `aek:hub`
  event arrives.
- Other Hub pages never wait for it. Their `api:` links are resolved against the last good model.

`hub:build --no-api` skips the extraction, renders the Documentation landing page as "not built"
and accepts `api:` links unchecked (with one warning), for fast content work.

### 2.6 `yarn docs`

Stays as is for now: TypeDoc's own HTML is the fallback while the Hub's renderer is new. Dropping it
is an open question (§5).

## 3. Phases

### Phase 1 — Extraction and pages

§2.1, §2.2.

**Exit:** `yarn hub:build` builds the Documentation section. `loadScene`, `createMeshEntity`,
`createPhysicsEntity`, `ECSWorld`, `SkyBoxDef` and a toolkit function each render with their
signature, comment, parameters and source link. No `_dbg__` module appears. The extraction is reused
when nothing changed (the second build is faster, logged).

### Phase 2 — Links and search

§2.3, §2.4.

**Exit:**

- A `{@link}` in a comment, a type in a signature and an `api:` link on a content page all land on
  the symbol's anchor.
- An unknown `api:` link fails the build and lists candidates.
- Searching for `createPhysicsEntity` finds the symbol first.

### Phase 3 — Dev staleness

§2.5.

**Exit:** during `yarn dev`, an engine edit rebuilds nothing. The next documentation page request
shows the rebuilding page, then the updated comment. A non-documentation Hub page loads at once
meanwhile.

### Phase 4 — Docs and versioning

CLAUDE.md:

- Commands: `yarn docs` versus the Hub, and `--no-api`.
- The Hub section: the Documentation section, the excludes and the `api:` links.
- A line in the TypeDoc paragraph: a TypeDoc upgrade re-checks the Documentation pages.

`readme.md`'s Documentation section points to the Hub. `CHANGELOG.md` Project entry. Mark the plan
done.

## 4. Versioning

Project only. The `tsconfig.json` excludes change what `yarn docs` documents (tooling), not the
engine.

## 5. Open questions

1. **Drop `yarn docs` / `docs-api/`** once the Hub's Documentation covers everything it shows.
2. **Doc coverage as a check:** the landing page's coverage per subsystem could become a warning
   threshold in `hub:build` (or a separate script) so new public API without JSDoc gets noticed.
3. **`@module` comments:** few engine files have one, so module summaries fall back to the first
   symbol's. Adding them is content work for p555 or later.
4. **Grouping by subsystem instead of folder:** the folders mostly match CLAUDE.md's subsystems.
   A `@category` tag could group cross-folder APIs (input, UI).
