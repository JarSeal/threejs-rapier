Status: draft | not-implemented
Category: Merging, Materials, Texture atlas
Epic: p370_static-mesh-merging-and-texture-atlas-systems.md (Tier 2.1)
Blocked by: p372_mesh-merge-groups.md, p299_texture-arrays-and-atlases.md, p302_material-and-texture-system-refactor.md (the `setup` entry and input resolvers)
Related: p303_texture-sets-and-terrain-texture-library.md (layer arrays: the terrain case of the same idea), p305_terrain-material-generator.md (binding budget), \_DONE_p345_gpu-memory-and-draw-call-debugger.md, \_DONE_p085_material-editor-params-and-persistence.md

# Multi-Material Merging (Merge Materials)

Lets meshes with **different materials** share one draw. A merge material stands in for a palette
of materials:

- every merged vertex carries the index of its source material (`aekMatIndex`);
- a parameter table holds each source material's scalar inputs (colour, roughness, metalness,
  emissive, UV transform);
- one texture array per map slot holds each source material's map as a layer (p299), so normal,
  ORM, AO and emissive maps each have their own array, all linked to the palette.

It only merges materials that can share one shader (a compatibility class). Everything else falls
back to one group per material (p372).

---

## 1. Grounding

- **Materials** (`core/Material.ts`): classic types (`STANDARD`, `PHONG`, …) with `params`, where
  texture map keys (`TextureMapKeys`, `utils/constants.ts:41`: `map`, `normalMap`, `aoMap`,
  `roughnessMap`, `metalnessMap`, `emissiveMap`, …) are texture ids; and TSL node materials with
  per-socket `nodes`. `createMaterial` caches by id and stores its `props` (`:478`); variants are
  `${baseId}#hash` (`getMaterialVariant`, `:525`).
- **After p302:** a multi-socket `setup` entry sets several sockets from one graph; runtime
  `registerTslMaterial(id, fns)`; an input resolver registry.
- **After p299:** build-time KTX2 arrays (`*.textureArray.json`, layers resized to one size,
  `ktx create --layers`), runtime assembly for same-sized members, `sampleArrayLayer`.
- **After p372:** groups of same-material members, `mergeGeometryParts` with a part table, `AUTO`
  buckets keyed by material ref.
- **Binding budget:** WebGPU's default is 16 sampled textures per stage, and shadow maps and the
  environment PMREM count against it (p301 §6).
- **WebGL2 backend:** array textures work; storage buffers don't.
- **Draw behaviour** (p370 §2.1): a multi-material mesh is one draw per group, so a material array
  is no draw-count win; only one material is.

## 2. Design

### D1 — Compatibility classes

A palette may only hold materials that agree on:

| Property            | Why                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shading model       | one node graph: `MeshStandardNodeMaterial`-equivalent (`STANDARD` classic or a standard node material without custom sockets)           |
| Alpha mode          | opaque, or alpha-test with one `alphaTest` threshold; never `transparent`                                                               |
| `side`              | culling is per draw                                                                                                                     |
| Vertex requirements | normal-mapped members need tangents (or the analytic/derivative frame)                                                                  |
| Feature set         | the merged shader is the **union** of features; the palette warns when one member drags a feature (emissive, clearcoat) into the others |

`PHYSICAL` features (clearcoat, sheen, transmission) are out of the first version. Custom TSL
materials don't merge automatically (open question 1).

### D2 — Palettes (`*.mergeMaterial.json`, engine asset type)

```json
{
  "id": "ruinsPalette",
  "materials": ["ruinStone", "ruinBrick", "ruinMoss", "ruinPlaster"],
  "slots": {
    "map": { "size": [1024, 1024] },
    "normalMap": { "size": [1024, 1024] },
    "orm": { "size": [1024, 1024], "from": ["aoMap", "roughnessMap", "metalnessMap"] }
  },
  "optimize": { "profile": "prop" }
}
```

- `gatherAppData` validates the class (D1) from the member material JSONs and generates one
  p299 `*.textureArray.json` job per slot: layer `i` is material `i`'s map, resized to the slot
  size. `orm` packs AO, roughness and metalness through p300's `pack` when the members have
  separate maps.
- **Missing maps** get a neutral layer (white albedo, flat normal `(0.5, 0.5, 1)`, ORM `(1, 1, 0)`
  scaled by the table's scalars), or, per slot, `"missing": "SKIP"`: a per-entry flag that skips
  the fetch (a uniform branch per triangle).
- Arrays are built at build time: KTX2 can't be resized or re-encoded in the browser. A palette
  whose member textures already share size and codec can opt into runtime assembly
  (`"assembly": "RUNTIME"`) instead, so the members' own KTX2s are reused (p299 D1).

### D3 — The merge material

- **`aekMatIndex`**: a per-vertex `Uint8` (`Uint16` past 256 materials) attribute, written by
  `mergeGeometryParts` from each part's palette index (p371 D1 gains `paletteIndex` per part).
  Flat per triangle by construction.
- **Parameter table** per palette entry: base colour (vec4), emissive (vec3) + intensity,
  roughness, metalness, normal scale, AO intensity, UV transform (offset, repeat, rotation), slot
  flags. Stored as:
  - WebGPU: a storage buffer (`storage(..., 'vec4', n)` in TSL);
  - WebGL2: a uniform array, capped at 64 entries (UBO size), or a float `DataTexture` above that.
- **TSL `setup` entry** (`core/Merge/mergeMaterial.tsl.ts`, registered with
  `registerTslMaterial('aek:merge', …)`): reads the entry by `aekMatIndex` (a flat varying),
  applies its UV transform, samples each slot's array with `sampleArrayLayer(arr, uv, layer)`, and
  sets `colorNode`, `normalNode`, `roughnessNode`, `metalnessNode`, `aoNode`, `emissiveNode`.
- One merge material per palette, shared by every group that uses it, so the pipeline compiles
  once.

### D4 — Groups use palettes

- An explicit group with `"palette": "ruinsPalette"` accepts members whose material is in the
  palette; others are refused with a dev warning (p372 §5).
- `AUTO`: the compatibility key uses the palette id instead of the material ref for materials that
  belong to a palette the scene lists (`mergeGroups` `AUTO` entry `"palettes": [...]`), so
  members with different palette materials in one cell land in one group.
- Material variants (`matOverrides`) of a palette material are separate materials: listed in the
  palette or refused.

### D5 — Measurements and the "when not" list

Measured in the profiler (draws, GPU ms, VRAM by owner) on a test scene of 4 materials × 400
meshes in 9 cells, merge material vs per-material groups vs unmerged, both backends. Recorded here
and in the handbook:

- don't palette materials with very different texture sizes (the small ones get upscaled);
- don't palette a feature only one member uses;
- don't merge across alpha modes;
- prefer per-material groups when there are only 2–3 materials per cell (the gain is small).

## 3. Phases

### Phase 0 — Prototype (1 day)

Two standard materials, hand-made 2-layer arrays, a hand-written table, one merged geometry with
`aekMatIndex`. **Exit:** same image as two separate meshes on WebGPU and WebGL2, one draw.

### Phase 1 — Palette asset and build (D1, D2)

Schema, class validation, generated array jobs, `orm` packing, neutral layers. **Exit:**
`yarn assets` builds `ruinsPalette`'s three arrays; a class violation fails the gather with the
material and property named.

### Phase 2 — Runtime material and table (D3)

**Exit:** a 4-material palette renders identically to the 4 materials (screenshot diff within
compression error), with the table on both backends.

### Phase 3 — Group integration (D4)

**Exit:** the test scene's `AUTO` groups drop from 36 (4 materials × 9 cells) to 9.

### Phase 4 — Measurements, handbook, versioning (D5)

1. D5's numbers in this file.
2. The array-material variation in `docs/techniques/terrain-modular-kits.md` (p372 Phase 5), and
   the palette section in `docs/techniques/asset-optimization.md`.
3. `CLAUDE.md` (merge materials), `readme.md` Features.
4. Engine minor; `CHANGELOG.md`.

## 4. Versioning

Engine minor (asset type, merge material, group palettes).

## 5. Risks

| Risk                                                                         | Mitigation                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The union shader is slower per pixel than the members were                   | Class validation (D1) warns per feature; D5 measures; per-material groups stay the fallback |
| WebGL2 uniform limits                                                        | 64-entry uniform array, `DataTexture` above                                                 |
| Upscaled layers waste VRAM                                                   | Per-slot `size`; budgets flag it; D5 rule                                                   |
| Mip selection differs from the source material (array layers share one size) | Same as a texture resize; mips are generated per layer at encode time                       |
| Members with different UV transforms or tiling                               | The table's UV transform per entry                                                          |
| Material editor (p085) edits a palette member, not the merge material        | Edits to a member update its table entry (a later hook; noted for p085)                     |

## 6. Open questions

1. **Custom TSL materials:** a `mergeable` contract (a material declares its per-entry parameters
   and array slots, and gets the table entry and layer as inputs) would merge them too. Wait for a
   use case.
2. Should palettes be generated automatically per scene from `merge: "AUTO"` meshes? It would need
   build-time scene analysis (and a rebuild when a scene changes); explicit palettes first.
