Status: draft | not-implemented
Category: Materials, Assets, Refactoring
Blocks: p303_texture-sets-and-terrain-texture-library.md, p305_terrain-material-generator.md
Epic: p301_terrain-texturing-epic.md

# Material & Texture System Refactor (terrain prerequisites)

Engine changes the terrain epic needs. Each is general-purpose:

1. Fill the texture JSON gaps.
2. A **multi-socket TSL `setup` entry** with shared inputs, so one graph can drive colour, normal, roughness and AO together.
3. **Runtime registration** of TSL graphs from code (toolkit modules).
4. A **material input resolver registry**, so new input kinds (texture sets, arrays) plug in without editing `Material.ts` again.
5. Material variants that can override the new inputs.
6. **Per-scene dependency closure** in `gatherAppData`, so a scene doesn't have to list every texture its materials use.
7. Two existing bugs.

Nothing here is terrain-specific, and nothing breaks existing JSON.

---

## Context (grounded, 2026-10-02)

- **TSL materials** (`core/Material.ts:325-465`):

  - Each key of `props.nodes` is a socket (`colorNode`, `normalNode`, …) and is built **independently** by its own exported function, with its own inputs (`mat.userData.uniforms[`${socket}_${input}`]`, `:450-451`).
  - Work shared between sockets (blend weights, hex-tiling coordinates, the texture fetches themselves) is therefore built once per socket. TSL only reuses a node object, not equal expressions built twice, so a terrain shader would sample everything 2–5 times.
  - Two toolkit materials already work around this:

    - `toolkit/materials/asteroid.tsl.ts:58,147` sets `material.normalNode` (and roughness) from inside another socket's function, so every input lives in one block;
    - `toolkit/materials/triplanarGrid.tsl.ts:70-84,209` makes `normalNode` read the `colorNode` block's uniforms, and so depends on the order of the JSON keys.

    `setup` (D2) replaces both workarounds. Migrating those two materials is optional (Phase 3).

- **`gatherAppData`** (`devTools/gatherAppData.ts:472-510`):
  - It emits `tslMaterialFileObjects[id] = { <socket>: fn.<socket> }` **only for the sockets listed in the JSON's `nodes`**.
  - In production, only for materials a scene references (`:452`).
  - There is no way to register a TSL graph from code: `createMaterial` looks it up in the generated `tslMaterialFileObjects` only (`Material.ts:327-333`).
- **Input wrapping** (`Material.ts:374-447`): non-`#` string → `texture(getTexture(id))`; `#hex` → colour uniform; number/boolean → uniform; 2–4 arrays and `{x,y,z,w}` / `{r,g,b,a}` objects → vector/colour uniforms; key `staticDefines` → merged defines. Anything else throws.
- **Bug A** (`Material.ts:384-392`): a missing texture logs "setting a uniform value of 1", sets `uniform(1)`, then unconditionally overwrites it with `texture(undefined)` (no `else`).
- **Bug B** (`SceneLoader.ts:313`, found by the p301 survey): resolving texture-id params writes the texture **object** back into the cached `material.params` (`params[texKey] = texture`). On a revisit the string check skips it and the old texture object, possibly disposed, is reused. The comment at `SceneLoader.ts:355-356` forbids this pattern for meshes. Verify before fixing.
- **Variants** (`getMaterialVariant`, `Material.ts:525-567`) override `params`, `staticDefines` (shallow) and `nodes` (per socket), and are cached by a stable hash. `MaterialVariantOverridesSchema` (`schemas/materialSchema.ts:22-26`) mirrors that. Mesh JSON `matOverrides` uses it.
- **Texture JSON** (`schemas/textureSchema.ts:5-15`):
  - `texOpts` has `image`, `mapping`, `wrapS`/`wrapT`, `magFilter`/`minFilter`, `type`, `anisotropy` and `colorSpace`, as raw three.js numbers.
  - Missing: `repeat`, `offset`, `rotation`, `flipY`, `generateMipmaps`, `format` (in the runtime type, `Texture.ts:21`, but not the schema) and `isPersistent` (runtime only, `Texture.ts:34`).
  - `setTextureOpts` (`Texture.ts:155-177`) applies only truthy values, so `anisotropy: 0` and `flipY: false` are ignored.
- **Scene loading** (`SceneLoader.ts:245-339`): textures listed in the scene's `textures` load in parallel with imports, then materials resolve texture ids with `getTexture`. A material's textures must be listed in the scene by hand; p084 already works around that in its editor.

---

## Design

### D1 — Texture JSON completion

- **Add to `TexOptsSchema`:**
  - `repeat` / `offset` (`[x, y]`), `rotation`, `center`;
  - `flipY`, `generateMipmaps`, `premultiplyAlpha`, `format`;
  - `anisotropy` may be `"MAX"` (resolved with `renderer.getMaxAnisotropy()`).
- **Add at top level:** `isPersistent`, and `optimize` / relative `fileName` from p300.
- **Named enums.** Accept string names next to the numbers: `"wrapS": "REPEAT"`, `"minFilter": "LINEAR_MIPMAP_LINEAR"`, `"colorSpace": "SRGB"`. They map in one table, and the existing numeric JSON still validates.
- **Fix `setTextureOpts`** to apply every defined value, not only truthy ones.

### D2 — Multi-socket `setup` entry

- A TSL material file may export:
  ```ts
  export const setup = (inputs: Record<string, Node | ResolvedInput>, material: NodeMaterial, staticDefines: Record<string, unknown>) => void;
  ```
- `setup` assigns any sockets it wants (`material.colorNode = …; material.normalNode = …; material.aoNode = …`) from **one** shared graph.
- **Inputs** come from a new top-level `inputs` object in the material JSON, wrapped with the same rules as `nodes` inputs. They are cached at `mat.userData.uniforms[`setup\_${key}`]`, so p085's material editor finds them like any other input.
- **Order:** `setup` runs first. Then any `nodes` sockets run and may override a socket `setup` set. Existing per-socket materials are unaffected.
- **`gatherAppData`:** when a JSON has `inputs` (or `"tslEntry": "setup"` for a setup without inputs), emit `setup: fn.setup` into the registry.
- **Schema:** `inputs` on the TSL branch of `MaterialAssetSchema`; `inputs` in `MaterialOverridesSchema` and `MaterialVariantOverridesSchema`.
- **Variants:** `getMaterialVariant` merges `inputs` shallowly. `staticDefines` stay shallow, and that is documented: an override of a nested define object replaces the whole object.

### D3 — Runtime TSL registration

- `registerTslMaterial(id: string, fns: { setup?: SetupFn; [socket: string]: SocketFn | undefined })` in `core/Material.ts`.
- `createMaterial` looks in the runtime registry first, then in the generated `tslMaterialFileObjects`.
- **Duplicate ids:** a duplicate id with different functions warns in dev and keeps the first, matching how texture ids behave.
- **Purpose:** toolkit modules (the terrain generator, decal material, …) register their graph once at import. Code can then call `createMaterial({ id, type: 'STANDARDNODEMATERIAL', tslFile: '<runtime>', tslMaterialId: 'aek.terrain', inputs, staticDefines })` and get variants, ownership, release and editor support like a JSON material.
- **Schema:** `tslFile` stays required for JSON materials. Code-created materials may omit it when `tslMaterialId` names a runtime registration (a type-level union).

### D4 — Material input resolver registry

- `registerMaterialInputResolver({ kind, match(value) => boolean, resolve(value, ctx) => ResolvedInput, dependencies?(value) => AssetRef[] })`.
- **Before** the built-in rules, `Material.ts` asks the resolvers in registration order.
- **`ResolvedInput`** may be a node or a plain object of nodes (a bundle). Bundles are passed to `setup` and socket functions as is, and each node inside is cached at `userData.uniforms[`${socket}_${key}\_${field}`]`.
- **`dependencies`** feeds D6, so a resolver can tell the loader which textures a value needs.
- **Built-in resolver for object-form texture refs:** `{ "texture": "id", "channel": "a" }` → a texture node (optionally swizzled). The bare-string form keeps working.
- **p303 registers two:**
  - `{ "textureSet": "sand01" }` → a set bundle;
  - `{ "textureSetArray": ["sand01", …] }` → an array bundle.

### D5 — Bug fixes

- **A:** `else` branch. A missing texture becomes `uniform(1)` as the warning says, or, better, a 1×1 white `DataTexture` shared per colour space, so the socket keeps a sampler type. Prefer the texture: a uniform where the graph expects a sampler breaks `.sample(uv)` calls.
- **B:** resolve into a copy of `params`; never write texture objects into cached props. Add a revisit test to `testECS` or `debugScene`: enter → leave → enter, no "destroyed texture" or disposed-texture warnings.

### D6 — Per-scene dependency closure

- **In `gatherAppData`:** for each scene, compute the textures (and, after p303, texture sets) that its materials need, from:
  - `params` texture keys (`textureMapKeys`);
  - `nodes` / `inputs` strings that are texture ids;
  - `matOverrides` in mesh JSONs;
  - resolver `dependencies` (via a small `devTools` mirror of each resolver's dependency function, since `gatherAppData` can't run browser code).
- **Output:** a `__dependencies: { textures: string[] }` per scene. `SceneLoader.loadNextSceneAssets` loads the union of `textures` and `__dependencies.textures`.
- An explicit `textures` list stays valid; the closure only adds to it.
- **Code-created materials** (D3) declare their dependencies at runtime: `await ensureMaterialDependencies(props)` loads missing textures before `createMaterial`. The toolkit terrain generator calls it.

---

## Phases

### Phase 1 — Texture JSON (D1)

1. Schema additions + named enums; `setTextureOpts` fix.
2. Recompile `.schemas/texture.schema.json`; check that every existing `*.texture.json` still validates.

**Exit:** `testTexture.texture.json` with `"repeat": [4, 4]`, `"anisotropy": "MAX"` and `"flipY": false` renders as expected on WebGPU and the WebGL2 fallback.

### Phase 2 — Bugs (D5)

1. Fix A and B.
2. Add the revisit check.

**Exit:** scene revisit and missing-texture cases are clean in the console.

### Phase 3 — `setup` entry + runtime registration (D2, D3)

1. `Material.ts` setup path, `registerTslMaterial`.
2. Schema `inputs`, `gatherAppData` emission, variant merge of `inputs`.
3. Convert `src/app/materials/testTslMat` to a `setup` material as the reference example (keep a per-socket example too: `toolkit/materials/triplanarCheckerboard`).

**Exit:**

- A `setup` material sets 3 sockets from one graph.
- The generated WGSL samples each texture once. Check it in the browser devtools shader source, or with `renderer.debug.getShaderAsync` if available in r186.
- `getMaterialVariant` overriding an input works.

### Phase 4 — Input resolvers (D4)

1. Registry, built-in object-form texture ref, bundle caching in `userData.uniforms`.
2. Unit-free check: a dummy resolver in `debugScene` returning a bundle of two uniforms.

**Exit:** a material JSON using `{ "texture": "testTexture", "channel": "r" }` works.

### Phase 5 — Dependency closure (D6)

1. Closure computation and `__dependencies`; SceneLoader union.
2. `ensureMaterialDependencies`.
3. Remove now-redundant explicit `textures` entries from one app scene to prove it, keeping the others.

**Exit:** a scene that lists only a material loads that material's textures.

### Phase 6 — Docs and versioning

1. Update `CLAUDE.md`'s data pipeline section (setup entry, inputs, resolvers, dependency closure) and `readme.md` if its material example changes.
2. Engine minor bump; `CHANGELOG.md` entry (Added: setup entry, runtime TSL registration, input resolvers, texture opts; Fixed: A, B).

---

## Risks

| Risk                                                                          | Mitigation                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup` and per-socket functions both set the same socket                     | Documented order (setup first, sockets override), plus a dev warning when a socket is overwritten                                                                                                                                                                                |
| Variants differing only by textures compile separate pipelines                | Three caches programs by node graph structure; verify in Phase 3 that two variants with different texture ids share one pipeline (count pipelines via `renderer.info` / WebGPU devtools). If not, note it in p305 (a per-block splat map would then cost one pipeline per block) |
| The resolver dependency mirror in `devTools` drifts from the runtime resolver | Each resolver ships its dependency function in a side-effect-free module that both the gatherer and the runtime import                                                                                                                                                           |
| p085's material editor assumes `${socket}_${input}` keys                      | `setup_${key}` follows the same pattern; tell p085 about it (add a note to p085 when this lands)                                                                                                                                                                                 |
