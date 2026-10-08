Status: draft | not-implemented
Category: Dev tooling, Hub
Epic: p550_aekasha-hub-epic.md
Blocked by: p551_hub-site-generator-and-dev-server.md
Blocks: p553_hub-api-documentation.md (its search entries), p554_hub-examples-start-scene-and-example-scenes.md (its snippets)

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

### Phase 1 — Code blocks

§2.1, §2.2.

**Exit:** a test page has one block with every feature (line numbers, highlights, diff, focus,
error, title, wrap, collapse, a code group). Copy puts exactly the clean source on the clipboard.
Both themes read well. A 375 px screen scrolls the code, not the page.

### Phase 2 — Snippet includes

§2.3.

**Exit:** a page includes a region of a file under `src/` during `yarn dev`. Editing that region
refreshes the page. Editing another `src/` file doesn't rebuild the Hub. A missing region fails
`yarn hub:build`.

### Phase 3 — Search

§2.4.

**Exit:** ⌘K, Ctrl+K and `/` open search. Typing a heading's words finds its section, and a typo
still finds it. Results open the right anchor. The search files load only on first use (network
tab) and come from the cache on the next page.

### Phase 4 — Docs and versioning

`docs/techniques/hub-authoring.md`: the fence meta, notation comments, code groups, snippet
includes and region markers. CLAUDE.md's Hub section: snippet regions (a `// #region` in engine
or app code is a Hub include: renaming it breaks a page). `CHANGELOG.md` Project entry, mark the
plan done.

## 4. Versioning

Project only.

## 5. Open questions

1. **Type hovers (twoslash):** shiki's twoslash shows types on hover in TS code blocks, checked
   against the real types. It's heavy (a TS program per block) and needs the engine's types
   resolvable from a snippet. Worth a spike after p553.
2. **"Open in example scene" on a block:** a dev-only button on an included snippet that opens its
   scene (p554's links). Small once p554's directive exists.
