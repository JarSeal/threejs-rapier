// Physics simulation tiers (docs/plans/p352_physics-simulation-tiers.md): a dynamic body can be
// frozen in place but collidable (STATIC) or taken out of the simulation (DISABLED), and put
// back (FULL). Self-registers on import, so an app that never requests a tier pays nothing.

import { ECSSystemStage } from '../../AppECSRegistry';
import { existsOrThrow } from '../utils/assert';
import { lwarn } from '../utils/Logger';
import { IS_DEBUG_ENV } from './Config';
import { ECSWorld, getECSWorld } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import { forEachJointBodyPair, hasJoints } from './PhysicsAPI';
import { RigidBodyTypeAPI } from './Physics/PhysicsAPITypes';
import type { PhysicsSimTierData, PhysicsTier } from './Physics/PhysicsTierTypes';
import { getPhysicsBodyOwner, queueStaticBodySync } from './PhysicsManager';

export type { PhysicsTier } from './Physics/PhysicsTierTypes';

/** First in APP_PHYSICS_STEP (higher runs first), so the other systems of that sub-step see
 * the new tiers and buckets. */
const PHYSICS_TIER_SYSTEM_ORDER = 100;

/** Per world: entities whose target differs from their tier, in request order. */
const pendingByWorld = new WeakMap<ECSWorld, Set<number>>();

const getPending = (world: ECSWorld) => {
  let pending = pendingByWorld.get(world);
  if (!pending) {
    pending = new Set();
    pendingByWorld.set(world, pending);
  }
  return pending;
};

/** Why `entityId` can't have a tier, or null when it can. */
const getTierRefusal = (world: ECSWorld, entityId: number): string | null => {
  if (world.hasComponent(entityId, ComponentType.TAG_IS_CHARACTER)) {
    return 'it is a character (p420 owns character tiers)';
  }
  const rb = world.getRigidBody(entityId);
  if (!rb) return 'it has no rigid body (request a tier once its createPhysicsEntity resolves)';
  const owner = getPhysicsBodyOwner(rb.id);
  if (!owner || owner.world !== world || owner.entityId !== entityId) {
    return 'its body was not created by createPhysicsEntity';
  }
  if (owner.rigidType !== 'DYNAMIC') {
    return `its body was created ${owner.rigidType}, and only DYNAMIC bodies have tiers`;
  }
  return null;
};

/**
 * The entities that change tier together with `entityId`: every body connected to it by impulse
 * joints, through bodies that can have tiers. A FIXED or kinematic body, or one not created by
 * createPhysicsEntity, ends a group without joining it (two chains hanging from one fixed
 * ceiling are two groups). Returns the refusal reason instead when one of them can't have a tier.
 */
const resolveTierGroup = (world: ECSWorld, entityId: number): number[] | string => {
  const refusal = getTierRefusal(world, entityId);
  if (refusal) return refusal;
  if (!hasJoints()) return [entityId];

  const adjacency = new Map<number, number[]>();
  const link = (from: number, to: number) => {
    const linked = adjacency.get(from);
    if (linked) linked.push(to);
    else adjacency.set(from, [to]);
  };
  forEachJointBodyPair((body1Id, body2Id) => {
    link(body1Id, body2Id);
    link(body2Id, body1Id);
  });

  const startBodyId = world.getRigidBody(entityId)!.id;
  const members = [entityId];
  const seen = new Set([startBodyId]);
  const queue = [startBodyId];
  while (queue.length) {
    const linked = adjacency.get(queue.pop()!);
    if (!linked) continue;
    for (const bodyId of linked) {
      if (seen.has(bodyId)) continue;
      seen.add(bodyId);
      const owner = getPhysicsBodyOwner(bodyId);
      if (!owner || owner.world !== world || owner.rigidType !== 'DYNAMIC') continue;
      const memberRefusal = getTierRefusal(world, owner.entityId);
      if (memberRefusal) return `joint group member ${owner.entityId}: ${memberRefusal}`;
      members.push(owner.entityId);
      queue.push(bodyId);
    }
  }
  return members;
};

/**
 * Requests a simulation tier for a dynamic physics entity (p352). It applies at the start of
 * the next `APP_PHYSICS_STEP` sub-step, so a request from an `APP_PHYSICS_STEP` system or from
 * scene-load code is deterministic. Requests before then collapse into the latest one.
 *
 * - `FULL`: simulated as created.
 * - `STATIC`: switched to `FIXED`. It still collides, but nothing moves or wakes it. Rapier
 *   zeroes its velocities, so it resumes from rest.
 * - `DISABLED`: out of the broad phase, contacts and queries (rays miss it), so only where
 *   nothing can reach it. It keeps its pose and velocities exactly.
 *
 * `STATIC` and `DISABLED` move the entity to `BODY_STATIC`: no per-frame sync or interpolation,
 * and `world.getRigidBody` still returns its body. The body's type and enabled state belong to
 * the tier until it's `FULL` again (`world.setDisabled` keeps a `DISABLED` body disabled).
 *
 * Every body connected to it by impulse joints changes tier with it (see resolveTierGroup).
 * Returns false and changes nothing when the entity or a member of its joint group can't have a
 * tier: a character, no rigid body (yet), or a body not created `DYNAMIC` by
 * `createPhysicsEntity`.
 */
export const requestPhysicsTier = (
  entityId: number,
  tier: PhysicsTier,
  ecsWorld?: ECSWorld
): boolean => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in requestPhysicsTier.');
  const group = resolveTierGroup(world, entityId);
  if (typeof group === 'string') {
    if (IS_DEBUG_ENV) {
      lwarn(`requestPhysicsTier: entity ${entityId} can't change tier to ${tier}: ${group}.`);
    }
    return false;
  }

  const pending = getPending(world);
  for (const memberId of group) {
    let data = world.getComponent(memberId, ComponentType.PHYSICS_SIM_TIER);
    if (!data) {
      if (tier === 'FULL') continue; // no component = FULL
      data = {
        tier: 'FULL',
        target: tier,
        bucket: world.hasComponent(memberId, ComponentType.BODY_DYNAMIC_VISUAL)
          ? 'BODY_DYNAMIC_VISUAL'
          : 'BODY_DYNAMIC_HEADLESS',
      };
      world.addComponent(memberId, ComponentType.PHYSICS_SIM_TIER, data);
    }
    data.target = tier;
    if (data.target === data.tier) pending.delete(memberId);
    else pending.add(memberId);
  }
  return true;
};

/** `entityId`'s tier, and the tier requested for it that hasn't applied yet (null if none). An
 * entity that never got a tier is `FULL`. */
export const getPhysicsTier = (
  entityId: number,
  ecsWorld?: ECSWorld
): { tier: PhysicsTier; pending: PhysicsTier | null } => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in getPhysicsTier.');
  const data = world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER);
  if (!data) return { tier: 'FULL', pending: null };
  return { tier: data.tier, pending: data.target !== data.tier ? data.target : null };
};

/**
 * Moves one entity from its tier to its target. Each tier is a body state: FULL = DYNAMIC and
 * enabled, STATIC = FIXED and enabled, DISABLED = DYNAMIC and disabled; only the difference is
 * written. All of it is one-way commands, so in WORKER_THREAD mode they ride in this sub-step's
 * STEP message.
 */
const applyTier = (world: ECSWorld, entityId: number, data: PhysicsSimTierData) => {
  const from = data.tier;
  const to = data.target;
  const rb = world.getRigidBody(entityId);
  if (from === to || !rb) return;

  if ((from === 'STATIC') !== (to === 'STATIC')) {
    const toStatic = to === 'STATIC';
    rb.setBodyType(toStatic ? RigidBodyTypeAPI.Fixed : RigidBodyTypeAPI.Dynamic, !toStatic);
  }
  // A world-disabled entity's body stays disabled whatever its tier (ECSWorld.setDisabled)
  if ((from === 'DISABLED') !== (to === 'DISABLED') && !world.isDisabled(entityId)) {
    rb.setEnabled(to !== 'DISABLED');
  }

  if (from === 'FULL') {
    world.removeComponent(entityId, ComponentType[data.bucket]);
    world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
    // The mesh shows the interpolated pose, which can be behind: the transform is marked dirty
    // so object3DSyncSystem copies it, and synced until a snapshot includes the frozen pose.
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (transform) {
      transform.setDirty();
      world.commitTransform(entityId, transform);
    }
    queueStaticBodySync(world, entityId);
  } else if (to === 'FULL') {
    // Its interpolation history has a gap now, so it starts over from the current pose
    world.removeComponent(entityId, ComponentType.BODY_STATIC);
    world.addComponent(entityId, ComponentType[data.bucket], rb);
  }
  data.tier = to;
};

const physicsTierSystem = (world: ECSWorld) => {
  const pending = pendingByWorld.get(world);
  if (!pending?.size) return;
  for (const entityId of pending) {
    const data = world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER);
    if (data) applyTier(world, entityId, data);
  }
  pending.clear();
};

ECSWorld.registerPlugin((world) => {
  world.addSystem(
    ECSSystemStage.APP_PHYSICS_STEP,
    'physicsTierSystem',
    physicsTierSystem,
    PHYSICS_TIER_SYSTEM_ORDER
  );
});

ECSWorld.registerComponentHooks(ComponentType.PHYSICS_SIM_TIER, {
  onRemoveComponent: (entityId, world) => pendingByWorld.get(world)?.delete(entityId),
  onDeleteEntity: (entityId, world) => pendingByWorld.get(world)?.delete(entityId),
});
