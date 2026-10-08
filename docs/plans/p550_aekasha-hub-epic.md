Status: draft | epic — not-implemented
Category: Instructions, Examples, Dev tooling
Blocks: \_DONE_p551_hub-site-generator-and-dev-server.md, p552_hub-code-blocks-and-search.md, p553_hub-api-documentation.md, p554_hub-examples-start-scene-and-example-scenes.md, p555_hub-features-and-homepage-content.md
Related: \_DONE_p342_dev-file-server.md (the dev-only Vite plugin pattern; the example scenes' Hub images are written through it), \_DONE_p300_asset-optimization-pipeline-plan.md (what `yarn assets` makes of the Æ symbol's Draco GLB), `docs/templates/todo-plan-prompts.txt` (the original prompt, "Instruction/example pages and example scenes")

# Ækasha Hub — Epic

The Ækasha Hub is the engine's instructions, examples and documentation as a set of static pages:
served at `/hub/...` by the dev server next to the app, and built into `dist-hub/` for publishing
on its own (Netlify or any static host), without the engine.

It has six sections: **Home**, **Examples** (each backed by a real example scene, "Example: …"),
**Features**, **Documentation** (the engine's and toolkit's API from their JSDoc, in the Hub's own
style), **Issues** (`docs/issues/`) and **Version** (versions plus `CHANGELOG.md`).

This file holds the decisions every child plan shares. The work is split into the plans in §6.

---

## 1. Goal

- **For developers using Ækasha:** one place to start (dev environment, first scene), to see each
  feature working (example scenes opened straight from the page in debug or prod test mode), and to
  look up the API.
- **For the public:** the same pages without the engine, as a static site (the scene links are left
  out of that build).
- **For the repo:** Hub content stays current with the code. A CLAUDE.md rule (§5) makes updating
  it part of every change and every plan.
- **The feel:** the brand's (CLAUDE.md, "Aekasha brand, feeling, and core principles"): dark, quiet,
  precise, with one cyan accent. The style direction is the homepage design the prompt came with
  (§3.7).

## 2. Grounding (checked against the code, 2026-10-08)

- **One HTML entry point:** `src/index.html`, Vite `root: './src'`, output `dist/`, no
  `rollupOptions.input` (`vite.config.ts`). Nothing serves other pages today.
- **Dev-server plugins are the existing pattern:** `sceneGathererPlugin` (watches files, debounces,
  runs one job at a time, sends custom HMR events) and `devFilesPlugin` (routes under a URL prefix
  through `server.middlewares.use`), both `apply: 'serve'`.
- **Cross-origin isolation:** `crossOriginIsolationPlugin` sends COOP `same-origin` / COEP
  `require-corp` on every dev response, so a Hub page under `/hub` can't load fonts, scripts or
  images from another origin.
- **Versions and build info** are already assembled in `vite.config.ts` (`meta`: the engine,
  toolkit and app versions and codenames, packages, build commit and time) for `__PROJECT_METADATA__`
  and the `html-transform` plugin.
- **API docs today:** `yarn docs` runs TypeDoc 0.28.20 with `typedocOptions` in `tsconfig.json`
  (`src/_engine/**`, `src/toolkit/**`, `out: docs-api`), TypeDoc's default theme. No JSON output.
- **The start scene** is hard-coded in `src/index.ts` (`loadScene({ sceneId: 'sceneTestECS' })`).
  Debug and prod test only override it from the Debug tools tab's saved "debug start scene"
  (`loadScene`, `core/SceneLoader.ts`). No URL parameter does.
- **Brand assets:** the Æ glyph is one SVG path in `src/public/favicon.svg` (and
  `core/UI/icons/svg/aekasha.svg`). `favicon.ico`, `favicon.svg` and `apple-touch-icon.png` are in
  `src/public/`.
- **Landed on `main` the same day, after these plans were written:** impostor LOD Phases 4-5
  (`_DONE_p351`: exported impostors and the `*.impostor.json` asset type, the `lodShowcase` scene
  and its "LOD demo" tab) and alpha coverage mips (`_DONE_p341`), engine 4.13.0 and app 1.8.0,
  merged into `aekasha-hub`. What each child plan needs from them is in its own grounding: p553
  (the new impostor modules and schema), p554 (lodShowcase against `exampleLod`, the export as
  the "Save Hub image" precedent) and p555 (the `lod`, `asset-optimization`, `scenes-and-assets`
  and `debug-suite` pages). p552 needs nothing from them.
- **Libraries already there:** `sass` 1.104 and `sharp` (devDeps), `draco3dgltf` and
  `@gltf-transform/*` (devDeps). `markdown-it` and a shiki build come in only through TypeDoc,
  so they aren't ours to import.

## 3. Shared design

### 3.1 No router in the engine

The prompt asked for a minimal router in the core code. The pages are static HTML, so a runtime
router would have nothing to route, and engine code is what ships to players. Instead:

- **Dev:** a dev-only Vite plugin (`devTools/hubPlugin.ts`, p551) serves `/hub/*` from the
  generator's output. It's never part of a build.
- **Build:** `yarn build` also builds `dist-hub/` (skip with `AEK_HUB=false`).
- **"Not in production unless the developer wants it":** `AEK_HUB_IN_DIST=true yarn build` copies
  `dist-hub/` into `dist/hub/`, so the app's own site serves it at `/hub/`. Off by default.

### 3.2 Source layout

`hub/` at the repo root, a sibling of `docs/` and `devTools/`. It's outside Vite's root, so the app's
dev server never serves its raw files and nothing can import it into the app bundle by accident.

```
hub/
  hub.config.ts          # site title, top-level sections and their icons, GitHub URL, featured lists
  tsconfig.json          # DOM lib, the Hub's own TS
  _layout/
    shell.html           # <head>, top nav, search, footer, slots for the page
  _assets/
    scss/                # hub.scss + partials (_tokens, _nav, _hero, _cards, _prose, _code, _search)
    ts/                  # hub.ts (nav, theme, copy buttons), search.ts (lazy)
    icons/               # UI icons, *.svg
    fonts/               # self-hosted woff2
    images/              # hero and other images
  pages/                 # one folder per URL
    index.html, intro.md, …              → /hub/
    examples/index.html, quick-start.md  → /hub/examples/
    examples/physics/…                   → /hub/examples/physics/
    features/…, documentation/…, issues/…, version/…
devTools/
  hub/                   # the generator modules
  hubBuild.ts            # CLI: yarn hub:build
  hubPlugin.ts           # the dev plugin
```

### 3.3 Page format

A page is a folder under `hub/pages/`:

- **`index.html`** is the page's layout and metadata. Its `<head>` holds `<title>` and `<meta>`
  tags: `aek:menu` (menu label, default the title), `aek:order` (menu order), `aek:tags`
  (comma-separated, for search), `aek:description` (cards, search, `<meta name="description">`),
  `aek:icon` (top-level items and cards) and `aek:featured` (homepage cards). Its `<body>` is the
  page's own markup, injected into the shell.
- **Slots:** every empty element with an `id` in the body is a slot, filled by `<id>.md` from the
  same folder (`<div id="setup"></div>` ← `setup.md`). An `.md` without a slot fails the build. An
  empty slot without an `.md` is a warning.
- **Generated sections** (Documentation, Issues, Version) have an `index.html` too, and their
  generators provide the slots' content and the child pages.

### 3.4 URLs and links

- Directory URLs: `/hub/examples/physics/` serves `examples/physics/index.html`.
- Every internal link the generator writes is relative to the page (`../../features/`). It knows
  each page's depth, so `dist-hub/` works at a domain root (`/`) and under `/hub/` (dev, or
  `AEK_HUB_IN_DIST`).
- Markdown links between pages use `hub:` (`[physics](hub:examples/physics)`), resolved and checked
  at build time: a dead link fails the build. p553 adds `api:` links (`api:loadScene`).

### 3.5 Output

The same layout in `.cache/hub/dev/` (dev) and `dist-hub/` (build):

- The pages (`index.html` per folder) and a `404.html`.
- `_assets/hub.css`, `hub.js`, `search.js`, `hub-data.js`, `hub-search.js`, `icons/*.svg`,
  `fonts/`, `images/`.
- The favicons, copied from `src/public/`.
- A Netlify `_headers` file (§3.6).

**The data files** (`?v=<content hash>` on every reference, so a browser loads each version once):

- `hub-data.js`, loaded on every page, small: `window.AEK_HUB = { versions, build, nav, pages }`,
  where `pages` is each page's path, title, tags, description, section and headings.
- `hub-search.js`, loaded lazily on the first search: the full text per heading section, and the
  API symbols (p553). Kept apart because the API docs would make a per-page file several hundred KB.

**The menu is rendered at build time**, with the active item set per page, not built from
`hub-data.js` in the browser. It shows no flash and works without JS. The data file still carries
the tree for search breadcrumbs and cards.

### 3.6 Build modes and caching

- **`dev`** (the dev plugin): a dev client script (reloads on Hub rebuilds, p551), the example
  scenes' "Open in debug / prod test" links (p554), unminified assets.
- **`public`** (`yarn hub:build` → `dist-hub/`): no dev client, no scene links, minified assets.
- **Caching:** the requested fixed names (`_assets/hub.css`) stay, with `?v=<hash>` in references,
  and `_headers` gives `_assets/*` a long `Cache-Control`. **Risk:** a CDN that drops the query
  string from its cache key would serve stale assets after a deploy. The fallback is hashed file
  names (`hub.3f2a91.css`), which the generator already has the hash for (p551's open question).

### 3.7 Design

From the homepage design that came with the prompt, kept as a direction, not copied:

- **Colours:** near-black blue background, slightly lighter panels, thin cool-grey borders, light
  text, muted secondary text, and one cyan accent (links, the active nav underline, eyebrow bars,
  button outlines on hover). The title's "Hub" gets a cyan gradient.
- **Type:** a geometric sans (Inter, self-hosted, OFL) with a bold display size for titles, and
  uppercase, letter-spaced eyebrows ("FEATURED FEATURES") with a short cyan bar.
- **Top nav:** the Æ mark and "ÆKASHA" wordmark, then icon + label items (Hub, Examples,
  Features, Documentation, Issues, Version) with dropdown chevrons and a cyan underline on the
  active one. On the right: a search box with a ⌘K hint, a version pill and a theme toggle. A
  menu button below about 900 px.
- **Homepage:** a hero with the background image on the right and the welcome, title, text and
  outlined section buttons on the left. Below: featured features (icon columns), featured examples
  (image cards), and a side column with "What's new", quick links and a brand card.
- **Icons:** line icons in the Lucide style (ISC licence, attributed in `hub/_assets/icons/`),
  one per top-level section, as in the design.
- **Theme:** dark by default, plus a light theme. Colour tokens on `:root`, redefined for light.
  The toggle's choice is kept in localStorage, else `prefers-color-scheme` decides.
- **Logo:** the design's top-left mark is a ringed planet, but the brand glyph is the Æ, so the
  Hub uses the Æ (§7).
- **Hero image:** rendered by the engine. The example scene `exampleHubHero` (p554) renders it, and
  until then a crop of the design image is the placeholder (p551).
- **Self-hosted only:** fonts, icons and images all ship in `_assets/`, because of the dev server's
  COEP (§2) and so the public site needs no third party.

## 4. Libraries

Added as devDependencies (agreed when this epic was written):

- **markdown-it** (p551): Markdown, with the Hub's plugins written in-house (§3.3, §3.4, the
  directives in p551-p555).
- **shiki** and **@shikijs/transformers** (p552): syntax highlighting at build time, so a page
  carries no highlighter JS, plus line highlights, diffs and focus.
- **minisearch** (p552): the search index, bundled into `search.js`.
- **linkedom** (p554): a `DOMParser` for three's `SVGLoader` in Node, for the Æ symbol model.

TypeDoc (p553) and sass, sharp, gltf-transform and draco3dgltf are already devDependencies.

## 5. The CLAUDE.md rule

Written into CLAUDE.md by p551's docs phase, with the Hub's own section:

> **Keep the Ækasha Hub current.** A change that adds, changes or removes an engine or toolkit
> feature or public API updates its Hub content in the same branch: the feature page, the example
> page and its scene, and the snippets they include.
>
> **Plans:** when it helps, a plan's second-to-last phase (before the last one's versioning,
> changelog and marking the plan done) updates the Hub content and builds the relevant examples.
> Whoever writes the plan asks whether an example scene should be built for it.

It goes under "Plans logic and structure" (the plan rule) and "Workflow" (the content rule), next to
the existing `readme.md` rule.

## 6. Roadmap

| Plan | What | Blocked by |
| --- | --- | --- |
| \_DONE_p551_hub-site-generator-and-dev-server.md (implemented) | The generator, the dev plugin, `dist-hub/`, the design shell, the Issues and Version pages, the CLAUDE.md rule | — |
| p552_hub-code-blocks-and-search.md | Code blocks (highlighting, line numbers and highlights, copy, groups, snippet includes) and search | — |
| p553_hub-api-documentation.md | Documentation: the API from TypeDoc's JSON, in the Hub's style | p552 (its search entries) |
| p554_hub-examples-start-scene-and-example-scenes.md | `?startScene=`, the example scenes, the Æ symbol model, the example pages, the hero image | p552 (snippets) |
| p555_hub-features-and-homepage-content.md | The feature pages and the homepage's final content | p553, p554 |

Order: p551, then p552, then p553 and p554 in either order, then p555. p554's Phase 1
(`?startScene`) is engine-only and can land at any time.

Versioning: the Hub itself is repo tooling (`hub/`, `devTools/`): `CHANGELOG.md` Project entries,
no part bumped. p554 bumps the engine (`?startScene`), toolkit (the Æ model) and app (the
example scenes).

## 7. Risks and open questions

1. **TypeDoc's JSON model is version-specific** (p553). The renderer is written against 0.28's
   reflection kinds, so a TypeDoc upgrade checks the Documentation section like a three upgrade
   checks the sky. TypeDoc stays pinned.
2. **CDN caching of `?v=` URLs** (§3.6). Check it on the first real deploy.
3. **Build time:** `yarn build` gets the Hub build (shiki, the TypeDoc conversion), likely tens of
   seconds. `AEK_HUB=false` skips it, and `hub:build --no-api` skips the API docs.
4. **The content is real work** (p555 above all). A feature page is only useful if it's checked
   against the code like CLAUDE.md is, not paraphrased from the readme.
5. **A ringed-planet mark?** The design's logo is a ringed planet, the brand's is the Æ. A combined
   mark (the Æ inside a ring, like the design's right-hand "Ækasha" emblem) would be a brand
   decision, not a Hub one.
6. **Hosting:** Netlify is the assumption (`_headers`, `404.html`). Another host may need its own
   headers file.
