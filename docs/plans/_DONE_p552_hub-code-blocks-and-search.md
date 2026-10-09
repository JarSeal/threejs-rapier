Status: implemented (Phases 1-4)
Category: Dev tooling, Hub
Epic: \_DONE_p550_aekasha-hub-epic.md
Blocks: \_DONE_p553_hub-api-documentation.md (its search entries), \_DONE_p554_hub-examples-start-scene-and-example-scenes.md (its snippets)

# Hub Code Blocks & Search

Two things every Hub page leans on: code blocks good enough to learn an engine from, and a
search across all of it.

---

## 1. Grounding

- p551's Markdown (`devTools/hub/markdown.ts`) is markdown-it with a directive registry, and its
  dev plugin rebuilds a page when a file the page recorded as a dependency changes.
- The engine's code is TypeScript plus JSON scene and asset files, SCSS, TSL (TypeScript) and some
  WGSL/GLSL in `docs/`. Commands are bash (`source .claude/hooks/use-node.sh && yarn …`).
- Code regions are not marked anywhere yet: example code would be copied into pages by hand, and
  drift from the source.
- No highlighter is a direct dependency. TypeDoc's shiki build (`@gerrit0/mini-shiki`) is its own.

## 2. Design

### 2.1 Highlighting

shiki (with `@shikijs/transformers`) at build time, so pages carry highlighted HTML and no
highlighter JS.

- **Themes:** a dark and a light theme, emitted together as CSS variables (shiki's dual themes)
  and switched by the Hub's theme (p551). Tuned to the Hub's tokens: the cyan accent for keywords
  or functions, never more than the design can carry.
- **Languages:** ts, tsx, js, json, jsonc, bash (and `sh`/`shell` aliases), scss, css, html, wgsl,
  glsl, diff, yaml, md. Loaded once per build. An unknown language renders plain with a warning.
- **Inline code:** `` `createMeshEntity(props)`{ts} `` is highlighted inline. Plain inline code is
  left as is.

### 2.2 Code block features

The fence meta (` ```ts title="space.ts" {3,5-7} `):

| Feature | How |
| --- | --- |
| Line numbers | On by default above 3 lines; `showLineNumbers` / `noLineNumbers` override. CSS counters, so they're never copied or selected. `startLine=40` for an excerpt. |
| Line highlights | `{3,5-7}` in the meta, or `// [!code highlight]` on a line |
| Diff lines | `// [!code ++]` and `// [!code --]`, with + / − gutters |
| Focus | `// [!code focus]`: other lines dimmed, shown on hover |
| Error / warning lines | `// [!code error]`, `// [!code warning]` |
| File name | `title="src/app/space.ts"`: a header with the name |
| Language badge | in the header, from the fence language |
| Copy | a button in the header; copies the clean source (no numbers, notation comments removed, `--` lines dropped, `++` markers removed) and shows "Copied" for 1.5 s; keyboard accessible |
| Wrap | `wrap`: soft-wraps long lines (default: horizontal scroll) |
| Collapse | `collapse`, or automatic above 30 lines: shows the first 15 with "Show all N lines" |
| Code groups | `::: code-group` around several fences: tabs labelled by their titles (the scene JSON next to its TS) |

The notation comments are removed from the rendered and copied code.

### 2.3 Snippet includes

`<<< path/from/repo/root.ts#region {meta}` includes a file's region as a code block. The region is
marked in the source with `// #region name` and `// #endregion name` (`/* */` in CSS, nothing in JSON:
a JSON file is included whole, or with a line range `#L10-L24`). The marker lines are dropped and
the region is dedented. The language comes from the extension, the title defaults to the path.

- The Hub shows the real example code (p554), so it can't drift from the scene that runs.
- A missing file or region fails the build with the page and line.
- Each included file is recorded as the page's dependency, and p551's dev plugin rebuilds the page
  when it changes, and only then: an edit elsewhere in the app still doesn't touch the Hub.
- Includes are limited to the repo (no `..` out of it) and to text extensions.

### 2.4 Search

- **Index** (`hub-search.js`, built by the generator): one document per heading section of every
  page (page title, section heading, text without markup, tags, section path, URL with the
  anchor). p553 adds one per API symbol (name, kind, module, summary). Code blocks are indexed for
  identifiers only (names, not the whole code).
- **Engine:** minisearch, bundled into `search.js`. Prefix and fuzzy (0.2) matching, boosts: title
  ×4, heading ×3, tags ×2, symbol name ×4. The serialized index is built at build time
  (`MiniSearch.toJSON`) so the browser only loads it.
- **Loading:** `search.js` and `hub-search.js` load on the first focus of the search box, the first
  ⌘K / Ctrl+K or the first `/`, then stay cached (`?v=`).
- **UI:** a dialog with an input, results grouped by top-level section (Examples, Features,
  Documentation, …) with the breadcrumb from `hub-data.js`'s nav, the match highlighted and a
  snippet. Arrow keys move, Enter opens, Escape closes. "No results" suggests the closest page
  titles. The last query is kept for the session.
- **Size:** the index is reported by `hub:build`. Over 1 MB it's a warning (the API docs are the
  risk), and the fix is fewer indexed fields for API symbols.

## 3. Phases

### Phase 1 — Code blocks — done

§2.1, §2.2.

**Exit:** a test page has one block with every feature (line numbers, highlights, diff, focus,
error, title, wrap, collapse, a code group). Copy puts exactly the clean source on the clipboard.
Both themes read well. A 375 px screen scrolls the code, not the page.

As built:

- shiki and `@shikijs/transformers` 4.5.0. `devTools/hub/code.ts` is a markdown-it plugin
  (`hubCodePlugin`, wired in `buildHub` with the highlighter and the icons). The highlighter loads
  once per process (`loadHubHighlighter`), so dev rebuilds share it.
- Themes: two custom ones, `aekasha-dark` / `aekasha-light` (`devTools/hub/codeThemes.ts`). Every
  colour passes AA on `--hub-code-bg` and on each line tint over it. Tints are tokens in
  `_tokens.scss` (`--hub-code-highlight`, `-add`, `-remove`, `-warning-bg`).
- `text`, `txt`, `plain` and a fence without a language render plain without a warning. Line
  highlights (`{3,5-7}`) count from the block's first line, whatever `startLine` is. An unknown
  meta word warns.
- Collapse marks the hidden lines `hubCodeFold` at build time. The button toggles back
  ("Show fewer lines"). Without JS every line shows, and the copy buttons and tabs are hidden.
- Code groups: the tabs are rendered at build time (WAI-ARIA tabs, arrow keys, Home / End). For
  that, `HubDirectiveContext` gained `tokens` and `idx`, and `markdown.ts` exports `uniqueId`.
  Without JS every block of a group shows, with its title.
- Copy reads the clean source from the DOM: the notation comments are already gone, line numbers
  and diff markers are CSS, and `.remove` lines are skipped. Outside a secure context (a LAN
  address over http) it falls back to `execCommand('copy')`.
- The test page is a real page, `hub/pages/documentation/code-blocks/`: the reference for the
  fence meta and notation comments, with an "All together" block (Phase 4's
  `hub-authoring.md` links to it).
- Icons `copy` and `check` (Lucide) added.
- For Phase 2: the dev plugin has no per-page rebuild (p551 dropped it). A file outside `hub/` in
  `HubBuildResult.files` is watched through `server.watcher`, and a change rebuilds the whole Hub
  and reloads only the pages whose HTML changed. An included file only needs to go into `files`.

### Phase 2 — Snippet includes — done

§2.3.

**Exit:** a page includes a region of a file under `src/` during `yarn dev`. Editing that region
refreshes the page. Editing another `src/` file doesn't rebuild the Hub. A missing region fails
`yarn hub:build`.

As built:

- `devTools/hub/snippets.ts` reads a snippet (`parseSnippetSpec`, `readSnippet`: the path, the
  region or line range, dedent), and `code.ts`'s block rule `hub_snippet` turns `<<<` into an
  ordinary `fence` token. So an include has every Phase 1 feature and works in `::: code-group`.
  The fence meta goes after the path. The title defaults to the path (a `title=` replaces it).
- Markers in any comment style (`//`, `/* */`, `<!-- -->`, `#`). The first word after
  `#region` is the name, and text after it is a note (`// #region dynamic-box (shown in the
  Hub: …)`). A bare `#endregion` closes the innermost region. Nested markers are dropped. A
  region name used twice in a file, an unclosed region, an empty one and `#name` on a `.json`
  file (`.jsonc` has comments) are errors.
- `#L10-L24` (or `#L10`) works on any file. It is numbered as in the file (`startLine`, unless
  the meta sets one or a dropped marker line would shift the numbers); a region is numbered from 1.
- Allowed: paths from the repo root, inside it after symlinks, with a text extension (the
  table in `snippets.ts`, which also picks the language).
- `HubMarkdownEnv.includes` records every included file, even a missing one, and `buildHub` adds
  them to `files`. The dev plugin needed no change. Checked on `yarn dev`: an edit in the region
  updates the page, an edit to another `src/` file doesn't rebuild the Hub, and a missing region
  fails `yarn hub:build` with the page and line.
- The first region: `dynamic-box` in `src/app/physicsTest.ts` (comment only), included in the
  "Snippet includes" section of `hub/pages/documentation/code-blocks/`.

### Phase 3 — Search — done

§2.4.

**Exit:** ⌘K, Ctrl+K and `/` open search. Typing a heading's words finds its section, and a typo
still finds it. Results open the right anchor. The search files load only on first use (network
tab) and come from the cache on the next page.

As built:

- minisearch 7.2.0. The index (`devTools/hub/search.ts`) is built from each page's rendered body,
  so a page's own markup, its Markdown and the generated sections are all in it: one document per
  heading with an id, plus the page's own section (the text before its first heading, with the
  `aek:description` in front). The page title and tags are on that section only, so a page's title
  finds the page before its sections. The homepage isn't indexed (its sections are its layout).
  Code blocks give their identifiers, without keywords.
- `devTools/hub/searchProtocol.ts` (no Node imports) holds what the build and the browser share:
  the document type, the fields, the boosts and the tokenizer. Indexed text also gets each word's
  camelCase parts (`mesh` finds `createMeshEntity`); a query isn't split. Prefix matching starts at
  two characters, fuzzy (0.2) at four.
- `hub-search.js` is `export default JSON.parse('…')`. Its URL (relative to `_assets/`, with its
  `?v=`) is `hub-data.js`'s `searchIndex`, not in the pages: a text edit changes only that file's
  `?v=`, which the dev plugin already ignores, so it reloads only the edited page.
- The search code isn't a `search.js` entry but a chunk `hub.ts` imports on first use
  (`hub/_assets/ts/_search.ts` → `_assets/chunks/_search-<hash>.js`, 25 kB minified, minisearch
  included): its file name is its version. The first focus or hover of the search button preloads
  it and the index; a click, ⌘K / Ctrl+K or `/` (outside a field) opens the dialog.
- The dialog is a native modal `<dialog>` built by `_search.ts`: a combobox input over a listbox,
  results grouped by top-level section in the order of each group's best result, at most 50. A
  result shows its breadcrumb (pages below the section, then the headings above it, from
  `hub-data.js`), its heading and a snippet around the first match, the matched terms in `<mark>`.
  No results: up to three page titles from a looser title search (fuzzy 0.4). The query is kept in
  `sessionStorage` (`aekHubSearch`).
- Chrome traps: a `type="search"` input spends the first Escape clearing itself, so the input
  closes the dialog on Escape itself; and with nothing focused before the dialog opened, Chrome
  leaves the focus on the hidden input after a close, so the close blurs first, and `hub.ts`'s `/`
  ignores a field inside a closed dialog.
- `hub:build` prints the index's size and sections (341 kB, 91 kB gzipped, 105 sections; the
  changelog is most of it). Over 1 MB it warns.
- `yarn hub:preview` sends `_headers`' immutable caching for `_assets/`, so the next page's cache
  hit can be checked locally. The dev plugin removes renamed script chunks with removed pages.
- Ranking note: a prefix query sums every term it expands to, so "physic" ranks a changelog entry
  full of `physicsXxx` identifiers above the Physics example page ("physics" ranks the page first).
  Lowering the prefix weight hurt other queries. Revisit when p553–p555 add more pages than
  changelog.

### Phase 4 — Docs and versioning — done

`docs/techniques/hub-authoring.md`: the fence meta, notation comments, code groups, snippet
includes and region markers. CLAUDE.md's Hub section: snippet regions (a `// #region` in engine
or app code is a Hub include: renaming it breaks a page). `CHANGELOG.md` Project entry, mark the
plan done.

As built:

- `hub-authoring.md` gained Code blocks (with notation comments and code groups), Snippet
  includes (with regions) and Search (what's indexed, and how titles, headings and `aek:tags`
  weigh) sections. It also gained the include and code warnings in its errors table, and an
  included file in its dev refresh table. It links to the Hub's Code blocks page for the
  rendered reference rather than repeating every example.
- CLAUDE.md's Hub section got Code blocks, Snippet includes and Search bullets, with the
  `#region` rule in bold. Its Output bullet now lists `hub-search.js` and the chunks, and the dev
  plugin bullet lists included files among the watched sources.
- The branch's existing `CHANGELOG.md` entry (`aekasha-hub`, p551's) is extended rather than a
  second one added: p552 ships in the same branch, and its sentence saying code blocks and search
  "come in later branches" was wrong.
- Versioning differs from §4's "Project only": Phase 2's region comment in
  `src/app/physicsTest.ts` is an app change to `yarn checkVersions --against main`, so the app
  gets a patch (1.8.0 → 1.8.1, an App section in the entry). The project version follows the
  engine's and stays.
- The readme's Hub line mentions search. The Code blocks page's tags and description name snippet
  includes, so search finds it.

## 4. Versioning

Project only.

## 5. Open questions

1. **Type hovers (twoslash):** shiki's twoslash shows types on hover in TS code blocks, checked
   against the real types. It's heavy (a TS program per block) and needs the engine's types
   resolvable from a snippet. Worth a spike after p553.
2. **"Open in example scene" on a block:** a dev-only button on an included snippet that opens its
   scene (p554's links). Small once p554's directive exists.
