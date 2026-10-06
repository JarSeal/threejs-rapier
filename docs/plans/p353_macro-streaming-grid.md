Status: draft | not-implemented
Category: World, Streaming, Assets
Epic: p350_lod-system-research.md (Tier 2.1)
Related: p372_mesh-merge-groups.md (merge groups stay inside a cell), p376_hlod-merged-cluster-proxies.md (FAR proxies), \_DONE_p346_spatial-domains.md (the cell maths, and the `MANUAL` domain for this plan's Phase 4), \_DONE_p352_physics-simulation-tiers.md (Phase 4 here drives its tiers per cell; it took over p352's Phase 5), \_DONE_p343_deterministic-physics-tier-policy.md (deciding on fixed steps, §6), \_DONE_p348_ecs-lod-selection.md and p351_impostor-billboard-lod.md (what a `FAR` cell shows), p306_terrain-blocks-and-procedural-terrain-meshes.md (blocks are natural cell content; their sizes line up), \_DONE_p345_gpu-memory-and-draw-call-debugger.md (per-cell memory), p420_npc-simulation-tiers.md (NPCs need the cells around the player loaded)

# Macro Streaming Grid

Lets one scene be larger than what fits in memory at once. The world is cut into large square
cells. Each cell's content is loaded, shown at reduced detail, or unloaded depending on its
distance to a focus point (usually the player), through a per-cell state machine with asymmetric
thresholds. Asset ownership, priming and release work per cell, as they already do per scene.

This is **not** a second member grid (p350 §3.1): an unloaded cell has no entities to index. It
uses p346's shared cell maths, a build-time cell manifest, and one spatial domain for "which live
entities does this cell own".

---

## 1. Grounding

- **Scene loading** (`core/SceneLoader.ts:495-620`): a scene load holds physics stepping, deletes
  the previous scene's characters, physics and group entities, `clearNonPersistent()`s the ECS
  world, resets the physics world (p101), loads the next scene's assets
  (`loadNextSceneAssets`), runs its init, creates its Object3Ds, releases the previous scene's
  assets, waits for every pending physics create, and releases stepping. Everything is per scene;
  nothing can be added or removed in parts.
- **Asset ownership** (`core/Assets/AssetOwners.ts`): a `WeakMap` from asset to **one** owner
  scene id; cache hits re-tag the asset to the scene getting it. `releaseSceneOwnedAssets`
  (`SceneAssetRelease.ts`) frees what an exited scene still owns and nothing uses (ref count 0, no
  material or sky box using it).
- **Priming:** `renderer.initTexture(texture)` uploads synchronously (r186); `compileAsync`
  compiles pipelines and is used for mesh `preWarm` (p350 §4).
- **Asset worker** (`core/Assets/AssetsAPI.ts`): textures and GLTFs load off the main thread when
  `assets.workerTarget` is `WORKER_THREAD`.
- **p306:** terrain blocks are self-contained square units, 32–256 m, power of two.
- **Determinism (p101):** guaranteed for scene loads, in both worker targets.
- **Physics tiers** (`_DONE_p352`, `core/PhysicsTiers.ts`, `core/PhysicsTierPolicy.ts`): a
  `DYNAMIC` `createPhysicsEntity` body can be `FULL`, `STATIC`, `DISABLED` or `REMOVED`
  (detached, ids and state kept engine side, slot freed). `requestPhysicsTier` applies at the
  next `APP_PHYSICS_STEP` sub-step and returns `false` when it refuses.
  The distance policy (`setPhysicsTierPolicy`, `cadence: 'STEPS'` by default, `_DONE_p343`) only
  calls it. What constrains this plan's Phase 4 is in §6.

## 2. Cells and rings

- A scene opts in with `streaming: { cellSize, rings }` in its `*.scene.json` (or in code before
  load). `cellSize` must be a power of two ≥ 32 m, so p306 blocks tile cells exactly. Cells are 2D
  (x/z); `y` is ignored for cell membership.
- Cell keys are p346's `packCellKey(cx, 0, cz)`, so a cell key means the same in the streaming
  layer, the debug overlays and any spatial domain with the same cell size.

| State      | Default ring (Chebyshev distance in cells) | Content                                        | Physics (p352)                             |
| ---------- | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------ |
| `RESIDENT` | 0–1                                        | everything, all LOD levels                     | bodies by their own policy, usually `FULL` |
| `NEARBY`   | 2                                          | everything; LOD selection decides what's drawn | `STATIC` / `DISABLED`                      |
| `FAR`      | 3–5                                        | the cell's far representation only (§4.3)      | none (`REMOVED` or not created)            |
| `UNLOADED` | beyond                                     | nothing; the manifest entry is known           | none                                       |

- **Asymmetric thresholds.** A cell is promoted when the focus comes within its ring distance, and
  demoted only beyond the ring distance plus `margin` metres (default `cellSize / 4`), measured from
  the focus to the cell's edge, not its centre. Standing on a boundary never thrashes.
- `NEARBY` exists so that a cell's content is loaded and primed (§5) a ring before it can be seen
  up close.

## 3. Content

### 3.1 What a cell holds

Anything in the scene JSON with a position (meshes, imported assets, terrain blocks, scatter,
lights, physics objects once they're in the schema) is assigned to the cell containing its
position, at **build time** (§3.2). Exceptions:

- `streaming: 'ALWAYS'` on an entry keeps it in the scene's base (loaded with the scene, never
  unloaded). Cameras, the sky box, directional lights and anything persistent are base content
  automatically.
- **Oversized content** (bounding radius > `cellSize / 2`, eg. a long bridge, a large building) is
  assigned to every cell its bounds overlap and loaded while _any_ of them is at least `NEARBY`,
  ref-counted across them. This answers p350's worry about oversized members being "silently pinned
  `RESIDENT` forever".

Mesh merge groups (p372) never cross a cell: `AUTO` group cell sizes divide `cellSize`, and an
explicit group whose members span cells is warned about, so a cell unloads its groups whole. A
cell's groups are what p376's HLOD proxies simplify for the `FAR` state (§3.3).

Code-defined content registers per cell: `registerStreamingCellContent(sceneId, cellKey, { load,
unload })`, where `load` returns the created entity ids. That's Phase 1's whole content model,
before the JSON path exists.

### 3.2 Build-time manifest

`gatherAppData` writes, per streaming scene, a `__streaming` block into `generatedAppData.json`:
`{ cellSize, base: [assetIds], cells: { [cellKey]: { assets: [ids], bounds, bytesEstimate } } }`.
Loading a cell's set is a lookup, not a runtime spatial query. `bytesEstimate` sums p300's
`__vramBytes` where present, so the debug tab can show the cost of a cell before loading it.

### 3.3 Far representations

A `FAR` cell shows only its cheap stand-ins: p348's coarsest levels with no physics, p351's
impostors or cross-quads, a terrain block's lowest chain level. Which entries have a far
representation is part of the manifest (an entry with `lod` has one; others are simply not shown
in `FAR`). Phase 5; until then `FAR` = `UNLOADED`.

## 4. Runtime

### 4.1 The state machine

Per cell: `UNLOADED → LOADING → LOADED(state) → UNLOADING → UNLOADED`, where `LOADED` carries
`RESIDENT` / `NEARBY` / `FAR`, and moving between those three is a content-level change (§3.3),
not a reload.

- `streamingSystem` at `MAIN`, every N frames (default 10): computes the focus cell, the wanted
  state of every cell in range, and queues transitions, nearest first.
- **Budgets:** at most `maxConcurrentLoads` cells loading (default 2), and entity creation for a
  loaded cell spread over frames under `maxCreateMsPerFrame` (default 2 ms), so a cell never lands
  in one frame.
- **Cancellation:** a `LOADING` cell that's no longer wanted finishes its asset requests (they
  may be shared), skips entity creation, and goes straight to `UNLOADING`. Each transition carries a
  generation counter, so a late result from a cancelled load is ignored.
- Nothing streams while a scene loads (`isLoadingScene`). A scene load creates the cells around the
  focus's initial position **as part of the load**, inside p101's physics hold, so a scene enter
  stays deterministic. Only cells crossed during play stream at runtime.

### 4.2 Ownership

`AssetOwners` changes from one owner per asset to a small owner set (or ref count per owner key):

- Owner keys are `sceneId` for base content and `sceneId#cellKey` for cell content. p345's tab
  groups by the part before `#`.
- `releaseCellOwnedAssets(sceneId, cellKey)` mirrors `releaseSceneOwnedAssets`: it drops the
  cell's ownership, and frees an asset only when no owner is left and nothing uses it. An asset
  shared by two cells stays while either holds it.
- Scene exit releases the scene key and every one of its cell keys, as today.

### 4.3 Entities that move

A dynamic body spawned by cell A can roll into cell B. Cell-owned entities join a `MANUAL` p346
domain, `STREAMING`, with the streaming `cellSize`. On unload, the cell queries the domain for the
entities currently inside it (by position, not by who spawned them):

- an entity spawned by this cell and still inside it is deleted with the cell;
- an entity spawned by this cell but now inside a loaded cell is re-owned by that cell;
- an entity spawned by another cell but now inside this one is deleted only if its own cell is
  also unloading (otherwise it stays with its owner).

The domain is rebuilt only when a cell is about to unload (`MANUAL`), so this costs nothing per
frame.

## 5. Priming

A cell's textures and pipelines are primed while it's `NEARBY`, before it's close enough to see in
detail:

- `initTexture` per new texture and `compileAsync` per new material, spread over frames by
  `maxPrimeMsPerFrame` (default 2 ms), measured, not assumed (Phase 0).
- A cell is promoted to `RESIDENT` only once primed. If the focus outruns priming (a fast vehicle),
  the cell is promoted anyway and the stall is counted in the debug tab, which is the signal to
  widen the rings.

## 6. Physics

- Cell physics content is created through `createPhysicsEntity` at runtime, which in
  `WORKER_THREAD` mode is async: the first step a body takes part in depends on frame timing.
  **Runtime content creation is therefore not deterministic**, only scene loads are (§4.1). The
  determinism probe freezes the focus, so streaming adds nothing during a probe run. This is a
  documented limit, not a bug.
- **Tier changes can be deterministic, though.** `_DONE_p343` made the tier policy decide on
  fixed steps (`STEPS`: measure the focus on steps that are multiples of `interval`, decide
  `interval` steps later, hold stepping with `addPhysicsStepGate` while a `WORKER_THREAD` read
  is out). Cell states decided the same way make the tier side as deterministic as the focus,
  so a stretch of play that loads or unloads no content plays out the same. Deciding them in
  `streamingSystem` (`MAIN`, every N frames) lands the requests on frame-timing-dependent steps,
  like a `FRAMES` policy. Phase 4 decides; the step path is preferred if it doesn't complicate
  the content side (content loads can stay per frame, only the tier decision moves).

### 6.1 Per-cell tiers (Phase 4; formerly p352 Phase 5)

| Cell state | Dynamic bodies it owns                                                   |
| ---------- | ------------------------------------------------------------------------ |
| `RESIDENT` | their own tier policy if they're members, else `FULL`                    |
| `NEARBY`   | `STATIC` (default) or `DISABLED`, a scene setting                        |
| `FAR`      | `REMOVED` (the entity and its visual stay; Phase 5 decides what's shown) |
| `UNLOADED` | deleted with the cell; until Phase 5, `FAR` is `UNLOADED`                |

- `STATIC` still collides, but Rapier zeroes a body's velocities when it becomes `FIXED`, so it
  resumes from rest. `DISABLED` keeps pose and velocities exactly, but nothing collides with it
  or wakes it. `NEARBY` defaults to `STATIC` because something can reach it: an NPC whose cell is
  pinned (p420), a thrown object.

Constraints from p352 as built (each needs an answer in Phase 4):

1. **The cell wins over the policy.** The policy pass requests tiers for its members on its own,
   so a member in a non-`RESIDENT` cell must be skipped. Either the cell takes the entity out of
   the policy (`setPhysicsTierPolicyMember(id, false)`; removing a member leaves its tier as it
   is) and puts it back on `RESIDENT` (the policy places it from its current `target`, no new
   API), or the policy pass gains a skip check. The first is preferred.
2. **`FIXED` bodies have no tier** (`requestPhysicsTier` refuses anything not created `DYNAMIC`
   by `createPhysicsEntity`). Level colliders stay as they are while their cell's content is
   loaded (no slot, no per-frame sync, only broad-phase cost) and are deleted with it.
3. **Jointed bodies can't be `REMOVED`** (any joint, also one to a fixed anchor: refused at the
   request and again when it applies). A cell going `FAR` puts them in `DISABLED` or deletes
   them. A joint group changes tier as one, so a group across two cells in different states
   gets one owner: the cell of its member nearest the focus, as the policy's groups do.
4. **A create has no initial tier.** `createPhysicsEntity` makes the body as its params say
   (`FULL`), and `requestPhysicsTier` refuses a body that doesn't exist yet. A body created into
   a `NEARBY` cell would simulate `FULL` until its request lands (frames later in
   `WORKER_THREAD` mode). Phase 4 adds a create-time tier (eg. `PhysicsEntityOpts.initialTier`,
   applied in the create's own message, before its first step): an engine change in this plan.
5. **Capacity:** in `WORKER_THREAD` mode a `REMOVED → FULL` return takes a slot, and a full
   buffer (`maxBodies`) refuses it: the entity stays `REMOVED` and a `PhysicsCapacityError` is
   logged. A cell promoting many bodies at once can hit this; the Streaming tab counts it.
6. **A `REMOVED` body's state lives engine side** (keyed by body id) and is freed when its entity
   is deleted. It survives `FAR` (the entity stays), not `UNLOADED` (§8).
7. **Positions:** a `REMOVED` entity's `TRANSFORM` keeps the pose it was removed at; the
   `STREAMING` domain (§4.3) reads that, as the policy does.
8. **Deleting a body in flight is safe** (p352 Phase 3 checks delete while `REMOVED` and while a
   return waits for its reply), so a cell may unload without waiting for its transitions.

### 6.2 Other physics notes

- A body that has fallen asleep in a `NEARBY` cell is the common case and costs little; tiers are
  for the bodies that don't sleep and for slot pressure (`maxBodies`).
- Static level colliders are part of the cell and are deleted with it. A `FULL` body resting on a
  cell that unloads under it is the 'falls through the world' bug: a cell can't unload while it
  holds the focus's ring, and characters' and NPCs' cells are pinned (p420).

## 7. Debug

A "Streaming" tab: focus cell, per-state cell counts, queue, loads in flight, last load time per
cell, priming stalls, per-cell memory (p345 owners). A top-down overlay of cell outlines coloured
by state, drawn with the line system at ground level. "Freeze focus" and "teleport focus to cell"
for testing, and `?streamingFocus=x,z` to start from a cell.

## 8. Not in this plan

- **Origin rebasing.** Rapier and the transform buffer use 32-bit floats, so positions jitter a few
  km from the origin. A world larger than ~4 km across needs a floating origin, which touches
  physics, cameras, the sky and every system holding world positions. Its own plan.
- **Server-side or procedural world generation**: cells come from authored scenes or code.
- **Saving cell state** (a moved crate stays moved after its cell reloads). p352's `REMOVED`
  keeps a body's state only while its entity exists, so it covers a cell in `FAR`, not one that
  unloads (its entities are deleted, and their state with them). Keeping it across an unload
  needs the cell to record its bodies' poses before deleting them; persistence beyond a session
  is p500 territory.

## 9. Phases

### Phase 0 — Measure (half a day)

`initTexture` and `compileAsync` cost per texture size and material type on WebGPU and the WebGL2
fallback, in `largeWorld`. Record the numbers here; they set §5's defaults.

### Phase 1 — Cells and the state machine (code content)

1. Scene `streaming` settings, rings, asymmetric thresholds, `streamingSystem`, budgets,
   cancellation (§2, §4.1).
2. `registerStreamingCellContent` (§3.1).
3. Debug tab and overlay (§7).

**Exit:** a test scene with a 16 × 16 grid of code-registered cells (procedural terrain blocks
with scattered props) streams while flying across it, with no frame over 33 ms caused by
streaming and no thrashing when hovering on a boundary.

### Phase 2 — Ownership and release

`AssetOwners` owner sets, `releaseCellOwnedAssets` (§4.2), priming (§5).

**Exit:** p345's snapshot after flying out and back is within noise of the snapshot before.

### Phase 3 — Build-time manifest

Scene JSON assignment, oversized content, `__streaming` in generated data (§3.1–3.2).

### Phase 4 — Moving entities and physics

The `STREAMING` domain and re-owning (§4.3), per-cell tiers with p352 (§6.1, which took over
p352's Phase 5): the cell-over-policy rule, joint group owners, the create-time tier, and the step
or frame decision (§6).

Needs only Phase 1 (cells and code-registered content); Phases 2-3 aren't prerequisites, so this
phase can run right after Phase 1 if the physics side is wanted first.

**Exit:** on a streaming version of `physicsTiers` (crate piles as code-registered cell content),
crates take their cell's tier and a policy member follows the policy only while its cell is
`RESIDENT`; a crate created into a `NEARBY` cell never simulates a step `FULL`; a crate that rolls
into a neighbouring cell is re-owned and unloads with it; no capacity refusal at default
`maxBodies`; the Physics API tab's tier counts match the cells' states, in all three targets.

### Phase 5 — Far representations

`FAR` content (§3.3) with p348 and p351.

## 10. Versioning

Engine minor per phase that adds API (Phases 1–4); the `AssetOwners` change in Phase 2 is internal.
App minor for a streaming demo scene. `readme.md`: a Features entry when Phase 3 lands.

## 11. Open questions

1. Should the focus support several points (split screen, a remote-controlled drone)? The state
   machine takes the union of rings; designing for one focus first.
2. Do lights belong to cells? Point and spot lights, yes (they have positions and are already
   spatially culled). The sky's lights and directional lights are base content.
3. Should cells be 3D for vertical worlds (caves under terrain)? 2D first; the key format already
   carries `y`.
