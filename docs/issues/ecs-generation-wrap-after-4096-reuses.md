**Title:** An ECS entity slot reused 4096 times gives entities that are never alive and can't be deleted

Status: fixed | 2026-10-09, p601 Phase 1
Category: Bug, ECS
Found: 2026-10-09, writing the ECS unit tests (p601 Phase 1, `src/_engine/core/ECS.test.ts`)

## What happens

`ECSWorld` packs an entity id as a 20-bit index and a 12-bit generation (`_pack` in
`src/_engine/core/ECS.ts`), and `deleteEntity` bumps the slot's generation in `generations`, a
`Uint32Array`. `_pack` masks the generation to 12 bits, but `generations[index]` isn't masked,
and `isAlive` compares the two:

```ts
return this.generations[index] === gen && this.entities.has(entityId);
```

After a slot's 4096th delete, `generations[index]` is 4096 while every id packed from it carries
generation 0. So the next entity created in that slot:

- has the id the slot's very first entity had (`(0 << 20) | index`): the ghost-id protection is gone;
- is never `isAlive`, so every system and hook that checks that skips it;
- can't be deleted (`deleteEntity` returns early for a dead id), so it stays in `entities` and
  its components stay in their storages for good, and the slot is never freed again.

The free list is a stack (`freeIds.pop()`), so a game that spawns and deletes one entity at a
time (projectiles, particles, pickups) reuses the same slot every time and gets there after 4096
spawns.

## Reproduce

```ts
const world = new ECSWorld({ id: 'repro', maxEntities: 10 });
for (let i = 0; i < 4096; i++) world.deleteEntity(world.createRawEntity());
const entityId = world.createRawEntity(); // 1, the first entity's id
world.isAlive(entityId); // false
world.deleteEntity(entityId); // no-op
world.getEntityCount(); // 1
```

## Fix

`deleteEntity` wraps the stored generation at the packed id's 12 bits
(`(generations[index] + 1) & GEN_MASK`), the mask `_pack` uses too. Entities stay alive and
deletable; an id repeats after 4096 reuses of its slot, the packing's stated limit (retiring
the slot instead would have cost it for good). `ECS.test.ts` covers it, the repeat included.
