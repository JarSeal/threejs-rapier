# Writing Ækasha Hub pages

The Ækasha Hub is the engine's instructions, examples and documentation as a static site. The dev server serves it at `/hub/` next to the app, and `yarn hub:build` builds it into `dist-hub/` for any static host. A page is a folder with an HTML layout and Markdown for its text. The generator puts each page into a shared shell (nav, breadcrumbs, table of contents, footer), checks its links, and refreshes open tabs when you save.

## How it works

```text
hub/pages/examples/physics/index.html ──┐  (layout, title, menu metadata, slots)
hub/pages/examples/physics/intro.md ────┤  (fills <div id="intro">)
hub/_layout/shell.html ─────────────────┤  (nav, breadcrumbs, TOC, footer)
hub/_assets/ (SCSS, TS, icons, fonts) ──┘
                                        │   yarn dev (/hub/)  ·  yarn hub:build
                                        ▼
            .cache/hub/dev/ or dist-hub/
              examples/physics/index.html
              _assets/hub.css?v=…, hub.js?v=…, hub-data.js?v=…, hub-search.js?v=…
```

- **Sources** are in `hub/` at the repo root, outside Vite's root. The app's dev server never serves them raw, and nothing can import them into the app's bundle.
- **The generator** is `devTools/hub/`. `yarn hub:build` and the dev plugin (`devTools/hubPlugin.ts`) both run it.
- **Every link it writes is relative** (`../../features/`), so the same build works at a domain root and under `/hub/`.

## Run it

| Command                           | What it does                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn dev`, then open `/hub/`     | Builds the Hub on the first `/hub` request, then rebuilds it on every save (see [Refreshing in dev](#refreshing-in-dev)).                                                                            |
| `yarn hub:build [--out <dir>]`    | Builds the public site into `dist-hub/`. An error prints its file and line, writes nothing and exits 1. `yarn build` runs it last.                                                                   |
| `yarn hub:preview [--base /hub/]` | Serves `dist-hub/` on port 8090 the way a static host does: directory URLs, and `404.html` for a missing path. `--base /hub/` serves it under a path, as the app's site does with `AEK_HUB_IN_DIST`. |
| `AEK_HUB=false`                   | Turns off the dev server's `/hub/`, and `yarn build` skips the Hub build.                                                                                                                            |
| `AEK_HUB_IN_DIST=true yarn build` | Also copies the Hub into `dist/hub/`, so the app's site serves it at `/hub/`. It's off by default, so the Hub isn't in production unless you ask for it.                                             |

## Add a page

A page is a folder under `hub/pages/` with an `index.html`. Its URL is its folder's path:

```text
hub/pages/index.html                       → /hub/
hub/pages/examples/index.html              → /hub/examples/
hub/pages/examples/physics/index.html      → /hub/examples/physics/
```

Every page needs its parent page: `examples/physics/` needs `examples/index.html`. Folders starting with `_` or `.` are skipped.

```html
<!-- hub/pages/examples/physics/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Example: Physics</title>
    <meta name="aek:menu" content="Physics" />
    <meta name="aek:order" content="20" />
    <meta name="aek:tags" content="physics, rapier, rigid bodies, colliders" />
    <meta
      name="aek:description"
      content="A static ground plane with primitive shapes dropping onto it, simulated by Rapier."
    />
  </head>
  <body>
    <h1>Example: Physics</h1>
    <div id="intro"></div>
  </body>
</html>
```

The `<head>` is for metadata only. Nothing else in it reaches the built page, because the shell has its own `<head>`.

| Head tag          | Meaning                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `<title>`         | Required. The page's title, in the browser tab (`Example: Physics · Ækasha Hub`) and the breadcrumbs.                   |
| `aek:menu`        | The label in the nav and the breadcrumbs. Defaults to the title.                                                        |
| `aek:order`       | The position among its siblings in the nav. Lower comes first, and ties are sorted by label. Defaults to 0.             |
| `aek:tags`        | Comma-separated search terms.                                                                                           |
| `aek:description` | One sentence. It becomes `<meta name="description">`, and it's used for search and cards.                               |
| `aek:icon`        | An icon name from `hub/_assets/icons/` (without `.svg`). Only top-level sections show it in the nav.                    |
| `aek:featured`    | `true` to feature the page on the homepage. It's parsed, but nothing reads it until the homepage's content plan (p555). |

The nav is built from these tags alone, so there's no separate menu list to keep in sync. A misspelt `aek:` name gives a warning.

The `<body>` is the page's own markup, and it goes into the shell's main column. Write the page's `<h1>` there, then the slots for its text.

## Slots and Markdown

Every **empty element with an `id`** in the body is a slot. The generator fills it with the `.md` file of the same name in the page's folder:

```html
<h1>Examples</h1>
<!-- Filled by intro.md -->
<div id="intro"></div>
<!-- Filled by quick-start.md -->
<section id="quick-start"></section>
```

- The element stays as you wrote it, with its tag, classes and attributes, so a slot can be styled or placed in a layout (the homepage's hero is a slot inside a grid).
- **An `.md` without a slot fails the build**, and so does an `.md` in a folder without an `index.html`. Rename one or the other.
- **A slot without an `.md` is a warning**, and the slot stays empty.
- Start an `.md` with `##`. The page's `<h1>` is in its markup.

Markdown is [markdown-it](https://github.com/markdown-it/markdown-it) (CommonMark plus tables and strikethrough), with raw HTML allowed and bare URLs turned into links. Tables scroll on their own on narrow screens.

### Headings and the table of contents

Every heading gets an id from its text (`### Install and run` → `#install-and-run`) and a `#` link that shows on hover. An id is never one that the page's markup already uses: on a page with a `quick-start` slot, a "Quick start" heading gets `quick-start-2`, and `#quick-start` still reaches the slot.

The "On this page" table of contents lists the `##` and `###` headings of every slot, in page order. It's shown when there are at least 3 of them, from 1200 px wide, and never on the homepage.

## Links

Link to another Hub page with `hub:` and its path from `hub/pages/`:

```md
Drop some shapes in the [physics example](hub:examples/physics).
See the [requirements](hub:examples#requirements).
Back to the [Hub](hub:).
```

- The generator turns each one into a relative URL and **checks it**. A missing page, or a `#hash` that isn't an id on that page, fails the build with the file and line. Renaming a heading that something links to shows up straight away.
- A trailing slash is optional: `hub:examples/physics` and `hub:examples/physics/` are the same.
- `hub:` works in a page's markup too: `<a href="hub:features">` and `src="hub:…"`.
- A plain `#hash` link to the same page isn't checked. Use `hub:<this page>#hash` when you want it checked.
- Write external links as full URLs. Never write a root-relative `/hub/…` link: it breaks the site on a domain root.

## Callouts

```md
::: tip The debug suite
Open `http://localhost:8080/?isDebug=true`, then press `h` to open the drawer.
:::
```

- The kinds are `tip`, `note`, `warning` and `danger`. The text after the kind is the title, written as inline Markdown. Without it, the title is the kind ("Tip").
- The content is ordinary Markdown: lists, code blocks and links all work.
- A callout without its closing `:::` fails the build, and so does an unknown name.
- To put a directive inside another, give the outer one a longer marker:

```md
:::: note
Some text.

::: warning
Nested.
:::
::::
```

The other directives are `code-group` ([Code groups](#code-groups)), and later `scene` (p554) and `cards` (p555). A new one is added through `registerHubDirective(name, { open, close })` in `devTools/hub/markdown.ts`, without touching the parser.

## Code blocks

Code is highlighted by [shiki](https://shiki.style/) when the Hub is built (`devTools/hub/code.ts`), so a page carries highlighted HTML and no highlighter. The two themes (`devTools/hub/codeThemes.ts`) follow the Hub's dark and light theme. The Hub's own [Code blocks page](../../hub/pages/documentation/code-blocks/intro.md) (`/hub/documentation/code-blocks/`) shows every feature rendered, and its "All together" block uses them all at once.

Write a fence with a language, and put options after the language (the fence's _meta_):

````md
```ts title="src/app/myScene.ts" {3,5-7}
// The code
```
````

| Meta                               | What it does                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `title="…"`                        | A header with the file name. The header also has the language badge and the copy button.   |
| `{3,5-7}`                          | Highlights those lines, counted from the block's first line (whatever `startLine` is).     |
| `showLineNumbers`, `noLineNumbers` | Line numbers are on from 4 lines. These override it.                                       |
| `startLine=40`                     | Numbers the lines from 40, for an excerpt.                                                 |
| `wrap`                             | Wraps long lines. Without it, they scroll sideways.                                        |
| `collapse`                         | Shows the first 15 lines and a "Show all N lines" button. It's on by itself from 31 lines. |

An unknown meta word is a warning.

- **Languages:** `ts`, `tsx`, `js`, `json`, `jsonc`, `bash` (and `sh`, `shell`), `scss`, `css`, `html`, `wgsl`, `glsl`, `diff`, `yaml` and `md`. A fence without a language, or with `text`, `txt` or `plain`, is plain. An unknown language is plain too, with a warning.
- **Inline code** with a language after it is highlighted: `` `createMeshEntity(props)`{ts} ``. Plain inline code stays as it is.
- **Copy** copies the code as a reader would type it. The line numbers, the notation comments and the `--` lines aren't in it.
- **Without JS**, every line shows, and the copy buttons and the code group tabs are hidden.

### Notation comments

A comment at the end of a line marks that line. On a line of its own, it marks the next one. `focus:4` (and `highlight:4`, …) marks that many lines. The comments are removed from the page and from what copy copies.

| Comment                                  | Marks the line as                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `// [!code highlight]`                   | highlighted                                                                |
| `// [!code ++]`, `// [!code --]`         | added or removed, with a + or − gutter. Copy leaves the removed lines out. |
| `// [!code focus]`                       | focused: the other lines are dimmed until the reader points at the block   |
| `// [!code error]`, `// [!code warning]` | an error or a warning                                                      |

Use the language's own comment: `/* [!code ++] */` in CSS, `# [!code ++]` in bash and YAML.

### Code groups

Fences inside `::: code-group` become tabs, labelled by their titles (else their languages). Use them for things a reader picks one of, or for the scene JSON next to its TS:

````md
::: code-group

```bash title="yarn"
yarn dev
```

```bash title="yarn (HTTPS)"
yarn dev:https
```

:::
````

A group holds only code blocks, two or more. Anything else in it is a warning.

## Snippet includes

Show the real code instead of a copy of it. `<<<` on a line of its own includes a file, or part of it, as a code block (`devTools/hub/snippets.ts`). The page can't drift from the code, and a renamed region fails the build instead of going stale.

| Include                                | What it shows                           |
| -------------------------------------- | --------------------------------------- |
| `<<< path/from/repo/root.ts`           | The whole file                          |
| `<<< path/from/repo/root.ts#name`      | The region `name`, numbered from 1      |
| `<<< path/from/repo/root.json#L10-L24` | Lines 10 to 24, numbered as in the file |

- **The path is from the repo root** and must stay inside it, symlinks included. Only text files can be included. The extension picks the language (`.ts`, `.json`, `.scss`, `.wgsl`, `.vert` / `.frag`, `.md`, …: the table in `snippets.ts`).
- **The title is the path.** After the path, the fence meta works as on a fence and can replace the title: `<<< src/app/space.ts#asteroids {3-5} title="space.ts" wrap`.
- **An include is an ordinary code block**, so it works inside `::: code-group` and takes notation comments from the source.
- **The code is dedented**, and blank lines around it are dropped.

### Regions

Mark a region in the source with `#region` and `#endregion` in a comment:

```ts
// #region dynamic-box (shown in the Hub: hub/pages/documentation/code-blocks/)
const createDynamicBox = async (id: string, position: PhysVector, color: number) => {
  // …
};
// #endregion dynamic-box
```

- **Use the language's own comment:** `/* #region name */` in CSS, `<!-- #region name -->` in HTML and Markdown, `# #region name` in bash and YAML.
- **The first word after `#region` is the name.** Text after it is a note. Use the note to say which page shows the region, so whoever edits the code knows a page depends on it.
- **The marker lines are left out of the page**, and so are the markers of regions nested inside it. A bare `#endregion` closes the innermost region.
- **JSON has no comments,** so a `.json` file is included whole or by lines. A `.jsonc` file can have regions.
- **A region name must be unique in its file.** A duplicate, an unclosed region and an empty one are errors.

::: warning A region is part of a page
Renaming or removing a region that a page includes fails `yarn hub:build`, and so does moving the file. The error names the page and line. Fix the include in the same change.
:::

## Search

The search box (⌘K, Ctrl+K or `/`) searches every page except the homepage. `yarn hub:build` builds the index (`devTools/hub/search.ts`) from each page's rendered body: its markup, its Markdown and the generated sections. The browser loads the search code and the index only when someone first uses the search.

- **A heading with an id is a search result.** Each section from a heading to the next is one result, with the headings above it as the breadcrumb. The text before a page's first heading is the page's own result, along with its `<title>`, `aek:tags` and `aek:description`. Headings make a long page easier to search as well as to read.
- **The title, headings and tags weigh the most.** Put the words a reader would search for in `aek:tags`, especially those the page doesn't spell out (`rapier` on the physics page).
- **Code blocks add their identifiers, not their keywords.** Identifiers are split at camelCase too, so `mesh` finds `createMeshEntity`.
- **`yarn hub:build` prints the index's size.** Over 1 MB it warns. The index is loaded whole on first use, so keep it lean.

No Hub file needs to change for a new page to be found: it's indexed on the next build.

## Images

### In Markdown

Put the image in the page's folder (a subfolder is fine) and refer to it with a relative path:

```md
![The crates at rest](./images/crates.png)
```

- It's copied to `_assets/images/pages/<page path>/…`. PNG and JPEG are converted to WebP by sharp, and other formats are copied as they are.
- It gets `?v=<content hash>`, `loading="lazy"` and `decoding="async"`.
- **It must be inside the page's folder.** A path out of it (`../other/x.png`), or a missing file, fails the build.
- Only Markdown images are processed. A raw `<img src="./x.png">` is left as it is and won't load.

### In a page's markup

For images shared between pages, put them in `hub/_assets/images/` and use the `{{asset:…}}` helper:

```html
<img
  class="hubHeroImage"
  src="{{asset:images/hero-placeholder.webp}}"
  alt=""
  width="585"
  height="360"
/>
```

## Markup helpers

A page's markup (its `index.html` body, not its Markdown) has these placeholders:

| Helper           | Gives                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `{{icon:name}}`  | The SVG from `hub/_assets/icons/<name>.svg`, inlined. It takes `currentColor`, so it follows the text colour. |
| `{{asset:path}}` | A static asset's URL under `hub/_assets/` (`images/…`, `fonts/…`, `icons/…`) with its `?v=` hash.             |
| `{{root}}`       | The relative path from the page to the site root (`../../`).                                                  |

The shell (`hub/_layout/shell.html`) also has `{{link:path}}`, a checked URL to a page. Pages use `hub:` instead.

An unknown icon, asset or helper fails the build. **Always reference a static asset through `{{asset:…}}`.** The built site caches `_assets/*` as immutable, so a bare path would stay stale in browsers after the file changes.

The icons are [Lucide](https://lucide.dev/) line icons (ISC, `hub/_assets/icons/LICENSE-lucide.txt`) plus the Æ mark (`aekasha.svg`). To add one, copy its SVG from `lucide-static` into `hub/_assets/icons/`.

## Generated sections

Two sections are built from files outside `hub/`. Their pages are ordinary hand-written pages, and a generator fills their `generated-*` slots and adds their child pages. An `.md` for a `generated-*` slot is an error.

### Issues

`/hub/issues/` lists every `docs/issues/*.md`, grouped by status, with a summary from each one. Each issue gets its own page at `/hub/issues/<file name>/`. Issue pages aren't in the nav, so their sentence-long titles don't crowd it.

To add an issue, add a file to `docs/issues/` with this header:

```md
**Title:** Some library: what goes wrong, in one sentence

Status: open | fixed upstream, not in a release yet
Category: Bug, Rendering
Found: 2026-10-08, while building …, three 0.186.1, Chrome, macOS
File at: https://github.com/…/issues/new
Our workaround: what we do until it's fixed

## Summary

What happens, and how to reproduce it …
```

- **`**Title:**` goes on line 1.** It becomes the page's title. Without it, the first heading or the file name is used, with a warning.
- **The `Key: value` lines start on line 3, `Status:` first.** The status becomes a badge, and the text after a `|` is shown next to it. Issues are grouped by the badge text: `open` first, then the others, and `fixed`, `closed`, `resolved`, `done` and `won't fix` last. Without `Status:`, the badge reads "Status not stated". The other keys are shown as a list under the badge.
- **The summary** in the list is the first paragraph of the first section (after a heading or a bold label line like `**Describe the bug**`), so a template's preamble is skipped.

### Version

`/hub/version/` shows the engine, toolkit, app and project versions with their codenames, and the build's commit (marked when there were local changes) and time. Below that comes the whole `CHANGELOG.md`, with each entry's heading as an anchor (`/hub/version/#2026-10-07-impostor-billboard-lod`). The newest entry is also the homepage's "What's new" data (`latestChange` in `hub-data.js`). Nothing to write here: keep `package.json` and `CHANGELOG.md` current, as the versioning rules ask.

## Refreshing in dev

While `yarn dev` runs, every save under `hub/` rebuilds the whole Hub (tens of milliseconds) and compares it with the last build. Only the tabs that need it refresh:

| You save                                                    | Open Hub tabs                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| An `.md` or a page's `index.html`                           | The tabs of every page whose HTML changed reload (a nav label change reaches them all).     |
| The SCSS                                                    | The stylesheet is swapped in place, without a reload.                                       |
| The Hub's TS, an icon, a font or an image in `hub/_assets/` | Every Hub tab reloads.                                                                      |
| `CHANGELOG.md`, `package.json`, a `docs/issues/*.md`        | The Version or Issues pages reload (a new engine version also reaches every page's footer). |
| A file a page includes with `<<<`                           | The pages that include it reload.                                                           |
| `hub/hub.config.ts` or the generator (`devTools/hub/`)      | Vite restarts the dev server, and open Hub tabs reload once it's back.                      |
| Anything else in the app, toolkit or engine                 | Nothing: the Hub isn't rebuilt.                                                             |

App tabs are never reloaded by a Hub save, and Hub tabs aren't reloaded by a scene gather. The Hub's dev client listens only to its own event (`aek:hub`).

**A page with an error** is served as an error page that lists each error with its file and line, and the terminal prints the same. Fix it and save, and the page comes back by itself. An error that isn't any page's (the shell, the SCSS, the TS) shows on every page. While the SCSS or TS is broken, the last good build of it is kept, so error pages keep their styles.

## Errors and warnings

The same checks run in dev and in `yarn hub:build`. In dev, an error shows the error page. In `yarn hub:build`, an error fails the build, and so `yarn build` fails too.

| Message (shortened)                                    | Fix                                                   |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `Dead link hub:…: no page at hub/pages/…`              | Fix the path, or add the page.                        |
| `Dead link hub:…#x: "<page>" has no #x`                | The heading was renamed, or the id is misspelt.       |
| `No slot for it: add an empty element with id="…"`     | An `.md` has no matching slot in its `index.html`.    |
| `Its folder has no index.html, so it's no page's`      | An `.md` is in a folder that isn't a page.            |
| `No parent page: hub/pages/…/index.html is missing`    | Add the parent page, so the nav can reach this one.   |
| `No <title>`                                           | Every page needs one.                                 |
| `Image not found` / `Image outside its page's folder`  | Move the image into the page's folder.                |
| `":::name" has no closing ":::"` / `Unknown directive` | Close the directive, or fix its name.                 |
| `Unknown icon` / `{{asset:…}}: no such file`           | Check the name against `hub/_assets/`.                |
| `No such file: …` (an include)                         | The included file moved. Fix the path after `<<<`.    |
| `No "#region x" in it (it has: …)`                     | The region was renamed or removed. Use one listed.    |
| `"#region x" … has no "#endregion x"`                  | Close the region in the source.                       |
| `#L…: … has lines 1-N`                                 | The file got shorter. Fix the range, or use a region. |
| Warning: `Slot "…" has no ….md: it stays empty`        | Add the `.md`, or remove the slot.                    |
| Warning: `Unknown <meta name="aek:…">`                 | A misspelt metadata name.                             |
| Warning: `Unknown code language "…"`                   | Use a listed language, or `text`.                     |
| Warning: `Unknown "…" in the code block's meta`        | A misspelt fence option.                              |
| Warning: `The search index is …, over 1 MB`            | Index less: fewer or shorter pages, fewer fields.     |

## Publishing

`yarn hub:build` writes a self-contained site into `dist-hub/`: the pages, `404.html`, `_assets/` and the favicons from `src/public/`. It loads nothing from another origin.

- **Netlify** reads the generated `_headers`, which caches `_assets/*` for a year as immutable. Every reference carries `?v=<content hash>`, so a deploy is picked up straight away. If a host's CDN ignores query strings in its cache key, that breaks: check the first real deploy.
- **Any other static host** works too. Serve `404.html` for missing paths, and give it its own caching headers.
- **Under a path:** the pages work at any depth. Only the 404 page needs to know its base URL. `AEK_HUB_IN_DIST` and `hub:preview --base` set it for `/hub/`.

## Keeping it current

A change that adds, changes or removes an engine or toolkit feature or public API updates its Hub content in the same branch: the feature page, the example page and its scene, and the snippets they include. A `#region` marker in engine, toolkit or app code means a page includes that code, so renaming or removing it breaks the page. Run `yarn hub:build` before you commit. It catches the links and includes your change broke.
