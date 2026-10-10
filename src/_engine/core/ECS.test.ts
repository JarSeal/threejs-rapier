import { afterEach, describe, expect, test, vi } from 'vitest';

// core/Config.ts reads `window.location.search` at load (a p606 finding: the core isn't headless
// yet). Only that is stubbed, so a new browser global at load fails here instead of hiding.
vi.hoisted(() => vi.stubGlobal('window', { location: { search: '' } }));

import { ECSWorld, type ECSWorldOptions } from './ECS';
import { ComponentType, Transform } from './ECS/ECSCoreComponents';
import { ECSSystemStage } from './ECS/SystemStages';

const INDEX_BITS = 20;

// Every world here gets its own id, deleted after the test: the world registry and the component
// hooks are static, shared by every world in this file.
let worldSeq = 0;
const createdWorldIds: string[] = [];
const createWorld = (opts: ECSWorldOptions = {}) => {
  const id = `test-${worldSeq++}`;
  createdWorldIds.push(id);
  return new ECSWorld({ id, maxEntities: 1000, applyGlobalPlugins: false, ...opts });
};

afterEach(() => {
  for (const id of createdWorldIds.splice(0)) ECSWorld.deleteWorld(id);
  vi.restoreAllMocks();
});

/** Hooks are global per component type, so a test's hook only records its own world's calls */
const recordHooks = (world: ECSWorld, type: ComponentType) => {
  const calls: string[] = [];
  ECSWorld.registerComponentHooks(type, {
    onAddComponent: (entityId, w) => {
      if (w === world) calls.push(`add:${entityId}:${String(w.getComponent(entityId, type))}`);
    },
    onRemoveComponent: (entityId, w) => {
      if (w === world) calls.push(`remove:${entityId}:${String(w.getComponent(entityId, type))}`);
    },
    onDeleteEntity: (entityId, w) => {
      if (w === world) calls.push(`delete:${entityId}:${String(w.getComponent(entityId, type))}`);
    },
  });
  return calls;
};

describe('world registry', () => {
  test('a second world with the same id throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = createWorld();
    expect(() => new ECSWorld({ id: world.id })).toThrow(/already exists/);
  });

  test('deleteWorld runs onDeleteEntity hooks and unregisters the world', () => {
    const world = createWorld();
    const calls = recordHooks(world, ComponentType.LIFETIME);
    const entityId = world.createRawEntity();
    world.addComponent(entityId, ComponentType.LIFETIME, 5 as never);
    const id = world.id;
    createdWorldIds.splice(createdWorldIds.indexOf(id), 1);

    expect(ECSWorld.deleteWorld(id)).toBe(true);
    expect(calls).toContain(`delete:${entityId}:5`);
    expect(ECSWorld.getWorld(id)).toBeUndefined();
    expect(ECSWorld.deleteWorld(id)).toBe(false);
  });
});

describe('entity ids and generations', () => {
  test('ids start at index 1, generation 0', () => {
    const world = createWorld();
    expect(world.createRawEntity()).toBe(1);
    expect(world.createRawEntity()).toBe(2);
    expect(world.getEntityCount()).toBe(2);
  });

  test('a deleted slot is reused with the next generation, and the old id is dead', () => {
    const world = createWorld();
    const first = world.createRawEntity();
    world.deleteEntity(first);
    expect(world.isAlive(first)).toBe(false);

    const second = world.createRawEntity();
    expect(world.getEntityIndex(second)).toBe(world.getEntityIndex(first));
    expect(second).toBe((1 << INDEX_BITS) | 1);
    expect(world.isAlive(second)).toBe(true);
    expect(world.isAlive(first)).toBe(false);
  });

  test('deleting a stale id does not touch the slot’s new entity', () => {
    const world = createWorld();
    const stale = world.createRawEntity();
    world.deleteEntity(stale);
    const current = world.createRawEntity();
    world.addComponent(current, ComponentType.PERSISTENT, true);

    world.deleteEntity(stale);
    expect(world.isAlive(current)).toBe(true);
    expect(world.hasComponent(current, ComponentType.PERSISTENT)).toBe(true);
    expect(world.getEntityCount()).toBe(1);
  });

  test('maxEntities caps fresh indices but recycled ones still work', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = createWorld({ maxEntities: 3 });
    const a = world.createRawEntity();
    world.createRawEntity();
    expect(() => world.createRawEntity()).toThrow(/maxEntities/);

    world.deleteEntity(a);
    expect(world.isAlive(world.createRawEntity())).toBe(true);
  });

  // docs/issues/ecs-generation-wrap-after-4096-reuses.md
  test('a slot reused 4096 times still gives live, deletable entities', () => {
    const world = createWorld();
    const first = world.createRawEntity();
    world.deleteEntity(first);
    for (let i = 1; i < 4096; i++) world.deleteEntity(world.createRawEntity());

    // The 12-bit generation has wrapped: the id repeats (the packing's limit)
    const entityId = world.createRawEntity();
    expect(entityId).toBe(first);
    expect(world.isAlive(entityId)).toBe(true);
    world.deleteEntity(entityId);
    expect(world.isAlive(entityId)).toBe(false);
    expect(world.getEntityCount()).toBe(0);

    const next = world.createRawEntity();
    expect(next).toBe((1 << INDEX_BITS) | first);
    expect(world.isAlive(next)).toBe(true);
  });

  test('createEntity adds the core components', () => {
    const world = createWorld();
    const entityId = world.createEntity({ appId: 'player' });
    expect(world.getComponent(entityId, ComponentType.APP_ID)).toEqual({
      id: 'player',
      isFixed: true,
    });
    expect(world.getComponent(entityId, ComponentType.TRANSFORM)).toBeInstanceOf(Transform);
    expect(world.hasComponent(entityId, ComponentType.USER_DATA)).toBe(true);
    expect(world.isDisabled(entityId)).toBe(false);

    const generated = world.createEntity({ disabled: true });
    expect(world.getComponent(generated, ComponentType.APP_ID)?.isFixed).toBe(false);
    expect(world.isDisabled(generated)).toBe(true);
  });
});

describe('storages', () => {
  test.each(['MAP', 'TYPED_ARRAY'] as const)(
    '%s: a mutated Transform persists after commitTransform',
    (storageMode) => {
      const world = createWorld({ storageMode });
      const entityId = world.createEntity();
      const transform = world.getComponent(entityId, ComponentType.TRANSFORM)!;
      transform.position.set(1.5, 2, -3);
      transform.scale.set(2, 2, 2);
      world.commitTransform(entityId, transform);

      const read = world.getComponent(entityId, ComponentType.TRANSFORM)!;
      expect(read.position.toArray()).toEqual([1.5, 2, -3]);
      expect(read.scale.toArray()).toEqual([2, 2, 2]);
      expect(world.getTypedTransformStore() !== undefined).toBe(storageMode === 'TYPED_ARRAY');
    }
  );

  test.each(['MAP', 'TYPED_ARRAY'] as const)(
    '%s: deleting an entity clears its components',
    (storageMode) => {
      const world = createWorld({ storageMode });
      const a = world.createEntity();
      const b = world.createEntity();
      world.deleteEntity(a);
      expect(world.hasComponent(a, ComponentType.TRANSFORM)).toBe(false);
      expect(world.hasComponent(b, ComponentType.TRANSFORM)).toBe(true);
      expect([...world.getEntitiesWith(ComponentType.TRANSFORM)]).toEqual([b]);
    }
  );

  test('getStorage of a type with no storage returns an empty one', () => {
    const world = createWorld();
    const type = 'TEST_UNREGISTERED' as ComponentType;
    expect(world.getStorage(type).size).toBe(0);
    expect([...world.getStorage(type)]).toEqual([]);
  });

  test('clearNonPersistent keeps only PERSISTENT entities', () => {
    const world = createWorld();
    const kept = world.createEntity();
    world.addComponent(kept, ComponentType.PERSISTENT, true);
    const dropped = world.createEntity();

    world.clearNonPersistent();
    expect(world.isAlive(kept)).toBe(true);
    expect(world.isAlive(dropped)).toBe(false);
    expect(world.getEntityCount()).toBe(1);
  });
});

describe('component hooks', () => {
  test('onAddComponent sees the new data, onRemoveComponent still sees the old', () => {
    const world = createWorld();
    const calls = recordHooks(world, ComponentType.LIFETIME);
    const entityId = world.createRawEntity();
    world.addComponent(entityId, ComponentType.LIFETIME, 3 as never);
    world.removeComponent(entityId, ComponentType.LIFETIME);

    expect(calls).toEqual([`add:${entityId}:3`, `remove:${entityId}:3`]);
    expect(world.hasComponent(entityId, ComponentType.LIFETIME)).toBe(false);
  });

  test('onDeleteEntity fires only for components the entity has, before they are cleared', () => {
    const world = createWorld();
    const calls = recordHooks(world, ComponentType.LINE);
    const withLine = world.createRawEntity();
    world.addComponent(withLine, ComponentType.LINE, 'line' as never);
    const without = world.createRawEntity();
    calls.length = 0;

    world.deleteEntity(without);
    world.deleteEntity(withLine);
    expect(calls).toEqual([`delete:${withLine}:line`]);
  });

  test('a throwing onDeleteEntity hook does not stop the others or the delete', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = createWorld();
    ECSWorld.registerComponentHooks(ComponentType.TARGET_LINK, {
      onDeleteEntity: (_entityId, w) => {
        if (w === world) throw new Error('disposal failed');
      },
    });
    const calls = recordHooks(world, ComponentType.TARGET_LINK);
    const entityId = world.createRawEntity();
    world.addComponent(entityId, ComponentType.TARGET_LINK, 'x' as never);

    world.deleteEntity(entityId);
    expect(calls).toContain(`delete:${entityId}:x`);
    expect(world.isAlive(entityId)).toBe(false);
  });
});

describe('systems', () => {
  const ids = (world: ECSWorld) =>
    world.getSystemOrder(ECSSystemStage.APP_LOGIC).map((system) => system.id);

  test('higher order runs first, equal order in registration order', () => {
    const world = createWorld();
    const ran: string[] = [];
    const add = (id: string, order?: number) =>
      world.addSystem(ECSSystemStage.APP_LOGIC, id, () => ran.push(id), order);
    add('a');
    add('late', -1);
    add('b');
    add('early', 10);

    expect(ids(world)).toEqual(['early', 'a', 'b', 'late']);
    world.updateAppLoop(1 / 60);
    expect(ran).toEqual(['early', 'a', 'b', 'late']);
  });

  test('a duplicate id is ignored; a removed and re-added one goes to the back of its tier', () => {
    const world = createWorld();
    const noop = () => undefined;
    world.addSystem(ECSSystemStage.APP_LOGIC, 'a', noop);
    world.addSystem(ECSSystemStage.APP_LOGIC, 'b', noop);
    world.addSystem(ECSSystemStage.APP_LOGIC, 'a', noop, 99);
    expect(ids(world)).toEqual(['a', 'b']);

    world.removeSystem('a');
    world.addSystem(ECSSystemStage.APP_LOGIC, 'a', noop);
    expect(ids(world)).toEqual(['b', 'a']);
  });

  test('each update runs its own stages', () => {
    const world = createWorld();
    const ran: string[] = [];
    for (const stage of Object.values(ECSSystemStage)) {
      world.addSystem(stage, stage, () => ran.push(stage));
    }
    world.updateMainLoop(0);
    world.updatePhysicsStep(0);
    world.updateAppLoop(0);
    world.updateLateMainLoop(0);
    expect(ran).toEqual([
      ECSSystemStage.MAIN,
      ECSSystemStage.APP_PRE_PHYSICS,
      ECSSystemStage.APP_PHYSICS_STEP,
      ECSSystemStage.APP_POST_PHYSICS,
      ECSSystemStage.APP_LOGIC,
      ECSSystemStage.APP_RENDER_SYNC,
      ECSSystemStage.LATE_MAIN,
    ]);
  });
});
