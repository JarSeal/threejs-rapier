Status: in progress | Phases 1-2 implemented
Category: Dev tooling, Hub, Documentation
Epic: p550_aekasha-hub-epic.md
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

### Phase 1 — Extraction and pages — done

§2.1, §2.2.

**Exit:** `yarn hub:build` builds the Documentation section. `loadScene`, `createMeshEntity`,
`createPhysicsEntity`, `ECSWorld`, `SkyBoxDef` and a toolkit function each render with their
signature, comment, parameters and source link. No `_dbg__` module appears. The extraction is reused
when nothing changed (the second build is faster, logged).

As built:

- **Files:** `devTools/hub/api/` has `extract.ts` (the model and its cache), `model.ts` (modules,
  folders, anchors, coverage), `signature.ts` (the type printer and its shiki highlighting),
  `comments.ts` (comment parts to Markdown) and `render.ts` (the pages and `createApiSection`).
  `build.ts` adds the section after Issues and Version; `HubBuildResult.api` has its stats, which
  `hub:build` prints (`API: 221 modules, 2017 symbols, 63% documented; model reused (0.1 s)`).
- **TypeDoc options:** `typedocOptions.entryPoints` are `src/_engine/**/*.ts` and
  `src/toolkit/**/*.ts`: the bare `**` also matched the SVGs, SCSS and JSON, a warning each. The
  extraction reads `typedocOptions` (so `yarn docs` and the Hub share the excludes) and adds
  `skipErrorChecking` (`tsc` checks types, and any type error in the program stopped the
  conversion; 8.6 s → about 5 s) and `disableGit` with a `sourceLinkTemplate` (TypeDoc errors
  without one). The Hub writes its own source links, so the cached model doesn't change with
  the commit.
- **Cache:** `.cache/hub/typedoc.json` (about 9 MB) plus an in-memory copy. The hash covers the
  `.ts` files under `src/_engine/` and `src/toolkit/` minus the excludes, `src/*.ts` (the engine
  imports `AppECSRegistry.ts` and `CONFIG.ts`), `tsconfig.json`, `package.json`, `yarn.lock`, the
  TypeDoc version and `EXTRACT_VERSION`. TypeDoc is imported only on a miss.
- **TypeDoc's warnings** become Hub warnings, at the source line when TypeDoc names a node, else
  at the module its message names. Warnings about comments in `node_modules` (three's) are
  dropped. Today there are 12, all `@param` names that no longer match (`SceneLoader.ts`,
  `PhysicsAPITypes.ts`).
- **Kinds** are numbers in `model.ts` (`Kind`), checked against `ReflectionKind` with
  `satisfies`, so the Hub build never loads TypeDoc for its enum and an upgrade that renumbers a
  kind fails `tsc`.
- **A module next to a folder of the same name** (`core/ECS.ts` + `core/ECS/`,
  `core/Character.ts`, `core/PostFX.ts`) has the folder's URL: its page lists the folder's modules
  first, then its own symbols.
- **Every folder gets a page** (the page tree needs each page's parent), titled by its name;
  `documentation/engine/` and `documentation/toolkit/` are "Engine API" / "Toolkit API". Folder
  pages are `isInMenu` (so `hub-data.js`'s nav has them); module pages aren't. The nav itself
  still renders one dropdown level: Documentation shows Engine, Toolkit and Code blocks.
- **Search:** `HubPage.isSearchable` (`HubGeneratedPage.isSearchable`, default true). The API
  pages are false until Phase 2's symbol entries, so they're in neither the index nor
  `hub-data.js`'s `pages` (which would grow by about 140 kB with their headings). The landing
  page's lists are in a `hubSearchSkip` element, which `search.ts` skips.
- **Memo:** rendering the whole API takes about a second (shiki and Markdown per symbol), so each
  slot's output (with the headings, ids, links and diagnostics it added) is kept in memory per
  model hash, mode, commit and the page's prior ids. A dev rebuild with an unchanged model adds
  about 25 ms (dev rebuilds were 360-410 ms before this phase, with the SCSS and TS builds).
- **Pages:** symbols in kind sections (functions, classes, interfaces, type aliases, enums,
  variables, then namespaces and re-exports), alphabetical; each symbol an h3 with its anchor, so
  the TOC lists them. Class and interface members get `#Owner.member` anchors and h4 blocks
  (methods, constructors as `constructor(…)`); properties go in a table, with object literal
  types as nested rows (`physics.workerTarget`, `items[].id`, 3 levels). "Optional", `readonly`,
  `static`, `get` / `set`, `deprecated` and `internal` (36 symbols carry `@internal`) are badges,
  not columns. Inherited members are left out (`FatLineSegments` would list three's `Mesh`).
  `@default` / `@defaultValue` and parameter defaults show as "Default".
- **Type aliases:** 242 of them are object literals, which TypeDoc models as members on the alias
  with no `type`: they print `type X = { … }` with the members in the table. A long union or
  conditional type gets a line per member or branch.
- **Highlighting:** a type alone in a table cell is highlighted as `type T = …` and a member
  signature inside `class C { …`, with the prefix's tokens dropped: alone, the grammar reads them
  as expressions and colours nothing.
- **Comments** render with markdown-it's `html` off (`Array<Mesh>` in a comment is text), and
  their own headings start at h4. Diagnostics point near the symbol's line.
- **Module summaries:** no file has an `@module` comment, so the summary is the first documented
  function or class's first sentence (by source line), else any export's. Plain "first export"
  picked helpers and option types.
- **Re-exports** (83, the toolkit's deprecated `InstancedMeshPool` ones among them) link to the
  original symbol and its module.
- **Source links:** `public` links GitHub at `meta.build.commit` (short hash); `dev` links
  `/__open-in-editor?file=<absolute path>:<line>`, which `hub.ts` fetches instead of following
  (Vite answers with an empty page).
- **Size:** the landing page is 443 kB (53 kB gzipped), about 300 kB of it the A-Z index's 2,017
  entries. `dist-hub/` has 264 pages (221 modules plus folders).
- **The section's `files`** are `tsconfig.json`: a `typedocOptions` change rebuilds the Hub in
  dev, and a conversion error lands on the Documentation page.
- **Zod-derived types** render as their type expression (`SkyBoxDef` is
  `Omit<z.input<typeof SkyBoxDefSchema>, 'base' | 'preset'> & { … }`, with `base` and `sceneId`
  in the table): the schema's own fields aren't expanded. `ImpostorDef` prints as its conditional
  type, a branch per line.

### Phase 2 — Links and search — done

§2.3, §2.4.

**Exit:**

- A `{@link}` in a comment, a type in a signature and an `api:` link on a content page all land on
  the symbol's anchor.
- An unknown `api:` link fails the build and lists candidates.
- Searching for `createPhysicsEntity` finds the symbol first.

As built:

- **Files:** `devTools/hub/api/links.ts` (`getApiLinks(index)`, built once per model): the owner
  of every reflection (one walk of the model), `resolveId`, the `api:` name table and
  `resolveName`, and the `{@link}`s without a reflection id. The index, its links and its search
  documents are kept per model (`WeakMap`s on the project), so a dev rebuild doesn't redo them.
- **Ids without an anchor:** of the 412 `{@link}`s, 303 have a reflection id, but not all of it is
  anchored (29 point at properties, 10 at parameters). `resolveId` walks up to the nearest owner
  with an anchor (a type alias's property → the alias). Type references to a type parameter carry
  its declaration's id: the printer leaves them unlinked (`refersToTypeParameter`), or `T` would
  link its function.
- **`{@link}` text:** `{@link X | text}` shows its own text as Markdown, a bare one the name as
  code (`@linkplain` as text). TypeDoc leaves the whole `X | text` in `text` when it didn't
  resolve the link, and for some TS-resolved ones (`tsLinkText` has the text then). A string
  target (`{@link https://…}`) links the URL.
- **Unresolved `{@link}`s:** another package's symbol (three's, 44) is text without a warning.
  One TypeDoc only found as a name in this package (`aekasha-js:LoadSceneProps`: not exported) is
  looked up like an `api:` link, else text. The rest warn once per build at their source line
  (`reportCommentLinks`, not during the render: a module's summary is on several pages): 11 today.
  Comments on members inherited from three (`node_modules/` sources) are skipped: the pages leave
  those members out.
- **`api:` names:** a bare name is a top-level export; a member needs its owner
  (`ECSWorld.addSystem`), so `addSystem` alone can't match every class's. Any module path suffix
  qualifies (`PhysicsAPI.createRigidBody`, `core/PhysicsAPI.…`, `toolkit/…`; the subtree is the
  first segment). Re-exports aren't names (they'd make their original ambiguous). A value and a
  type of one name in one module (`ComponentType`) resolve to the bare anchor. Errors list each
  candidate by its shortest unique name; an unknown name suggests up to 5 by edit distance.
  `HubMarkdownEnv.apiLinks` carries the section's resolver (`null` when the model didn't build:
  the link points to `#` with a warning). `href="api:…"` works in a page's markup too.
- **Search documents:** a module, symbol or class / interface member each (2,679: 221 + 2,017 +
  441). They're found by name only: a `symbol` field (×4, split at camelCase like the rest). The
  first sentence is stored as `summary` for the snippet, not indexed, and nothing empty is stored.
  The name isn't stored either: it's the anchor without a `-2`, or a module page's folder
  (`apiSearchName` in `searchProtocol.ts`). The dialog shows the kind badge (the API pages'
  colours) and the name, with the module in the breadcrumb (from the path: the API pages aren't
  in `hub-data.js`'s `pages`).
- **Index size:** the first layout (every field, empty strings stored) took the index from 345 kB
  to 1.52 MB. The lean documents plus a single-quoted `JSON.parse('…')` (the JSON's own quotes
  aren't escaped any more, about 12% off every index) bring it to 991 kB (233 kB gzipped),
  just under p552's 1 MB warning. Building it takes about 30 ms more per dev rebuild. The next
  cuts, if needed: members (about 125 kB) or the stored summaries (about 170 kB).
- **Ranking:** `createPhysicsEntity`, `loadScene` and `ECSWorld.addSystem` come first for their
  names. A broad word (`mesh`, `sky box`) now lists API symbols before prose pages, which p555's
  feature pages will compete with (their titles and headings weigh the same as a symbol's name).
- **Content:** the Documentation intro links its entry points with `api:`. The authoring how-to
  (`docs/techniques/hub-authoring.md`) has `api:` links, the API search and the new messages.
- **Types in signatures and tables** link with `.hubApiTypeLink`: the token keeps its colour,
  with a faint dotted underline. 3,044 type links in the build; every anchored link in it lands on
  an id.

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
