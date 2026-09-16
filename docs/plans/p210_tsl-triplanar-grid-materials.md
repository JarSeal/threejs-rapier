Status: draft | not-implemented
Category: Texture

# TSL Triplanar Grid Materials — Plan

Two new procedural TSL materials for `src/toolkit/materials/` — a grid-line
material and a checkerboard (with optional plus-sign) material — following
the existing declarative `<name>.tsl.ts` + `<name>.material.json` pattern
used by `src/toolkit/materials/checkerBoard.tsl.ts`. Both materials use
**world-space triplanar projection** (not the mesh's authored UV channel) so
that line thickness/checker size read as literal real-world meters on any
mesh, floor or wall alike — see Design decision below.

---

## 1. Goal

Add two configurable, reusable procedural materials to the toolkit:

- **Triplanar Grid** — thin grid lines over a background color. Inputs: line
  thickness (default 0.05m), line frequency/spacing (default 1m), line
  color, background color.
- **Triplanar Checkerboard** — configurable checker size, two checker colors, and
  an optional solid-color "+" mark centered in each cell. Inputs: checker
  size, two checker colors, a boolean to toggle plus-signs, and a plus-sign
  color.

All defaults must be easily reconfigurable via the material's JSON `nodes`
block (no code changes needed to retune). Both are visual/debug-style
materials (e.g. greyboxing, level layout reference) usable on any mesh
(floors, walls, arbitrary props) without requiring special UV unwrapping.

Out of scope: `roughnessNode`/`normalNode` sockets (reference imagery is
pure color/pattern, no surface relief) — only `colorNode` is implemented for
both. Scene/app integration (wiring these into an actual app scene) is not
part of this plan; verification uses a temporary/dev scene only.

---

## 2. Current state (grounded in the actual code)

- The engine has a declarative TSL-material pipeline: a `<name>.tsl.ts` file
  exports plain functions named after `NodeMaterial` sockets (`colorNode`,
  `roughnessNode`, `normalNode`, ...), and a sibling `<name>.material.json`
  declares `id`, `type` (a `*NODEMATERIAL` enum value), `tslFile`, `params`
  (static three.js material params), and `nodes: { <socket>: { <inputKey>:
  rawValue } }`.
- `yarn gatherAppData` (`devTools/gatherAppData.ts`) scans for
  `*.material.json`, validates via zod (`src/_engine/schemas/materialSchema.ts`
  — fully generic, no fixed registry of material ids/inputs), and
  regenerates `src/_engine/generatedAppFns.ts`, which imports every
  `tslFile` and builds `tslMaterialFileObjects[id] = { socket: fn }`. This
  runs automatically on `yarn dev`/`yarn build` (also via the
  `sceneGathererPlugin` Vite plugin on file save).
- At runtime, `createMaterial()` in `src/_engine/core/Material.ts` looks up
  `tslMaterialFileObjects[id]`, converts each raw JSON value under
  `nodes.<socket>` into a TSL `Node` (hex string → `uniform(color(hex))`,
  number → `uniform(number)`, boolean → `uniform(bool)`, texture id string →
  `texture(getTexture(id))`), and calls `mat[socket] = fn(inputs, mat,
  staticDefines)`. **The `.tsl.ts` function only ever receives pre-wrapped
  `Node` values — it has no access to the mesh/geometry.**
- Existing example (the pattern to imitate — currently just a stub):
  `src/toolkit/materials/checkerBoard.tsl.ts` /
  `checkerBoard.material.json` (id `checkerBoard`, `type:
  STANDARDNODEMATERIAL`, a `colorNode` that does `baseColor.mul!(gridScale).add!(panelColor)`).
  Note the `.mul!()`/`.add!()` non-null assertions in this stub are **not**
  a required incantation to imitate — see Pitfall 5 below.
- A separate, older **imperative** pattern exists in
  `src/_engine/utils/materials/checkerBoardPattern.ts` and
  `nestedGridPattern.ts` — these build a node graph inline and call
  `createMaterial()` directly from app code (not JSON-driven), with
  per-mesh UV-repeat-factor injection via geometry bounding-box math. This
  plan does **not** reuse that pattern (see Design decision below), but
  `nestedGridPattern.ts`'s grid-line math contains a **half-cell-offset
  bug** worth avoiding: it computes `mod(uv, spacing)` then compares
  distance to the *center* of that cycle (`spacing * 0.5`) instead of
  distance to the nearest edge/multiple of `spacing` — this plan's grid math
  fixes that (see below).
- Confirmed available in this repo's three.js (0.183.2) TSL exports (verified
  via `node -e "require('three/tsl')"`): `uniform`, `color`, `uv`, `mix`,
  `vec2`, `vec3`, `float`, `bool`, `step`, `smoothstep`, `oneMinus`, `abs`,
  `min`, `max`, `mod`, `floor`, `fract`, `select` (ternary/conditional node),
  `add`, `positionWorld`, `positionLocal`, `normalWorld`, `normalLocal`, and
  a built-in `triplanarTexture()` helper (`three/src/nodes/utils/TriplanarTextures.js`)
  used as reference for the blend-weight formula below.

---

## 3. Design decision: world-space triplanar, not mesh UV

A stateless `colorNode(inputs)` function has no mesh/geometry access, so
scaling the mesh's *authored UV channel* to real-world meters would need
extra imperative per-mesh wiring outside this declarative pattern (like the
older `*Pattern.ts` files use) — not a good fit here.

Unity/Unreal solve the equivalent problem (grid/checker debug materials that
look correctly scaled on any mesh, floor or wall, without custom UV
unwrapping) via **world-space triplanar projection**: derive coordinates
from world position, projected onto the plane matching each face's
orientation, blended by (abs-normalized) surface normal. This is achievable
entirely inside a stateless `colorNode` function — `positionWorld` and
`normalWorld` are per-fragment nodes the render pipeline provides
automatically, no mesh access needed. This was confirmed against three.js's
own `triplanarTexture()` helper, which uses the same technique for texture
sampling (reference: Keijiro's StandardTriplanar blend-weight formula):

```ts
let blendFactor = normalWorld.abs().normalize();
blendFactor = blendFactor.div(blendFactor.dot(vec3(1.0))); // components sum to 1
```

Each material's procedural pattern is evaluated three times — once per axis
projection (`positionWorld.yz`, `positionWorld.zx`, `positionWorld.xy`) —
and the three results are blended by `blendFactor` and summed. On an
axis-aligned face (e.g. a flat floor with normal `(0,1,0)`), the blend
factor collapses to `(0,1,0)`, so only one projection contributes — no
blending artifacts on simple boxes/planes; blending only kicks in near
edges/corners, matching standard triplanar behavior.

This makes "0.05m line thickness" / "1m spacing" **literal, correct real-world
meters** on any mesh, in contrast to the mesh-UV alternative (rejected).

---

## 4. TSL implementation

### 4a. `src/toolkit/materials/triplanarGrid.tsl.ts` (new)

```ts
import {
  positionWorld,
  normalWorld,
  vec2,
  vec3,
  float,
  mod,
  min,
  max,
  smoothstep,
  oneMinus,
  mix,
  add,
  type Node,
} from 'three/tsl';

const gridMask = (coord: Node, thickness: Node, frequency: Node) => {
  const cell = mod(coord, vec2(frequency));
  const distX = min(cell.x, frequency.sub(cell.x));
  const distY = min(cell.y, frequency.sub(cell.y));

  const halfThickness = thickness.mul(0.5);
  const aa = max(halfThickness.mul(0.2), float(0.0001)); // avoid smoothstep(x, x)
  const edgeInner = halfThickness.sub(aa);

  const maskX = oneMinus(smoothstep(edgeInner, halfThickness, distX));
  const maskY = oneMinus(smoothstep(edgeInner, halfThickness, distY));

  return max(maskX, maskY);
};

export const colorNode = (inputs: {
  lineThickness: Node;
  lineFrequency: Node;
  lineColor: Node;
  backgroundColor: Node;
}) => {
  const lineThickness = float(inputs.lineThickness);
  const lineFrequency = float(inputs.lineFrequency);
  const lineColor = inputs.lineColor;
  const backgroundColor = inputs.backgroundColor;

  let blendFactor = normalWorld.abs().normalize();
  blendFactor = blendFactor.div(blendFactor.dot(vec3(1.0)));

  const maskX = gridMask(positionWorld.yz, lineThickness, lineFrequency);
  const maskY = gridMask(positionWorld.zx, lineThickness, lineFrequency);
  const maskZ = gridMask(positionWorld.xy, lineThickness, lineFrequency);

  const colorX = mix(backgroundColor, lineColor, maskX).mul(blendFactor.x);
  const colorY = mix(backgroundColor, lineColor, maskY).mul(blendFactor.y);
  const colorZ = mix(backgroundColor, lineColor, maskZ).mul(blendFactor.z);

  return add(colorX, colorY, colorZ);
};
```

Correctness notes:
- `min(cell, frequency - cell)` gives true distance-to-nearest-edge per
  axis — this is the fix for the half-cell-offset bug seen in
  `nestedGridPattern.ts`.
- `smoothstep`'s args must stay ascending (`edge0 < edge1`); the
  decreasing-falloff look is achieved via `oneMinus(smoothstep(...))`, not
  by swapping smoothstep's arguments (which is only safe for `step`).
- `float(inputs.x)` re-concretizes each scalar input to a typed
  `Node<'float'>` immediately after destructuring, restoring full
  arithmetic-chaining type safety without needing `!` non-null assertions
  (unlike the `checkerBoard.tsl.ts` stub's `.mul!()`/`.add!()`, which are
  not required and should not be imitated — bare `Node` typed values just
  need re-wrapping in a concrete constructor, not assertions).

### 4b. `src/toolkit/materials/triplanarGrid.material.json` (new)

```json
{
  "$schema": "../../../.schemas/material.schema.json",
  "id": "triplanarGrid",
  "tslFile": "materials/triplanarGrid.tsl.ts",
  "type": "STANDARDNODEMATERIAL",
  "params": { "color": "#2b2b2b", "roughness": 0.85, "metalness": 0.0 },
  "nodes": {
    "colorNode": {
      "lineThickness": 0.05,
      "lineFrequency": 1.0,
      "lineColor": "#808080",
      "backgroundColor": "#2b2b2b"
    }
  }
}
```

### 4c. `src/toolkit/materials/triplanarCheckerboard.tsl.ts` (new)

```ts
import {
  positionWorld,
  normalWorld,
  vec3,
  float,
  bool,
  fract,
  step,
  abs,
  max,
  mix,
  select,
  add,
  type Node,
} from 'three/tsl';

const checkerColor = (
  coord: Node,
  checkerSize: Node,
  colorA: Node,
  colorB: Node,
  includePlusSigns: Node,
  plusSignColor: Node
) => {
  const scaled = coord.div(checkerSize);

  const cellX = scaled.x.floor();
  const cellY = scaled.y.floor();
  const parity = cellX.add(cellY).mod(2.0).sign();
  const baseColor = mix(colorA, colorB, parity);

  // Local coordinate within the cell, centered at (0,0), range [-0.5, 0.5).
  const localCentered = fract(scaled).sub(0.5);

  // Plus-sign proportions as fractions of one cell — hardcoded constant,
  // not exposed as an input (per product-owner decision).
  const halfArmLength = float(0.35);
  const halfBarThickness = float(0.06);

  const horizontalBar = step(abs(localCentered.y), halfBarThickness).mul(
    step(abs(localCentered.x), halfArmLength)
  );
  const verticalBar = step(abs(localCentered.x), halfBarThickness).mul(
    step(abs(localCentered.y), halfArmLength)
  );
  const plusMask = max(horizontalBar, verticalBar);
  const colorWithPlus = mix(baseColor, plusSignColor, plusMask);

  return select(includePlusSigns, colorWithPlus, baseColor);
};

export const colorNode = (inputs: {
  checkerSize: Node;
  checkerColorA: Node;
  checkerColorB: Node;
  includePlusSigns: Node;
  plusSignColor: Node;
}) => {
  const checkerSize = float(inputs.checkerSize);
  const checkerColorA = inputs.checkerColorA;
  const checkerColorB = inputs.checkerColorB;
  const includePlusSigns = bool(inputs.includePlusSigns);
  const plusSignColor = inputs.plusSignColor;

  let blendFactor = normalWorld.abs().normalize();
  blendFactor = blendFactor.div(blendFactor.dot(vec3(1.0)));

  const colorX = checkerColor(
    positionWorld.yz, checkerSize, checkerColorA, checkerColorB,
    includePlusSigns, plusSignColor
  ).mul(blendFactor.x);
  const colorY = checkerColor(
    positionWorld.zx, checkerSize, checkerColorA, checkerColorB,
    includePlusSigns, plusSignColor
  ).mul(blendFactor.y);
  const colorZ = checkerColor(
    positionWorld.xy, checkerSize, checkerColorA, checkerColorB,
    includePlusSigns, plusSignColor
  ).mul(blendFactor.z);

  return add(colorX, colorY, colorZ);
};
```

### 4d. `src/toolkit/materials/triplanarCheckerboard.material.json` (new)

```json
{
  "$schema": "../../../.schemas/material.schema.json",
  "id": "triplanarCheckerboard",
  "tslFile": "materials/triplanarCheckerboard.tsl.ts",
  "type": "STANDARDNODEMATERIAL",
  "params": { "color": "#808080", "roughness": 0.85, "metalness": 0.0 },
  "nodes": {
    "colorNode": {
      "checkerSize": 1.0,
      "checkerColorA": "#707070",
      "checkerColorB": "#404040",
      "includePlusSigns": false,
      "plusSignColor": "#a0a0a0"
    }
  }
}
```

`params.color` is a plain fallback (same convention as `checkerBoard.material.json`);
`colorNode` fully overrides diffuse color at runtime. `roughness: 0.85` /
`metalness: 0.0` keep both materials matte by default rather than
mirror-shiny.

---

## 5. Files touched

- `src/toolkit/materials/triplanarGrid.tsl.ts` — new, grid-line `colorNode`.
- `src/toolkit/materials/triplanarGrid.material.json` — new, grid material asset.
- `src/toolkit/materials/triplanarCheckerboard.tsl.ts` — new, checkerboard +
  plus-sign `colorNode`.
- `src/toolkit/materials/triplanarCheckerboard.material.json` — new, checkerboard
  material asset.
- `src/_engine/generatedAppFns.ts` — regenerated automatically by
  `yarn gatherAppData` (do not hand-edit).
- `.schemas/material.schema.json` — regenerated automatically, no manual
  change needed (the material zod schema is already fully generic).

No existing files need modification; this is purely additive.

---

## 6. Phased rollout

Small enough for two independent, non-breaking phases (each is a pure
addition — no existing material/scene is touched):

- **Phase 1 — Triplanar Grid material.** Add `triplanarGrid.tsl.ts` +
  `triplanarGrid.material.json`. Run `yarn gatherAppData` and confirm
  `tslMaterialFileObjects.triplanarGrid` appears in the regenerated
  `generatedAppFns.ts`. **Manual verification:** temporarily assign
  `"materialId": "triplanarGrid"` to a floor + a wall mesh in a dev/test scene
  (e.g. the existing `sceneTestECS` scene referenced by other toolkit
  materials' `__saveData`), run `yarn dev --isDebug=true` (or append
  `?isDebug=true`), and visually confirm: line thickness/spacing read as
  real meters on both floor and wall, the grid is continuous across a
  floor/wall corner (triplanar blend has no visible seam), and edits to
  `nodes.colorNode` values in the JSON hot-reload correctly. Revert the
  temporary scene edit afterward (or leave it if the user wants a
  reference scene).
- **Phase 2 — Triplanar Checkerboard material.** Add `triplanarCheckerboard.tsl.ts` +
  `triplanarCheckerboard.material.json`. Same verification approach: confirm
  checker cells read as real meters, `includePlusSigns: true` renders a
  centered "+" per cell in `plusSignColor`, `false` shows a plain
  checkerboard, and triplanar blending looks correct across a corner.

Both phases finish with `yarn lint` and `yarn build` (or `tsc` alone) passing
with no new errors, per the repo's "leave the tree compiling" requirement.

---

## Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Triplanar blending softens grid/checker edges near corners | Inherent to the technique (matches Unity/Unreal behavior); not a defect. |
| Plus-sign arm length/thickness hardcoded (`0.35`/`0.06` of cell) | User confirmed hardcoding is acceptable; if per-instance tuning is later needed, promote to JSON inputs (`plusSignArmLength`/`plusSignThickness`). |
| `lineFrequency`/`checkerSize` of `0` | Not defended against (`mod`/`div` by zero); acceptable given documented non-zero defaults, not exposed as a runtime-editable slider yet. |
| Single scalar tiling parameter assumes uniform scale on all 3 axes | If anisotropic (non-square) tiling is ever needed, would require a `vec3`/per-axis-scale input — explicitly out of scope for this plan. |
