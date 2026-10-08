Status: draft | not-implemented
Category: Instructions, Hub
Epic: p550_aekasha-hub-epic.md
Blocked by: p551_hub-site-generator-and-dev-server.md, p553_hub-api-documentation.md, p554_hub-examples-start-scene-and-example-scenes.md

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

## 2. Design

### 2.1 Feature pages

`hub/pages/features/<slug>/`, one each:

| Slug | Feature | Example (p554) |
| --- | --- | --- |
| `rendering` | WebGPU renderer, WebGL fallback, PostFX | Quick start |
| `ecs` | ECS: entities, components, plugins, stages, managed entities | Custom component & system |
| `physics` | Physics API, threads, transform buffer, deterministic loads, simulation tiers | Physics |
| `scenes-and-assets` | Scene and asset JSON, the gatherer, `__saveData` | Quick start |
| `asset-optimization` | The asset pipeline: KTX2, meshopt/Draco, budgets, lock file | Toolkit |
| `sky-box` | The layered sky, presets, day-night | Sky box & day-night |
| `lod` | LOD chains, selection, cross-fades, impostors, instanced pools | LOD & instancing |
| `spatial-index` | Grids, domains, scene scope | — |
| `viewports` | Viewports and views | — |
| `debug-suite` | Drawer tabs, profiler, GPU memory, undo, character tools, dev file server, material editor | Your own debug tab |
| `characters` | The dynamic character controller | — |
| `toolkit` | What the toolkit holds and how to use or copy it | Toolkit |

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

## 3. Phases

### Phase 1 — Feature pages

§2.1, §2.2 (the `cards` directive) and §2.3.

**Exit:**

- Every page in the table builds, with `api:` links that resolve.
- Each page's example link opens its scene in dev.
- A reviewer spot-checks three pages against the code.

### Phase 2 — Homepage

§2.4.

**Exit:** the homepage has the design's sections with real content. "What's new" follows
`CHANGELOG.md` (adding an entry updates it on the next build). It holds up at 375 px.

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
