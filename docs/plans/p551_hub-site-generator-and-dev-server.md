Status: in progress | Phases 1-2 implemented
Category: Dev tooling, Hub
Epic: p550_aekasha-hub-epic.md
Blocks: p552_hub-code-blocks-and-search.md, p553_hub-api-documentation.md, p554_hub-examples-start-scene-and-example-scenes.md, p555_hub-features-and-homepage-content.md
Related: \_DONE_p342_dev-file-server.md (the dev-only plugin pattern this copies)

# Hub Site Generator & Dev Server

The Ækasha Hub's foundation: the generator that turns `hub/` into static pages, the dev plugin
that serves them at `/hub/` and refreshes them on save, the `dist-hub/` build, the design shell
(nav, footer, theme, homepage skeleton), and the two generated sections that need nothing else:
Issues and Version. It ends with the CLAUDE.md rule that keeps the Hub current (p550 §5).

The shared decisions (source layout, page format, URLs, output, build modes, design) are in
p550 §3. This plan builds them.

---

## 1. Grounding

- **Vite's root is `src/`** (`vite.config.ts`), so `hub/` isn't watched by default. The gatherer adds
  a file outside the root the same way: `server.watcher.add(ASSETS_CONFIG_FILE)`
  (`devTools/sceneGathererPlugin.ts`).
- **The patterns to copy:**
  - `sceneGathererPlugin.ts`: `handleFileEvent` filters events by path, `schedule` debounces 100 ms
    (`DEBOUNCE_MS`), `flush` runs one job at a time and loops while work is pending, and results go
    out as a custom HMR event (`server.hot.send({ type: 'custom', event, data })`).
  - `devFilesPlugin.ts`: one `server.middlewares.use` that handles its URL prefix and calls `next()`
    for everything else.
- **The gatherer reloads every page on a gather** (`server.hot.send({ type: 'full-reload' })`).
  The Hub's own reloads must not do that: an open app tab would reload on every `.md` save.
- **COOP/COEP on every dev response** (`crossOriginIsolationPlugin`): the Hub's pages only load
  same-origin resources.
- **Versions and build info** are built in `vite.config.ts` (`meta`, `readGit`). The generator needs
  the same, so they move into a shared module.
- **`sass` 1.104** (pure JS) and **`sharp`** are devDeps. Vite (6.4.3) can bundle the Hub's TS
  through its JS API (`build()`).
- **Type-checking:** the root `tsconfig.json` includes `src/**`, `devTools/**/*.ts` and
  `vite.config.ts`, not `hub/`. The Stop hook (`.claude/hooks/verify.sh`) runs lint and `tsc` only
  when `git status` shows a change in `src/`. ESLint's flat config covers every `**/*.ts`.
- **`docs/issues/*.md`** have no consistent format. Every file starts with a `**Title:** …` line,
  two have a `Status: …` line, and their sections differ (one is a GitHub issue template).
- **`CHANGELOG.md`**: `## YYYY-MM-DD — branch` entries, newest first, with `### Engine x.y.z
  (Codename)` / `### Toolkit …` / `### App …` / `### Project` sections and bold
  `**Added**` / `**Changed**` / `**Fixed**` labels.
- **Gitignored:** `dist`, `dist-stats`, `docs-api/`, `.cache/`. `dist-hub` isn't yet.

## 2. Design

### 2.1 Project metadata

`devTools/projectMetadata.ts` exports `getProjectMetadata()`, the `meta` object `vite.config.ts`
builds today (versions, codenames, packages, build tools, commit, time, checksum). `vite.config.ts`
imports it instead of building its own, unchanged in output. The generator puts its `versions` and
`build` parts into `hub-data.js` and the Version page.

### 2.2 The generator (`devTools/hub/`)

One function, `buildHub({ mode: 'dev' | 'public', outDir, only? })`, run by the CLI and the dev
plugin. Modules:

- `pages.ts`: discovers `hub/pages/**/index.html`, parses the head metadata (p550 §3.3) and
  builds the page tree (`path`, `parent`, `children` by `aek:order` then title).
- `markdown.ts`: a markdown-it instance with the Hub's plugins:
  - heading anchors (slugged ids, a `#` link on hover) and the page's heading list, which feeds
    the per-page "On this page" table of contents (shown from 3 headings) and `hub-data.js`;
  - callouts `::: tip|note|warning|danger [title]`;
  - `hub:` links resolved to relative URLs and checked (a dead link fails the build, with the file
    and line);
  - relative images copied to `_assets/images/pages/…` (sharp to webp when they're PNG or JPEG);
  - a directive registry (`::: name args`), so later plans add `code-group` (p552), `scene` (p554)
    and `cards` (p555) without touching the core.
- `shell.ts`: puts the page into `hub/_layout/shell.html`. The shell's `{{…}}` placeholders are the
  page title, description, the nav (rendered here, with the active item and its ancestors marked),
  breadcrumbs, the TOC, the body, the asset URLs with their `?v=` and `{{root}}` (the relative path
  to the site root). Plain string templates, no templating library.
- `assets.ts`: SCSS through `sass.compile` (compressed in `public`), the TS entries `hub.ts` and
  `search.ts` through Vite's `build()` (`configFile: false`, ES module output, fixed file names,
  minified in `public`), icons and fonts copied, and content hashes for `?v=`.
- `data.ts`: `hub-data.js` (p550 §3.5). p552 adds `hub-search.js`.
- `generated/issues.ts`, `generated/version.ts`: §2.5.
- `hubBuild.ts` (CLI): `yarn hub:build [--out <dir>] [--no-api]` (`--no-api` is p553's). Builds
  `public` into `dist-hub/` (emptied first), copies the favicons from `src/public/`, writes
  `_headers` and `404.html`, and exits 1 on an error.

Errors and warnings are collected per run with file and line. In `public` mode any error fails the
build. In `dev` mode the page that failed renders an error page (§2.3).

### 2.3 The dev plugin (`devTools/hubPlugin.ts`)

`{ name: 'vite-plugin-aek-hub', apply: 'serve', configureServer }`, registered in
`vite.config.ts` after `devFilesPlugin`. `AEK_HUB=false` turns it off.

- **Routes:** `/hub` redirects to `/hub/`. `/hub/**` serves files from `.cache/hub/dev/`, a
  directory URL serves its `index.html`, and anything missing gets the Hub's `404.html` with a 404.
  Everything else goes to `next()`.
- **Lazy:** the first build runs on the first `/hub` request (the request waits for it), so a
  developer who never opens the Hub pays nothing at start-up.
- **Watching:** after the first build, `server.watcher.add` for `hub/**`, `docs/issues/*.md`,
  `CHANGELOG.md`, `package.json`, plus whatever files the last build recorded as dependencies (p552's
  snippets, p554's images). Engine, toolkit and app changes don't trigger it (p553's API docs are
  the one exception, and they're only marked stale).
- **Incremental:** an `.md` or a page's `index.html` rebuilds that page and `hub-data.js`. A new or
  deleted page, `hub.config.ts` or the shell rebuilds all pages. SCSS rebuilds only the CSS, TS
  only the JS. Debounced 100 ms, one run at a time, like the gatherer.
- **Reload:** in `dev` mode the shell includes a small dev client:
  `import { createHotContext } from '/@vite/client'`, a hot context of its own, listening to the
  custom event `aek:hub` (`{ kind: 'css' | 'pages' | 'all', paths }`). A CSS change swaps the
  stylesheet's `href` (new `?v=`) without a reload. A page change reloads only when the open page is
  in `paths` or the kind is `all`. The plugin never sends `full-reload`, so open app tabs aren't
  touched.
- **Errors:** a page that failed to build serves an error page (the message, the file and line,
  styled with the shell), and the event reloads it once it's fixed. The terminal gets the same
  message.

### 2.4 Build integration

- `package.json`:
  - `hub:build`: `tsx ./devTools/hubBuild.ts`.
  - `hub:preview`: serves `dist-hub/` (`vite preview --outDir ../dist-hub --port 8090`, or a small
    static server if preview's root handling gets in the way).
  - `build` and `build:test` add `tsc -p hub` after `tsc` and `yarn hub:build` at the end, both
    skipped when `AEK_HUB=false`.
- `AEK_HUB_IN_DIST=true` (read by `hubBuild.ts` during `yarn build`) copies `dist-hub/` into
  `dist/hub/` after the app's build. Off by default, so the Hub is never in production unless the
  developer asks for it (p550 §3.1).
- `.gitignore`: `dist-hub`.
- `hub/tsconfig.json`: DOM lib, `strict`, `noEmit`, its own `include` (`hub/**/*.ts`).
- The Stop hook (`verify.sh`) also runs when `hub/` changed, and runs `tsc -p hub` there.
- ESLint: no change, since `**/*.ts` already matches. `hub/` gets the same Prettier rules.

### 2.5 Generated sections

- **Issues** (`generated/issues.ts`): reads `docs/issues/*.md`. Title from the `**Title:**` line,
  else the first heading, else the file name. Status from a `Status:` line (`open` when there is
  none, shown as "not stated"). The landing page lists them grouped by status with the first
  paragraph as a summary. Each issue gets a page at `/hub/issues/<file-name>/` with the file rendered
  as is (its `**Title:**` and `Status:` lines become the page title and a status badge). The
  convention for new issue files goes into CLAUDE.md (§4 Phase 5): `**Title:**` on line 1,
  `Status:` on line 3.
- **Version** (`generated/version.ts`): a table of the engine, toolkit, app and project versions
  with codenames, the build commit (with a "local changes" mark) and time, then `CHANGELOG.md`
  rendered with an anchor per entry (`#2026-10-07-dev-server-implementation`). The latest entry's
  date, branch and parts go into `hub-data.js` as `latestChange`, for the homepage's "What's new".

### 2.6 Shell and homepage skeleton

- `shell.html`: the top nav, breadcrumbs (not on the homepage), the main column with the TOC on the
  right from 1200 px, and the footer ("Ækasha Hub / <engine version>" left, "Powered by Three.js +
  Rapier" right).
- The top nav (p550 §3.7). Dropdowns list a section's children from the page tree, open on hover
  and on click/Enter, close on Escape. The search box is a button that p552 wires up (until then it
  opens nothing). The version pill links to `/hub/version/`.
- The theme toggle and the mobile menu in `hub.ts`, with no framework.
- The homepage skeleton: the hero (title, intro, section buttons), and empty slots for p555's
  content. The hero image is a crop of the design image (`hub/_assets/images/hero-placeholder.webp`,
  made once with sharp and committed) until p554's render replaces it.
- Placeholder pages for Examples, Features and Documentation (an intro slot each), so the nav is
  complete from the start.

## 3. Phases

### Phase 1 — Generator core and `dist-hub` — done

§2.1, §2.2 (without the shell's final markup) and §2.4 without the dev plugin: the metadata module,
pages, Markdown with its plugins, assets, `hub-data.js`, `yarn hub:build`, favicons, `_headers`,
`404.html`, `.gitignore`, `hub/tsconfig.json`, the Stop hook.

**Exit:** a sample site (home plus two nested pages, one with two slots) builds into `dist-hub/`.
Served from a static server at `/` and copied under `/hub/`, every link works in both. A dead `hub:`
link and an `.md` without a slot each fail the build with the file and line. `yarn build` still
passes and produces `dist-hub/`. `AEK_HUB=false yarn build` doesn't.

As built:

- `hub.config.ts` has `title`, `description` and `githubUrl` only. The menu (label, order, icon)
  comes from each page's `aek:` meta alone, so there's one source for it. p555 adds the featured
  lists.
- The generator imports `hub.config.ts` statically (`devTools/hub/build.ts`): Node 22.13 can't
  import a `.ts` at runtime inside Vite's process. So in Phase 2 a change to it restarts the dev
  server (Vite watches its config's dependencies), and the next `/hub` request rebuilds.
- The 404 page resolves its links against a static `<base href="/">` (`buildHub`'s `basePath`).
  `rebaseNotFoundPage` rewrites it for `dist/hub/` (`/hub/`) and `hub:preview --base`; Phase 2's
  plugin passes `/hub/`. A script-set `<base>` was tried first: Chrome's preload scanner fetched
  the assets against the 404's own URL before it ran.
- `hub:preview` is `devTools/hubPreview.ts` (`--base /hub/`, `--port`, `--dir`), not
  `vite preview`, whose SPA fallback serves the homepage for a missing path.
- ESLint ignores `dist-hub/` (it would lint the built JS). The Stop hook runs on changes in
  `src/`, `hub/`, `devTools/` and `vite.config.ts`, and runs `tsc -p hub` after the root `tsc`.
- `tsc -p hub` runs in `build` / `build:test` even with `AEK_HUB=false`, so `hub/` keeps
  compiling; only `hub:build` is skipped.
- TS entries are every `hub/_assets/ts/*.ts` not starting with `_` (`hub.ts` so far; p552 adds
  `search.ts`). Shared chunks get hashed names (`_assets/chunks/<name>-<hash>.js`).
- Heading slugs never take an id the page's markup has: a `quick-start` slot with a
  "Quick start" heading gives the heading `quick-start-2`, and `hub:examples#quick-start` reaches
  the slot.
- `hub:` links also work in a page's `index.html` body (`href="hub:…"`, `src="hub:…"`), as does
  `{{root}}`.
- Only Markdown images are processed (not raw `<img>`), and they must be inside the page's folder.
  They get `?v=<hash>` like the other assets.
- The Phase 1 shell and SCSS are minimal (no icons, fonts or light theme); Phase 3 replaces them.
- `markdown-it` 14.3.1 (the version TypeDoc already brought in) and `@types/markdown-it` 14.1.2.

### Phase 2 — Dev plugin — done

§2.3.

**Exit:** with `yarn dev`:

- `/hub` redirects, and `/hub/` builds on its first request.
- Saving an `.md` refreshes that page in its tab within about a second. Saving the SCSS restyles
  it without a reload.
- With an app tab open next to it, a Hub save doesn't reload the app tab. An app or engine `.ts`
  save doesn't rebuild the Hub (nothing in the terminal, no event).
- A broken `.md` shows the error page, and fixing it brings the page back.

As built:

- **The dev client doesn't import `/@vite/client`.** Vite 6.4's client reloads on every
  `full-reload` without an `.html` path, which the scene gatherer sends on every gather, and it
  shows the app's error overlay. So a Hub tab would reload on every scene save. The client
  (`hub/_assets/ts/_devClient.ts`, built to `_assets/hub-dev.js` in `dev` builds only) opens its
  own socket to Vite's HMR WebSocket (`vite-hmr` protocol) and reads only `aek:hub`. After a
  server restart it waits like Vite's client does (a `vite-ping` socket), then reloads.
- **The HMR token.** The socket needs Vite's per-start `webSocketToken`. Dev pages carry
  `<meta name="aek-hub-dev" content="%AEK_HUB_DEV_SOCKET%">`, and the plugin fills in the path and
  token when it serves the page, so the token is never on disk. `/hub` routes run devFiles'
  `checkHostAndOrigin`: they're served before Vite's own host check, and a DNS-rebinding page could
  otherwise read the token.
- **`hub/` is watched with `fs.watch(hub/, { recursive: true })`, not `server.watcher`.** For a
  watched `.html` that's in no module graph, Vite logs "page reload" with `clear: true` (wiping
  the terminal) and broadcasts a `full-reload`. The build's sources outside `hub/` (`files`:
  `package.json`, the favicons; p552's snippets and Phase 4's CHANGELOG and issues later) go
  through `server.watcher`. `hub.config.ts` and `devTools/hub/*` are Vite config dependencies: a
  change restarts the server, and open Hub tabs reload when it's back.
- **No per-page incremental build.** A full dev build takes 35-60 ms (sass ~40 ms cold, Vite's
  TS build ~12 ms warm), and rebuilding one page would miss what crosses pages (the nav, a `hub:`
  link a heading rename breaks). Every run builds everything, and `diffBuilds` (`hubPlugin.ts`)
  compares it with the last run. The event is `HubDevEvent` (`devTools/hub/devProtocol.ts`, no
  imports): `{ kind: 'css', version }` when the stylesheet's hash changed, `{ kind: 'pages', paths }`
  for the pages whose HTML changed (compared without the `hub.css` / `hub-data.js` `?v=`, plus
  removed pages; `'404'` for the 404 page, which reloads on any `pages` event), `{ kind: 'all' }`
  when a script or a static asset changed. Open question 3 stays the answer if p553's pages make
  this slow.
- **Error pages** come from `buildHub` in `dev` mode. An error is attributed to the page whose
  folder holds its file. Errors outside every page (shell, SCSS, TS, a missing homepage) go on
  every page and on the 404 page. A failed SCSS or TS build keeps the last good assets
  (`fallback`), so the error page keeps its styles. The terminal gets each run's errors and
  warnings that are new since the last run, a "No errors" line when they clear, and one
  `[Hub] Updated: …` line per run that changed something. A run that changes nothing prints
  nothing.
- **Lazy start:** the first `/hub` request empties `.cache/hub/dev/` and builds. Later runs remove
  the files of pages that are gone. Images newer than their source aren't re-encoded.
- `HubDiagnostics` keeps each diagnostic once (the shell's errors came up once per page).
- `devTools/hub/serve.ts` resolves a URL to a file, redirect or 404 for both `hub:preview` and the
  plugin.
- Verified against a dev server and headless Chromium: `/hub` redirects; an `.md` save reloads
  only that page's tab; an SCSS save restyles without a reload; a scene JSON gather reloads the
  app tab and not the Hub tabs; an app `.ts` save gives no Hub output or event; a dead link shows
  the error page and fixing it brings the page back; a `hub.config.ts` save restarts the server and
  the Hub tab reloads with the new token.

### Phase 3 — Design shell

§2.6 and the design (p550 §3.7): tokens, the nav with dropdowns and the mobile menu, breadcrumbs,
the TOC, the footer, the theme toggle, icons, fonts, the homepage skeleton with the placeholder hero.

**Exit:**

- The homepage reads as the design's layout at 1536 px, and the nav collapses to the menu button at
  375 px with no horizontal scroll.
- The light and dark themes both pass a contrast check for body text and the accent.
- The active nav item follows the page, nested pages included.
- Keyboard: the nav, dropdowns and theme toggle work without a mouse.

### Phase 4 — Issues and Version

§2.5.

**Exit:** the three current `docs/issues/*.md` files each get a page with the right title and status.
The Version page shows the versions from `package.json` and the whole changelog, and a changelog
entry's anchor links work. Saving `CHANGELOG.md` during `yarn dev` refreshes the Version page.

### Phase 5 — Docs

1. CLAUDE.md:
   - Commands: `hub:build`, `hub:preview`, `AEK_HUB`, `AEK_HUB_IN_DIST`.
   - A new "Ækasha Hub" section under Architecture: the source layout, the page format, the dev
     plugin, the modes, the generated sections.
   - The issue-file convention.
   - The rule from p550 §5, under "Plans logic and structure" and "Workflow".
   - Build config notes: the plugin.
2. `docs/techniques/hub-authoring.md`: adding a page, slots and metadata, `hub:` links, callouts,
   images, how dev refresh works. p552-p555 extend it.
3. `readme.md`: Commands (`hub:build`, `hub:preview`), Documentation (the Hub next to
   `yarn docs`), Project structure (`hub/`).

### Phase 6 — Versioning and marking the plan done

`CHANGELOG.md` Project entry (§4). No part changes, so `yarn checkVersions --against main` passes
without a bump.

## 4. Versioning

Project only: `hub/`, `devTools/` and `vite.config.ts` are repo tooling. `vite.config.ts`'s
`__PROJECT_METADATA__` output is unchanged by §2.1, so the engine isn't touched.

## 5. Open questions

1. **Hashed file names instead of `?v=`** if the host's CDN ignores query strings (p550 §3.6).
2. **A standalone `yarn hub:dev`** (the Hub without the engine's dev server, for writing content
   only): the plugin would run in a bare Vite server. Not needed while `yarn dev` starts quickly.
3. **Incremental TOC/nav for very large trees:** p553 adds hundreds of API pages. If a full rebuild
   gets slow, the nav can become a shared partial that pages include at build time instead of each
   rendering its own copy.
