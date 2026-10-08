A Hub page's code is highlighted when the Hub is built, so a page carries no highlighter. Write a
Markdown fence with a language, and add options after the language (the fence's _meta_) or as
comments in the code (_notation comments_). The notation comments are removed from the page and
from what the copy button copies.

## The fence

````md
```ts title="src/app/myScene.ts" {3,5-7}
// The code
```
````

| Meta | What it does |
| --- | --- |
| `title="…"` | A header with the file name |
| `{3,5-7}` | Highlights those lines (counted from the block's first line) |
| `showLineNumbers`, `noLineNumbers` | Line numbers are on from 4 lines; these override it |
| `startLine=40` | Numbers the lines from 40, for an excerpt |
| `wrap` | Wraps long lines instead of scrolling them |
| `collapse` | Shows the first 15 lines and a "Show all" button (on by itself from 31 lines) |

The languages are `ts`, `tsx`, `js`, `json`, `jsonc`, `bash` (`sh`, `shell`), `scss`, `css`,
`html`, `wgsl`, `glsl`, `diff`, `yaml` and `md`. A fence without one, or with `text`, is plain. An
unknown language is plain too, with a warning in the build.

## Notation comments

A comment at the end of a line marks that line. On a line of its own, it marks the next one.

| Comment | Marks the line as |
| --- | --- |
| `// [!code highlight]` | highlighted |
| `// [!code ++]`, `// [!code --]` | added or removed, with a + or − gutter. Copy leaves the removed lines out |
| `// [!code focus]` | focused: the other lines are dimmed until you point at the block |
| `// [!code error]`, `// [!code warning]` | an error or a warning |

Use the language's own comment: `/* [!code ++] */` in CSS, `# [!code ++]` in bash and YAML.

## Examples

### Highlights and a title

```ts title="src/app/myScene.ts" {6-7}
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';

export const scene = async () => {
  const geo = createGeometry({ id: 'ball', type: 'SPHERE', params: { radius: 0.4 } });
  const mat = createMaterial({ id: 'ball', type: 'STANDARD', params: { color: 0xff5533 } });
  createMeshEntity({ geo, mat, position: { x: 0, y: 5, z: 0 } }, { appId: 'ball' });
};
```

### A diff

```ts
await createPhysicsEntity(
  { type: 'BALL', radius: 0.4, restitution: 0.2 }, // [!code --]
  { type: 'BALL', radius: 0.4, restitution: 0.6 }, // [!code ++]
  { rigidType: 'DYNAMIC', translation: position },
  ballId
);
```

### Focus

```ts
const position = { x: 0, y: 5, z: 0 };
const ballId = createMeshEntity({ geo, mat, position, castShadow: true }, { appId: 'ball' });
// [!code focus:4]
await createPhysicsEntity(
  { type: 'BALL', radius: 0.4, restitution: 0.6 },
  { rigidType: 'DYNAMIC', translation: position },
  ballId
);
```

### Errors and warnings

```ts
createMeshEntity({ geo, mat, position }); // [!code warning]
createMeshEntity({ geo: 'ball', mat }); // [!code error]
```

### An excerpt with wrapped lines

```ts startLine=40 wrap
// The transform syncs back to the mesh every frame, at APP_POST_PHYSICS, so read the mesh's position after physics has stepped and not before it.
const ballId = createMeshEntity({ geo, mat, position, castShadow: true }, { appId: 'ball' });
```

### Code groups

Fences inside `::: code-group` become tabs, labelled by their titles (or their languages).

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

Renders as:

::: code-group

```bash title="yarn"
yarn dev
```

```bash title="yarn (HTTPS)"
yarn dev:https
```

```bash title="Production env"
yarn dev:production
```

:::

### Inline code

Inline code with a language after it is highlighted too: `` `createMeshEntity(props)`{ts} ``
renders as `createMeshEntity(props)`{ts}.

## Snippet includes

Show the real code instead of a copy of it: `<<<` on a line of its own includes a file, or a part
of it, as a code block. The page can't drift from the code, and while `yarn dev` runs, an edit to
the file refreshes the page.

| Include | What it shows |
| --- | --- |
| `<<< path/from/repo/root.ts` | The whole file |
| `<<< path/from/repo/root.ts#name` | The region `name` |
| `<<< path/from/repo/root.json#L10-L24` | Lines 10 to 24, numbered as in the file |

The path is from the repo root and stays inside it, and the file is a text file. The language
comes from its extension and the title is its path. After the path, the fence meta works as on
a fence (`<<< src/app/space.ts#asteroids {3-5} title="space.ts" wrap`).

Mark a region in the source with a comment. Text after the name is a note, and the marker lines
(those of regions nested in it too) are left out of the page:

```ts
// #region dynamic-box (shown in the Hub: hub/pages/documentation/code-blocks/)
const createDynamicBox = async (id: string, position: PhysVector, color: number) => {
  // …
};
// #endregion dynamic-box
```

Use the language's own comment: `/* #region name */` in CSS, `<!-- #region name -->` in HTML and
Markdown, `# #region name` in bash and YAML. JSON has no comments, so a JSON file is included
whole or by lines.

::: warning A region is part of a page
A missing file, region or line fails `yarn hub:build` with the page and line, so renaming or
removing a region that a page includes breaks the page. Say so in the marker's note.
:::

`<<< src/app/physicsTest.ts#dynamic-box {20-24}` shows:

<<< src/app/physicsTest.ts#dynamic-box {20-24}

## All together

One block with a title, line highlights, a diff, a focus, an error and a warning, wrapped lines,
and collapsed after 15 lines.

```ts title="src/app/myScene.ts" {6} wrap collapse
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';

export const scene = async () => {
  const position = { x: 0, y: 5, z: 0 };
  const geo = createGeometry({ id: 'ball', type: 'SPHERE', params: { radius: 0.4 } });
  const mat = createMaterial({ id: 'ball', type: 'STANDARD', params: { color: 0xff5533 } }); // [!code warning]
  const mat = createMaterial({ id: 'ball', type: 'STANDARD', params: { color: 0x3fd8f2 } }); // [!code error]

  // Attach a dynamic rigid body. Its transform syncs back to the mesh every frame, at APP_POST_PHYSICS, after the physics step.
  const ballId = createMeshEntity({ geo, mat, position, castShadow: true }, { appId: 'ball' });
  await createPhysicsEntity( // [!code focus:5]
    { type: 'BALL', radius: 0.4, restitution: 0.2 }, // [!code --]
    { type: 'BALL', radius: 0.4, restitution: 0.6 }, // [!code ++]
    { rigidType: 'DYNAMIC', translation: position },
    ballId
  );
  // [!code highlight]
  return ballId;
};
```
