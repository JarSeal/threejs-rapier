// Physics simulation tiers (docs/plans/_DONE_p352_physics-simulation-tiers.md): a dynamic body can be
// frozen in place but collidable (STATIC), taken out of the simulation (DISABLED) or out of the
// physics world (REMOVED), and put back (FULL). Self-registers on import, so an app that never
// requests a tier pays nothing.

import { ECSSystemStage } from '../../AppECSRegistry';
import { existsOrThrow } from '../utils/assert';
import { lerror, lwarn } from '../utils/Logger';
import { IS_DEBUG_ENV } from './Config';
import { ECSWorld, getECSWorld } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import {
  detachRigidBody,
  detachRigidBodySync,
  forEachJointBodyPair,
  getPhysicsState,
  hasJoints,
  reattachRigidBody,
  reattachRigidBodySync,
} from './PhysicsAPI';
import { RigidBodyTypeAPI, type RigidBodyPose } from './Physics/PhysicsAPITypes';
import type { PhysicsSimTierData, PhysicsTier } from './Physics/PhysicsTierTypes';
import {
  getPhysicsBodyOwner,
  queueStaticBodySync,
  resetPhysicsInterpolationHistory,
} from './PhysicsManager';

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

/** The entity's body: also while REMOVED (or in flight back), when it has no bucket component. */
const getTierBody = (world: ECSWorld, entityId: number) =>
  world.getRigidBody(entityId) ??
  world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER)?.body;

/** Whether any impulse joint is attached to the body. */
const bodyHasJoints = (bodyId: number) => {
  if (!hasJoints()) return false;
  let found = false;
  forEachJointBodyPair((body1Id, body2Id) => {
    if (body1Id === bodyId || body2Id === bodyId) found = true;
  });
  return found;
};

/** Why `entityId` can't have `tier`, or null when it can. */
const getTierRefusal = (world: ECSWorld, entityId: number, tier: PhysicsTier): string | null => {
  if (world.hasComponent(entityId, ComponentType.TAG_IS_CHARACTER)) {
    return 'it is a character (p420 owns character tiers)';
  }
  const rb = getTierBody(world, entityId);
  if (!rb) return 'it has no rigid body (request a tier once its createPhysicsEntity resolves)';
  const owner = getPhysicsBodyOwner(rb.id);
  if (!owner || owner.world !== world || owner.entityId !== entityId) {
    return 'its body was not created by createPhysicsEntity';
  }
  if (owner.rigidType !== 'DYNAMIC') {
    return `its body was created ${owner.rigidType}, and only DYNAMIC bodies have tiers`;
  }
  if (tier === 'REMOVED' && bodyHasJoints(rb.id)) {
    return 'it has joints, which REMOVED would delete (p500 owns re-creating joints)';
  }
  return null;
};

/**
 * The entities that change tier together with `entityId`: every body connected to it by impulse
 * joints, through bodies that can have tiers. A FIXED or kinematic body, or one not created by
 * createPhysicsEntity, ends a group without joining it (two chains hanging from one fixed
 * ceiling are two groups). Returns the refusal reason instead when one of them can't have a tier.
 * `REMOVED` is refused with any joint, so its group is the entity alone.
 */
const resolveTierGroup = (
  world: ECSWorld,
  entityId: number,
  tier: PhysicsTier
): number[] | string => {
  const refusal = getTierRefusal(world, entityId, tier);
  if (refusal) return refusal;
  if (tier === 'REMOVED' || !hasJoints()) return [entityId];

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

  const startBodyId = getTierBody(world, entityId)!.id;
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
      const memberRefusal = getTierRefusal(world, owner.entityId, tier);
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
 * - `REMOVED`: the body and its colliders leave the physics world and free their
 *   transform-buffer slot; the entity and its visual stay. Their state is kept, with their ids
 *   (references to the body and colliders work again once it's back). A body at rest comes back
 *   exactly as if it had never left; a moving one with its pose, velocities and sleep state, but
 *   Rapier's contact and solver state starts over. Refused for a body with joints.
 *
 * `STATIC` and `DISABLED` move the entity to `BODY_STATIC`: no per-frame sync or interpolation,
 * and `world.getRigidBody` still returns its body. The body's type and enabled state belong to
 * the tier until it's `FULL` again (`world.setDisabled` keeps a `DISABLED` body disabled).
 * `REMOVED` takes its bucket and COLLIDER components away (`world.getRigidBody` returns
 * undefined), and `world.setTransform` moves only its visual until it's back. In WORKER_THREAD
 * mode the components come back a frame or so after the body does (`getPhysicsTier`'s
 * `inFlight`); a full transform buffer then refuses it (`PhysicsCapacityError`, logged), and it
 * stays `REMOVED`.
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
  const group = resolveTierGroup(world, entityId, tier);
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
        body: world.getRigidBody(memberId)!,
        colliders: null,
        inFlight: false,
        removalSeq: 0,
      };
      world.addComponent(memberId, ComponentType.PHYSICS_SIM_TIER, data);
    }
    data.target = tier;
    if (data.target === data.tier) pending.delete(memberId);
    else pending.add(memberId);
  }
  return true;
};

/**
 * `entityId`'s tier, the tier requested for it that hasn't applied yet (null if none), and
 * whether it's in flight back from `REMOVED` (WORKER_THREAD: the body is back, its bucket and
 * COLLIDER components aren't yet). An entity that never got a tier is `FULL`.
 */
export const getPhysicsTier = (
  entityId: number,
  ecsWorld?: ECSWorld
): { tier: PhysicsTier; pending: PhysicsTier | null; inFlight: boolean } => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in getPhysicsTier.');
  const data = world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER);
  if (!data) return { tier: 'FULL', pending: null, inFlight: false };
  return {
    tier: data.tier,
    pending: data.target !== data.tier ? data.target : null,
    inFlight: data.inFlight,
  };
};

const isMainThread = () => getPhysicsState().workerTarget === 'MAIN_THREAD';

/** Whether a worker reply for the move to or from REMOVED numbered `seq` is still the latest. */
const isCurrentRemoval = (
  world: ECSWorld,
  entityId: number,
  data: PhysicsSimTierData,
  seq: number
) =>
  world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER) === data && data.removalSeq === seq;

/** Shows a REMOVED entity where its body was taken out: in WORKER_THREAD mode the transform can
 * be a frame behind it. */
const showRemovedPose = (world: ECSWorld, entityId: number, pose: RigidBodyPose | undefined) => {
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (!pose || !transform) return;
  transform.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  transform.quaternion.set(pose.rot.x, pose.rot.y, pose.rot.z, pose.rot.w);
  transform.setDirty();
  world.commitTransform(entityId, transform);
};

/** Takes the entity's body out of the physics world (to REMOVED). In WORKER_THREAD mode it's
 * detached right before this sub-step, and the reply only brings its pose for the visual. */
const removeFromWorld = (world: ECSWorld, entityId: number, data: PhysicsSimTierData) => {
  const bodyId = data.body.id;
  // A joint made since the request (getTierRefusal checked then)
  if (bodyHasJoints(bodyId)) {
    if (IS_DEBUG_ENV) {
      lwarn(`requestPhysicsTier: entity ${entityId} got joints, it stays ${data.tier}.`);
    }
    data.target = data.tier;
    return;
  }
  if (!data.inFlight) {
    world.removeComponent(
      entityId,
      ComponentType[data.tier === 'FULL' ? data.bucket : 'BODY_STATIC']
    );
    data.colliders = world.getComponent(entityId, ComponentType.COLLIDER) ?? [];
    world.removeComponent(entityId, ComponentType.COLLIDER);
  }
  // A return still in flight is overtaken: its reply is dropped
  data.inFlight = false;
  data.tier = 'REMOVED';
  const seq = ++data.removalSeq;
  if (isMainThread()) {
    showRemovedPose(world, entityId, detachRigidBodySync(bodyId));
    return;
  }
  detachRigidBody(bodyId).then(
    (pose) => {
      if (isCurrentRemoval(world, entityId, data, seq)) showRemovedPose(world, entityId, pose);
    },
    (err) => lerror(`Physics tier: failed to remove entity ${entityId}.`, err)
  );
};

/** Gives a body that is back in the world its bucket and COLLIDER components, for its tier. */
const placeInWorld = (world: ECSWorld, entityId: number, data: PhysicsSimTierData) => {
  // Its interpolation history ends where it was removed: it starts over from the current pose
  resetPhysicsInterpolationHistory(world, entityId);
  if (data.tier === 'FULL') {
    world.addComponent(entityId, ComponentType[data.bucket], data.body);
  } else {
    world.addComponent(entityId, ComponentType.BODY_STATIC, data.body);
    queueStaticBodySync(world, entityId);
  }
  world.addComponent(entityId, ComponentType.COLLIDER, data.colliders ?? []);
  data.colliders = null;
};

/** A return that didn't happen (a full transform buffer): the entity stays REMOVED. */
const stayRemoved = (world: ECSWorld, entityId: number, data: PhysicsSimTierData, err: unknown) => {
  data.tier = 'REMOVED';
  data.target = 'REMOVED';
  pendingByWorld.get(world)?.delete(entityId);
  lwarn(`Physics tier: entity ${entityId} stays REMOVED.`, err);
};

/** Puts the entity's body back into the physics world (from REMOVED), straight into tier `to`.
 * In WORKER_THREAD mode it's back right before this sub-step, and it's in flight until the
 * reply brings its slot: later requests still apply on their own steps (the worker runs them
 * in order), only the components wait for it. */
const returnToWorld = (
  world: ECSWorld,
  entityId: number,
  data: PhysicsSimTierData,
  to: PhysicsTier
) => {
  const bodyId = data.body.id;
  const state = {
    bodyType: to === 'STATIC' ? RigidBodyTypeAPI.Fixed : RigidBodyTypeAPI.Dynamic,
    // A world-disabled entity's body stays disabled whatever its tier (ECSWorld.setDisabled)
    enabled: to !== 'DISABLED' && !world.isDisabled(entityId),
  };
  data.tier = to;
  const seq = ++data.removalSeq;
  if (isMainThread()) {
    if (reattachRigidBodySync(bodyId, state)) placeInWorld(world, entityId, data);
    else stayRemoved(world, entityId, data, `rigid body ${bodyId} was not detached`);
    return;
  }
  data.inFlight = true;
  reattachRigidBody(bodyId, state).then(
    (pose) => {
      if (!isCurrentRemoval(world, entityId, data, seq)) return;
      data.inFlight = false;
      if (pose) placeInWorld(world, entityId, data);
      else stayRemoved(world, entityId, data, `rigid body ${bodyId} was not detached`);
    },
    (err) => {
      if (!isCurrentRemoval(world, entityId, data, seq)) return;
      data.inFlight = false;
      stayRemoved(world, entityId, data, err);
    }
  );
};

/**
 * Moves one entity from its tier to its target. FULL, STATIC and DISABLED are body states:
 * FULL = DYNAMIC and enabled, STATIC = FIXED and enabled, DISABLED = DYNAMIC and disabled; only
 * the difference is written. All of it is one-way commands, so in WORKER_THREAD mode they ride
 * in this sub-step's STEP message. REMOVED takes the body out of the world (removeFromWorld,
 * returnToWorld).
 */
const applyTier = (world: ECSWorld, entityId: number, data: PhysicsSimTierData) => {
  const from = data.tier;
  const to = data.target;
  if (from === to) return;
  if (to === 'REMOVED') return removeFromWorld(world, entityId, data);
  if (from === 'REMOVED') return returnToWorld(world, entityId, data, to);

  const rb = data.body;
  if ((from === 'STATIC') !== (to === 'STATIC')) {
    const toStatic = to === 'STATIC';
    rb.setBodyType(toStatic ? RigidBodyTypeAPI.Fixed : RigidBodyTypeAPI.Dynamic, !toStatic);
  }
  // A world-disabled entity's body stays disabled whatever its tier (ECSWorld.setDisabled)
  if ((from === 'DISABLED') !== (to === 'DISABLED') && !world.isDisabled(entityId)) {
    rb.setEnabled(to !== 'DISABLED');
  }
  data.tier = to;
  // In flight back from REMOVED: placeInWorld picks the bucket for the tier it has by then
  if (data.inFlight) return;

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
