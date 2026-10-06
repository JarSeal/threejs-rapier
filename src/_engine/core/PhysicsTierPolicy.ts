// Physics tier distance policy (docs/plans/p352_physics-simulation-tiers.md §5): every N frames,
// each member entity (PHYSICS_TIER_POLICY) gets the tier of the ring around the focus it's in,
// through requestPhysicsTier. Self-registers on import, so an app that never sets a policy pays
// nothing (createPhysicsEntity's `tierPolicy` option only adds the component).

import * as THREE from 'three/webgpu';

import { ECSSystemStage } from '../../AppECSRegistry';
import { existsOrThrow } from '../utils/assert';
import { lwarn } from '../utils/Logger';
import { IS_DEBUG_ENV } from './Config';
import { ECSWorld, getAllECSWorlds, getECSWorld, onECSWorldRegistryChange } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import type { IComponentStorage } from './ECS/ECSComponentStorage';
import { forEachJointBodyPair, hasJoints } from './PhysicsAPI';
import type {
  PhysicsSimTierData,
  PhysicsTier,
  PhysicsTierPolicy,
} from './Physics/PhysicsTierTypes';
import { getPhysicsBodyOwner } from './PhysicsManager';
import { requestPhysicsTier } from './PhysicsTiers';
import { getCurrentSceneId, registerOnAllSceneExits } from './Scene';

export type { PhysicsTierPolicy, PhysicsTierRing } from './Physics/PhysicsTierTypes';

const DEFAULT_HYSTERESIS = 0.15;
const DEFAULT_EVERY_N_FRAMES = 10;

type ResolvedPolicy = {
  def: Readonly<PhysicsTierPolicy>;
  /** Each ring's tier, nearest first. */
  tiers: PhysicsTier[];
  /** Each ring's squared outer radius (the last ring's is Infinity). */
  withinSq: number[];
  /** Each ring's squared radius an entity in it moves out past: within × (1 + hysteresis). */
  leaveSq: number[];
  everyNFrames: number;
  framesUntilPass: number;
};

const policies = new Map<ECSWorld, ResolvedPolicy>();
/** Per world: whoever froze its policy (the app, the debug tab, the determinism probe). */
const freezeSources = new WeakMap<ECSWorld, Set<string>>();

const getWorld = (ecsWorld: ECSWorld | undefined, fnName: string) =>
  ecsWorld || existsOrThrow(getECSWorld(), `Could not get ECS world in ${fnName}.`);

/** Throws on a policy whose rings can't be resolved. */
const validatePolicy = (policy: PhysicsTierPolicy) => {
  const fail = (reason: string) => {
    throw new Error(`setPhysicsTierPolicy: ${reason}.`);
  };
  const { rings } = policy;
  if (!rings.length) fail('a policy needs at least one ring');
  const seen = new Set<PhysicsTier>();
  let prevWithin = 0;
  rings.forEach(({ tier, within }, i) => {
    if (seen.has(tier)) fail(`tier ${tier} is in more than one ring`);
    seen.add(tier);
    const isLast = i === rings.length - 1;
    if (isLast) {
      if (within !== undefined) {
        fail(`the last ring (${tier}) covers everything beyond the others, so it has no within`);
      }
      return;
    }
    if (within === undefined || !Number.isFinite(within) || within <= prevWithin) {
      fail(`ring ${i} (${tier}) needs a within greater than ${prevWithin}`);
    }
    prevWithin = within!;
  });
  const hysteresis = policy.hysteresis ?? DEFAULT_HYSTERESIS;
  if (!Number.isFinite(hysteresis) || hysteresis < 0) fail('hysteresis must be 0 or more');
  const everyNFrames = policy.everyNFrames ?? DEFAULT_EVERY_N_FRAMES;
  if (!Number.isInteger(everyNFrames) || everyNFrames < 1) {
    fail('everyNFrames must be a whole number of 1 or more');
  }
};

/**
 * Sets `world`'s physics tier distance policy (p352), or removes it with `null`. Every
 * `everyNFrames` frames (at `APP_LOGIC`, the first pass on the next frame), each entity with the
 * PHYSICS_TIER_POLICY component (createPhysicsEntity's `tierPolicy` option, or
 * setPhysicsTierPolicyMember) gets the tier of the first ring whose `within` its TRANSFORM
 * position is in, measured from the focus. After its first pass, it moves out to a coarser ring
 * only beyond `within × (1 + hysteresis)`. The policy only calls `requestPhysicsTier`, so the change applies
 * on the next fixed step; a request it refuses (eg. `REMOVED` for a body with joints) isn't
 * repeated until the entity's ring changes.
 *
 * Bodies connected by joints change tier together (requestPhysicsTier), so a joint group gets
 * the tier of its member nearest to the focus.
 *
 * Make the `DISABLED` ring start beyond anything that could reach a body before the next pass
 * (a thrown object, a vehicle): a disabled body is invisible to everything else, and the policy
 * only checks the ring order, not that margin.
 *
 * Removing the policy, or an entity from it, leaves its tier as it is. Not deterministic (it
 * runs on frames, and follows the camera by default): the determinism probe freezes it.
 *
 * @example
 * setPhysicsTierPolicy({
 *   rings: [
 *     { tier: 'FULL', within: 60 },
 *     { tier: 'STATIC', within: 150 },
 *     { tier: 'DISABLED', within: 400 },
 *     { tier: 'REMOVED' }, // beyond
 *   ],
 * });
 */
export const setPhysicsTierPolicy = (policy: PhysicsTierPolicy | null, ecsWorld?: ECSWorld) => {
  const world = getWorld(ecsWorld, 'setPhysicsTierPolicy');
  if (!policy) {
    policies.delete(world);
    return;
  }
  validatePolicy(policy);
  const def = { ...policy, rings: policy.rings.map((ring) => ({ ...ring })) };
  const leaveFactor = (1 + (policy.hysteresis ?? DEFAULT_HYSTERESIS)) ** 2;
  const withinSq = def.rings.map(({ within }) => (within === undefined ? Infinity : within ** 2));
  policies.set(world, {
    def,
    tiers: def.rings.map(({ tier }) => tier),
    withinSq,
    leaveSq: withinSq.map((sq) => sq * leaveFactor),
    everyNFrames: policy.everyNFrames ?? DEFAULT_EVERY_N_FRAMES,
    framesUntilPass: 1,
  });
};

/** `world`'s physics tier policy as it was set, or null. */
export const getPhysicsTierPolicy = (ecsWorld?: ECSWorld): Readonly<PhysicsTierPolicy> | null =>
  policies.get(getWorld(ecsWorld, 'getPhysicsTierPolicy'))?.def ?? null;

/**
 * Makes `entityId`'s tier follow its world's policy, or stops it (its tier stays as it is). For
 * an entity created without createPhysicsEntity's `tierPolicy` option. Returns false (with a
 * debug-env warning) for an entity without a body created DYNAMIC by createPhysicsEntity.
 */
export const setPhysicsTierPolicyMember = (
  entityId: number,
  member: boolean,
  ecsWorld?: ECSWorld
): boolean => {
  const world = getWorld(ecsWorld, 'setPhysicsTierPolicyMember');
  if (!member) {
    world.removeComponent(entityId, ComponentType.PHYSICS_TIER_POLICY);
    return true;
  }
  if (world.hasComponent(entityId, ComponentType.PHYSICS_TIER_POLICY)) return true;
  const body = getEntityBody(world, entityId);
  const owner = body ? getPhysicsBodyOwner(body.id) : undefined;
  if (owner?.world !== world || owner.entityId !== entityId || owner.rigidType !== 'DYNAMIC') {
    if (IS_DEBUG_ENV) {
      lwarn(
        `setPhysicsTierPolicyMember: entity ${entityId} has no DYNAMIC body made by createPhysicsEntity.`
      );
    }
    return false;
  }
  world.addComponent(entityId, ComponentType.PHYSICS_TIER_POLICY, {
    refusedTier: null,
    placed: false,
  });
  return true;
};

/**
 * Freezes `world`'s policy (no passes, every tier stays as it is) or unfreezes it. Each `source`
 * freezes on its own, and the policy runs again once no source holds it (the determinism probe
 * and the debug tab use their own).
 */
export const setPhysicsTierPolicyFrozen = (
  frozen: boolean,
  source = 'APP',
  ecsWorld?: ECSWorld
) => {
  const world = getWorld(ecsWorld, 'setPhysicsTierPolicyFrozen');
  let sources = freezeSources.get(world);
  if (!sources) {
    sources = new Set();
    freezeSources.set(world, sources);
  }
  if (frozen) sources.add(source);
  else sources.delete(source);
};

/** Whether any source froze `world`'s policy, or only `source` when given. */
export const isPhysicsTierPolicyFrozen = (ecsWorld?: ECSWorld, source?: string) => {
  const sources = freezeSources.get(getWorld(ecsWorld, 'isPhysicsTierPolicyFrozen'));
  if (!sources) return false;
  return source === undefined ? sources.size > 0 : sources.has(source);
};

/** The entity's body, also while REMOVED (no bucket component then). */
const getEntityBody = (world: ECSWorld, entityId: number) =>
  world.getRigidBody(entityId) ??
  world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER)?.body;

const _focus = new THREE.Vector3();

/** The focus position for this pass, or null to skip it. */
const resolveFocus = (world: ECSWorld, policy: ResolvedPolicy): THREE.Vector3 | null => {
  const { focus } = policy.def;
  if (!focus) {
    // getMainCamera() reads the default world; a policy reads its own world's main camera
    const cameraId = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;
    if (cameraId === undefined) return null;
    const camera = world.getComponent(cameraId, ComponentType.OBJECT3D)?.value;
    return camera ? camera.getWorldPosition(_focus) : null;
  }
  const at = focus();
  if (at === null || at === undefined) return null;
  if (typeof at === 'number') {
    const transform = world.getComponent(at, ComponentType.TRANSFORM);
    return transform ? _focus.copy(transform.position) : null;
  }
  return _focus.set(at.x, at.y, at.z);
};

/** The index of the first ring `distSq` is within, by `radiiSq` (withinSq or leaveSq). */
const ringIndexFor = (distSq: number, radiiSq: number[]) => {
  for (let i = 0; i < radiiSq.length - 1; i++) {
    if (distSq <= radiiSq[i]) return i;
  }
  return radiiSq.length - 1;
};

/** Per pass: member entity id → the ring it should be in. Reused. */
const desiredRings = new Map<number, number>();
/** Per pass: member entity id → its joint group (a root body id), for jointed members only. */
const jointGroups = new Map<number, number>();
/** Per pass: joint group → the tier requestPhysicsTier refused it. */
const refusedGroups = new Map<number, PhysicsTier>();

/**
 * Gives every joint group with members in `desired` the ring of its nearest member, and records
 * each jointed member's group in `jointGroups`. Groups are linked through DYNAMIC
 * createPhysicsEntity bodies of `world`, as requestPhysicsTier's are.
 * Without this, a member that stays put wouldn't request, and another member's request would
 * move the whole group away from it (and back on the next pass).
 */
const unifyJointGroups = (
  world: ECSWorld,
  desired: Map<number, number>,
  tierStorage: IComponentStorage<PhysicsSimTierData>
) => {
  const parent = new Map<number, number>();
  const find = (bodyId: number): number => {
    let root = bodyId;
    for (
      let next = parent.get(root);
      next !== undefined && next !== root;
      next = parent.get(root)
    ) {
      root = next;
    }
    // Path compression
    for (let id = bodyId; id !== root; ) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const isTierable = (bodyId: number) => {
    const owner = getPhysicsBodyOwner(bodyId);
    return owner?.world === world && owner.rigidType === 'DYNAMIC';
  };
  forEachJointBodyPair((body1Id, body2Id) => {
    if (!isTierable(body1Id) || !isTierable(body2Id)) return;
    if (!parent.has(body1Id)) parent.set(body1Id, body1Id);
    if (!parent.has(body2Id)) parent.set(body2Id, body2Id);
    parent.set(find(body1Id), find(body2Id));
  });
  if (!parent.size) return;

  const bodyOf = (entityId: number) =>
    (world.getRigidBody(entityId) ?? tierStorage.get(entityId)?.body)?.id;
  const groupRings = new Map<number, number>();
  for (const [entityId, ring] of desired) {
    const bodyId = bodyOf(entityId);
    if (bodyId === undefined || !parent.has(bodyId)) continue;
    const root = find(bodyId);
    groupRings.set(root, Math.min(groupRings.get(root) ?? ring, ring));
  }
  for (const entityId of desired.keys()) {
    const bodyId = bodyOf(entityId);
    if (bodyId === undefined || !parent.has(bodyId)) continue;
    const root = find(bodyId);
    desired.set(entityId, groupRings.get(root)!);
    jointGroups.set(entityId, root);
  }
};

const runPolicyPass = (world: ECSWorld, policy: ResolvedPolicy) => {
  const members = world.getStorage(ComponentType.PHYSICS_TIER_POLICY);
  if (!members.size) return;
  const focus = resolveFocus(world, policy);
  if (!focus) return;
  const transforms = world.getStorage(ComponentType.TRANSFORM);
  const tierStorage = world.getStorage(ComponentType.PHYSICS_SIM_TIER);
  const { tiers, withinSq, leaveSq } = policy;

  desiredRings.clear();
  jointGroups.clear();
  for (const [entityId, member] of members) {
    const position = transforms.get(entityId)?.position;
    if (!position) continue;
    const distSq = position.distanceToSquared(focus);
    // The latest request (an entity with no component is FULL)
    const currentRing = tiers.indexOf(tierStorage.get(entityId)?.target ?? 'FULL');
    let ring = ringIndexFor(distSq, withinSq);
    // Moving out: only past the hysteresis margin of the ring it's in. A new member, or one in
    // a tier the policy has no ring for (requested by other code), goes straight to its ring.
    if (member.placed && currentRing >= 0 && ring > currentRing) {
      ring = Math.max(currentRing, ringIndexFor(distSq, leaveSq));
    }
    desiredRings.set(entityId, ring);
    member.placed = true;
  }
  if (hasJoints()) unifyJointGroups(world, desiredRings, tierStorage);

  for (const [entityId, ring] of desiredRings) {
    const member = members.get(entityId)!;
    const tier = tiers[ring];
    // Read again: a joint group member's request may have moved this one already
    if (tier === (tierStorage.get(entityId)?.target ?? 'FULL')) {
      member.refusedTier = null;
      continue;
    }
    if (member.refusedTier === tier) continue;
    // requestPhysicsTier refuses a whole joint group: its other members aren't asked (or warned
    // about) again
    const group = jointGroups.get(entityId);
    if (group !== undefined && refusedGroups.get(group) === tier) {
      member.refusedTier = tier;
      continue;
    }
    member.refusedTier = requestPhysicsTier(entityId, tier, world) ? null : tier;
    if (member.refusedTier && group !== undefined) refusedGroups.set(group, tier);
  }
  desiredRings.clear();
  jointGroups.clear();
  refusedGroups.clear();
};

const physicsTierPolicySystem = (world: ECSWorld) => {
  const policy = policies.get(world);
  if (!policy || freezeSources.get(world)?.size) return;
  if (--policy.framesUntilPass > 0) return;
  policy.framesUntilPass = policy.everyNFrames;
  runPolicyPass(world, policy);
};

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.APP_LOGIC, 'physicsTierPolicySystem', physicsTierPolicySystem);
});

// A scene-scoped policy goes with its scene (the current one while the exit hooks run)
registerOnAllSceneExits('physicsTierPolicy', () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;
  for (const [world, policy] of policies) {
    if (policy.def.sceneId === sceneId) policies.delete(world);
  }
});

// Deleted worlds (a scene's secondary worlds) drop their policies
onECSWorldRegistryChange(() => {
  if (!policies.size) return;
  const alive = new Set(getAllECSWorlds());
  for (const world of policies.keys()) {
    if (!alive.has(world)) policies.delete(world);
  }
});
