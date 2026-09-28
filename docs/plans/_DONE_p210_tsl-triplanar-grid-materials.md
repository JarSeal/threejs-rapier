Status: implemented
Category: Texture

# TSL Triplanar Grid Materials — Plan

Two procedural TSL materials for `src/toolkit/materials/` — a grid-line material and a
checkerboard (with optional plus-sign) material — following the declarative `<name>.tsl.ts` +
`<name>.material.json` pattern. Both use **triplanar projection** (not the mesh's UV channel) so
line thickness / checker size read as real-world meters on any mesh without UV unwrapping.

Phase 1 grew well past the original draft during review (object alignment, bounds fitting, minor
lines, seam normals, per-mesh material variants); this document describes what is built.

---

## 1. Goal

- **Triplanar Grid** (implemented) — grid lines over a background color, usable on floors, walls
  and props for greyboxing / level layout reference.
- **Triplanar Checkerboard** (implemented) — two checker colors and an optional solid-color "+"
  mark centered in each cell.

All defaults are retunable via the material JSON; per-mesh differences go through mesh
`matOverrides` (§4), not extra material files.

---

## 2. Engine building blocks (implemented)

- **TSL input typing:** `import { type Node } from 'three/tsl'` resolves to the loose local shim in
  `src/_engine/types/three-node-material-helpers.d.ts` (`@types/three` 0.186 exports no `Node`
  from `three/tsl`). New TSL files import the real generic `Node<T>` from `three/webgpu` instead
  and type inputs as what `createMaterial` passes: number → `Node<'float'>`, boolean →
  `Node<'bool'>`, hex string → `Node<'color'>`. No `!` assertions or `float(...)` re-wrapping.
  (Cleaning up the shim itself is a separate task.)
- **`staticDefines` reach the socket functions:** `createMaterial` used to drop material-level
  `staticDefines` unless a socket's own `nodes` block had a `staticDefines` key; it now passes
  them (3rd argument of every socket function). They are build-time switches: a TSL function can
  branch on them in JS so only the used paths end up in the shader.
- **A socket function may return `null`** to leave the material's default for that socket
  (eg. `normalNode` when seam normals are off).
- **Material variants** (`getMaterialVariant(baseId, overrides)` in `core/Material.ts`): a
  separate material created from the base material's creation props (which `createMaterial` now
  stores in the registry, already merged with the scene's `__saveData`) with `params` /
  `staticDefines` merged shallowly and `nodes` per socket. Cached under `baseId#<hash>` (key is
  order-independent, hash collisions resolved), ref counted and disposed like any other
  non-persistent material, TSL functions looked up via the base id (`MatProps.tslMaterialId`).
- **Mesh `matOverrides`** (`MeshProps` + mesh schema, also in mesh `__saveData`): same shape as a
  material JSON (`params` / `staticDefines` / `nodes`); `createMeshEntity` swaps in the variant.
  Zero per-frame cost: per-object uniforms (`onObjectUpdate`) were tried first and rejected for
  their per-mesh-per-frame CPU cost. Trade-offs: one material per unique override set, one shader
  per unique `staticDefines` combination, and changing a mesh's overrides at runtime means
  swapping its material (no helper yet). Override values must be plain data (they're the cache key).

---

## 3. Triplanar Grid (implemented)

`src/toolkit/materials/triplanarGrid.tsl.ts` + `triplanarGrid.material.json`.

**`staticDefines`** (build time, defaults in the TSL file):

| Define | Default | Effect |
| --- | --- | --- |
| `alignToObject` | `true` | Project in object space × world scale (lines follow the mesh's rotation, units stay meters); `false` = world space (continuous across separate meshes). |
| `fitToBounds` | `false` | `alignToObject` only: anchor at the geometry's bounding-box corner and stretch the spacing per axis so a whole number of cells spans the object (lines on every edge, cells may be slightly non-square). The only per-object cost in the material: two bounds uniforms, and only in these variants. |
| `minorLines` | `true` | Thinner lines between the major lines. |
| `seamNormals` | `true` | Grooves along the lines (`normalNode`); off = no normal code at all. |

**Inputs** (uniforms, runtime-editable): `colorNode` — `lineThickness` (m), `lineFrequency` (m),
`lineColor`, `backgroundColor`, `minorLineDivisions`, `minorLineColor`; `normalNode` —
`seamNormalStrength`, `minorSeamNormalStrength`. `normalNode` reads the pattern inputs from the
colorNode uniforms (`material.userData.uniforms.colorNode_*`), so the `colorNode` block must come
first in the JSON.

**Math notes** worth keeping for phase 2:
- Line distance is to the nearest multiple of the spacing (`min(cell, spacing - cell)`), not to
  the cell center — the half-cell-offset bug in `utils/materials/nestedGridPattern.ts`.
- TSL `mod` compiles to a floored `tsl_mod_*` in WGSL, so negative coordinates are safe.
- Blend weights use the geometry normal (`normalWorldGeometry` / `normalLocal`), never
  `normalWorld`: outside the normal sub-build that is the *perturbed* normal.
- Minor lines are half the major thickness, widened (up to the major thickness) once their
  half-width drops below ~0.75 px (`fwidth`), so they don't break up at a distance.
- Seam normals: analytic derivative of a rounded groove profile
  (`height = -halfThickness * (1 - smoothstep(0, halfThickness, dist))`, slope peaks at 1.5 ×
  strength for any thickness), lifted to 3D per projection, blended, moved to view space
  (object-space gradients divided by `modelScale` then through `modelViewMatrix`) and applied as a
  surface-gradient perturbation of `normalView`. No screen-space derivatives.

**Known limits:** object alignment anchors at the pivot (lines only land on edges when the
half-size is a multiple of the spacing — use `fitToBounds`); `InstancedMesh`/`BatchedMesh`
instances share one variant and the base geometry's bounds; triplanar blending shows faint
neighbouring projections around 45° on curved surfaces; major-line anti-aliasing is world-space
(20% of the half-thickness), so very distant major lines can alias.

**Used by:** the Gym scene's static physics meshes (`scene_thirdPersonGym.ts`: ground, stairs
and box-wall obstacles, slide, imported stairs/terrains/obstacles).

---

## 4. Triplanar Checkerboard (implemented)

`src/toolkit/materials/triplanarCheckerboard.tsl.ts` + `triplanarCheckerboard.material.json`.
Color only (`colorNode`).

- **Shared with the grid:** `src/toolkit/materials/triplanarProjection.ts` —
  `triplanarProjection` (object/world alignment, `fitToBounds` with the per-object bounds
  uniforms, geometry-normal blend weights), `blendProjections` (evaluate a pattern per projection
  and blend) and `readBooleanDefines`. New triplanar materials should build on it.
- **`staticDefines`:** `alignToObject` (`true`), `fitToBounds` (`false`), `plusSigns` (`false`).
- **Inputs:** `colorNode` — `checkerSize` (m), `checkerColorA`, `checkerColorB`, `plusSignColor`
  (only needed with `plusSigns`).
- **Checker:** box-filtered analytic checker (Inigo Quilez's "filtered checker": the square
  wave's integral over the `fwidth` pixel footprint), so it fades to the average of the two colors
  in the distance instead of aliasing/moiré. No `mod`/parity math (the draft's `.sign()` parity
  would have overshot on a -0 cell index).
- **Plus signs:** hardcoded proportions (half arm 0.35, half bar 0.06 of a cell), pixel-width
  anti-aliased edges, and faded out while a pixel grows from 5% to 15% of a cell (too thin to
  draw without shimmering). With `fitToBounds` the cells can be slightly non-square, and the plus
  stretches with them.
- **Possible extension:** seam normals along the checker edges (reusing the grid's groove math) —
  not requested yet.

---

## 5. Verification

No test suite; verify visually. Headless WebGPU can't render on WSL2 —
`DRIVER_WEBGL=1 node .claude/skills/run-aekasha-js/driver.mjs ...` renders through the WebGL2
fallback (same TSL graphs, GLSL instead of WGSL), so a final check in a real WebGPU browser is
still needed.
