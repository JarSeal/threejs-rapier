import * as THREE from 'three/webgpu';

import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../AppECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { lerror, lwarn } from '../utils/Logger';
import { IS_DEBUG_ENV } from './Config';
import { DebugModuleRef, loadDebugModule, useDebug } from '../utils/helpers';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import type { IComponentStorage } from './ECS/ECSComponentStorage';
import {
  createColliders,
  createCollidersSync,
  createRigidBody,
  createRigidBodySync,
  deleteColliders,
  deleteRigidBody,
  getPhysicsSimClock,
  getPhysicsSimClockEpoch,
  getPhysicsSimHistoryEpoch,
  getPhysicsState,
  getPhysicsWriteVisibleStep,
  readPhysicsSnapshotStamp,
} from './PhysicsAPI';
import {
  ColliderParams,
  RigidBodyAPI,
  RigidBodyParams,
  type PhysicsInterpolationMode,
} from './Physics/PhysicsAPITypes';
import { getCurrentSceneId, getRootScene, registerOnAllSceneEnterings } from './Scene';

let debugPhysicsDraw: DebugModuleRef<typeof import('./Debug/_dbg__PhysicsDebugDraw')> | null = null;

/** Primitive-geometry params createGeometry() stashes on BufferGeometry.userData.props.params
 * (Geometry.ts) — the subset relevant to deriving a collider's dimensions. */
type PrimitiveGeoParams = {
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  radiusTop?: number;
  radiusBottom?: number;
};

/** Fills in a primitive collider's missing dimensions (hx/hy/hz, radius, halfHeight) from its
 * target mesh's createGeometry()-authored params, mirroring the legacy PhysicsRapier.ts
 * createCollider's per-shape-type mesh-geometry fallback — never overrides a dimension the
 * caller already set explicitly. A no-op for any params/shape it doesn't recognize (TRIMESH/
 * CONVEXHULL/HEIGHTFIELD imports already get their own dedicated derivation in
 * Import/MeshColliderGeometry.ts, which runs before this ever sees them). */
export const deriveColliderDimensionsFromMesh = (
  params: ColliderParams,
  mesh: THREE.Object3D | undefined
): ColliderParams => {
  const geoParams = (mesh as THREE.Mesh | undefined)?.geometry?.userData?.props?.params as
    | PrimitiveGeoParams
    | undefined;
  if (!geoParams) return params;

  switch (params.type) {
    case 'CUBOID':
    case 'BOX':
      return {
        ...params,
        hx: params.hx ?? (geoParams.width !== undefined ? geoParams.width / 2 : undefined),
        hy: params.hy ?? (geoParams.height !== undefined ? geoParams.height / 2 : undefined),
        hz: params.hz ?? (geoParams.depth !== undefined ? geoParams.depth / 2 : undefined),
      };
    case 'BALL':
    case 'SPHERE':
      return { ...params, radius: params.radius ?? geoParams.radius };
    case 'CAPSULE':
      return {
        ...params,
        halfHeight:
          params.halfHeight ?? (geoParams.height !== undefined ? geoParams.height / 2 : undefined),
        radius: params.radius ?? geoParams.radius,
      };
    case 'CONE':
    case 'CYLINDER':
      return {
        ...params,
        halfHeight:
          params.halfHeight ?? (geoParams.height !== undefined ? geoParams.height / 2 : undefined),
        radius: params.radius ?? geoParams.radiusBottom ?? geoParams.radiusTop,
      };
    default:
      return params;
  }
};

export const registerPhysicsManager = (world: ECSWorld) => {
  if (IS_DEBUG_ENV) {
    // Per-entity collider wireframes (p025). Self-registers its ECS hooks/system on
    // import; nothing runs until an entity actually gets a DEBUG_PHYSICS_WIREFRAME
    // component, and none of it reaches a production bundle.
    debugPhysicsDraw = loadDebugModule(() => import('./Debug/_dbg__PhysicsDebugDraw'));

    registerOnAllSceneEnterings('physicsWireframeMasterVisibilitySync', () => {
      const sceneId = getCurrentSceneId();
      if (sceneId) useDebug(debugPhysicsDraw)?.syncWireframeMasterVisibilityFromLS(sceneId);
    });
  }

  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_PHYSICS_OBJECT, {
    onDeleteEntity: (entityId, w) => {
      // onDeleteEntity is synchronous; disposal is fire-and-forget (WORKER_THREAD mode
      // has no synchronous delete path, see disposePhysicsEntity).
      disposePhysicsEntity(entityId, w).catch((err) =>
        lerror(`Failed to dispose physics entity ${entityId}.`, err)
      );
      worldInterpolationStates.get(w)?.histories.delete(entityId);
    },
  });
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'physicsToTransformSystem',
    physicsToTransformSystem
  );
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'physicsInterpolationSystem',
    physicsInterpolationSystem,
    APP_RENDER_SYNC_ORDER.POSE_PRODUCERS
  );
};

export const createPhysicsEntity = async (
  colliderParams: ColliderParams | ColliderParams[],
  rigidBodyParams?: RigidBodyParams,
  /**
   * Either a raw Object3D (a new entity is created and this is attached to it as its
   * OBJECT3D component, same as before), or the id of an existing entity to attach the
   * physics components to directly (e.g. one already created by createMeshEntity) —
   * no new entity is created, and its own OBJECT3D/other components (if any) already
   * on it govern the BODY_DYNAMIC_VISUAL/HEADLESS bucket choice below.
   */
  target?: THREE.Object3D | number,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): Promise<number> => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createPhysicsEntity.');

  const object3D = target instanceof THREE.Object3D ? target : undefined;
  const entityId = typeof target === 'number' ? target : world.createEntity(entityOpts);

  world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);

  const isWorkerThread = getPhysicsState().workerTarget === 'WORKER_THREAD';

  // Attaching to an existing entity (e.g. one already positioned by createMeshEntity) whose
  // rigidBodyParams don't specify their own translation/rotation: the new rigid body must
  // spawn at the entity's CURRENT transform, not Rapier's bare origin default — otherwise the
  // transform-from-rigid-body sync below silently teleports the mesh to (0,0,0) instead of
  // the body inheriting where the mesh already is.
  if (rigidBodyParams && typeof target === 'number' && !rigidBodyParams.translation) {
    const existingTransform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (existingTransform) {
      rigidBodyParams = {
        ...rigidBodyParams,
        translation: {
          x: existingTransform.position.x,
          y: existingTransform.position.y,
          z: existingTransform.position.z,
        },
        rotation: rigidBodyParams.rotation ?? {
          x: existingTransform.quaternion.x,
          y: existingTransform.quaternion.y,
          z: existingTransform.quaternion.z,
          w: existingTransform.quaternion.w,
        },
      };
    }
  }

  let rb: RigidBodyAPI | undefined;
  if (rigidBodyParams) {
    rb = isWorkerThread
      ? await createRigidBody(rigidBodyParams)
      : createRigidBodySync(rigidBodyParams);
  }

  const paramsArray = Array.isArray(colliderParams) ? colliderParams : [colliderParams];
  // The legacy system auto-derived a primitive collider's dimensions from its target mesh's
  // geometry whenever the caller didn't specify them explicitly (a ground box created as
  // { type: 'BOX' } against a 200x0.2x200 mesh got a 200x0.2x200 collider "for free"). The new
  // Physics API never grew that fallback — a collider created without explicit hx/hy/hz/radius/
  // halfHeight silently defaults to Rapier's own bare 0.5-ish shape default regardless of the
  // mesh's actual size, which is how a huge visual floor/platform ends up with a tiny invisible
  // collider (or none reachable) and characters fall straight through. This can only run here,
  // main-thread-side, before the params cross the WORKER_THREAD postMessage boundary — a
  // THREE.Mesh/BufferGeometry can't be structured-cloned to derive this worker-side.
  const targetMeshForDerivation =
    object3D ?? world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  for (let i = 0; i < paramsArray.length; i++) {
    paramsArray[i] = deriveColliderDimensionsFromMesh(paramsArray[i], targetMeshForDerivation);
  }
  if (rb) for (const p of paramsArray) p.parentId = rb.id;
  const colls = paramsArray.length
    ? isWorkerThread
      ? await createColliders(paramsArray)
      : createCollidersSync(paramsArray)
    : [];

  // Primes the worker proxy's cached mass (only known once the colliders exist), so even the
  // very first applyImpulse on this body can be reflected in its read-your-writes linvel.
  if (isWorkerThread && rb && rigidBodyParams?.rigidType === 'DYNAMIC') {
    void rb.mass().catch(() => {});
  }

  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (rb) {
    transform?.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform?.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
  } else if (object3D) {
    transform?.position.copy(object3D.position);
    transform?.quaternion.copy(object3D.quaternion);
    transform?.scale.copy(object3D.scale);
  }
  // Persists the in-place mutation above for TYPED_ARRAY storage mode too
  // (ECS.ts's commitTransform doc comment: MAP mode returns a live reference
  // and doesn't strictly need this, TYPED_ARRAY mode does).
  if (transform) world.commitTransform(entityId, transform);

  if (object3D) {
    if (transform) {
      object3D.position.copy(transform.position);
      object3D.quaternion.copy(transform.quaternion);
      object3D.scale.copy(transform.scale);
      object3D.userData._lastVersion = transform.version;
    }
    world.addComponent(entityId, ComponentType.OBJECT3D, { value: object3D, _lastVersion: -1 });
    // A raw Object3D handed in as `target` (eg. a mesh taken straight off a loaded glTF's
    // children, never through createMeshEntity) may have no parent yet — createMeshEntity's own callers get this
    // for free, but this path doesn't, so without it the object becomes this entity's OBJECT3D
    // component and gets correctly positioned, yet never actually renders (no parent = not part
    // of any scene graph). Mirrors createMeshEntity's own default (rootScene.add unless opted out).
    // Always reparent onto the root scene (THREE.Object3D.add() removes from any existing
    // parent first, so this is a safe no-op for an object already correctly parented there —
    // e.g. one already created via createMeshEntity). This has to be unconditional, not just
    // "if it has no parent yet": a mesh taken off a loaded glTF's temporary root group DOES
    // have a parent (that throwaway group), just not one connected to the real scene graph —
    // checking parent-ness alone would wrongly treat it as already placed.
    if (!entityOpts?.doNotAddToScene) {
      existsOrThrow(getRootScene(), 'Could not find root scene in createPhysicsEntity.').add(
        object3D
      );
    }
  }

  world.addComponent(entityId, ComponentType.COLLIDER, colls);

  const hasVisual = world.hasComponent(entityId, ComponentType.OBJECT3D);
  const isStatic = !rb || rigidBodyParams?.rigidType === 'FIXED';
  if (isStatic) {
    if (rb) world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
  } else {
    const bucket = hasVisual
      ? ComponentType.BODY_DYNAMIC_VISUAL
      : ComponentType.BODY_DYNAMIC_HEADLESS;
    world.addComponent(entityId, bucket, rb!);
  }

  return entityId;
};

export const disposePhysicsEntity = async (entityId: number, world: ECSWorld) => {
  const rb = world.getRigidBody(entityId);
  const colls = world.getComponent(entityId, ComponentType.COLLIDER);
  if (colls) await deleteColliders(colls.map((c) => c.id));
  if (rb) await deleteRigidBody(rb.id);
};

export const getPhysicsEntityByAppId = (appId: string) => getEntityIdByAppId(appId);

/** Deletes every physics-tagged entity in the given world (or the default one) — the
 * scene-agnostic catch-all legacy's deleteAllPhysicsObjects() was, for callers like
 * SceneLoader.ts's "wipe everything before loading the next scene" step. Most physics entities
 * already get cleaned up as a side effect of deleteScene()'s mesh/group traversal (via
 * TAG_IS_PHYSICS_OBJECT's onDeleteEntity hook), but a meshless physics-only entity has no mesh
 * or group for that traversal to ever find, so it needs this separate sweep. */
export const deleteAllPhysicsEntities = (ecsWorld?: ECSWorld) => {
  const world = ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world.');
  const ids = [...world.getEntitiesWith(ComponentType.TAG_IS_PHYSICS_OBJECT)];
  for (const id of ids) world.deleteEntity(id);
};

// [pos xyz, quat xyzw] scratch every body's pose is read into — Float64 so TRANSFORM gets the
// exact values, and one readPoseInto() per body instead of 7 object-allocating pos/rot reads.
const transformSyncPose = new Float64Array(7);

/**
 * Update transform from physics
 */
export const physicsToTransformSystem = (world: ECSWorld) => {
  const transformStore = world.getTypedTransformStore();

  const syncStorage = (storage: IComponentStorage<RigidBodyAPI>) => {
    // keys() + get(): destructuring the storage's own iterator allocates a [key, value] array
    // per entry, per frame.
    for (const entityId of storage.keys()) {
      const rb = storage.get(entityId)!;
      if (transformStore) {
        const slot = transformStore.getSlot(entityId);
        if (slot === -1) continue;
        const p = transformSyncPose;
        rb.readPoseInto(p);
        transformStore.setPosition(slot, p[0], p[1], p[2]);
        transformStore.setQuaternion(slot, p[3], p[4], p[5], p[6]);
        continue;
      }

      const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
      if (!transform) continue;

      const p = transformSyncPose;
      rb.readPoseInto(p);
      transform.position.set(p[0], p[1], p[2]);
      transform.quaternion.set(p[3], p[4], p[5], p[6]);

      // Mark as changed so the Render System knows to update the Mesh
      transform.setDirty();
    }
  };

  // Dynamic/kinematic bodies move every step, so this cost is expected. FIXED bodies (BODY_STATIC)
  // don't move under simulation, but CAN be explicitly repositioned after creation (e.g. an
  // imported level piece snapped into its final place once) — without also syncing this bucket,
  // that reposition would update the physics body (confirmed via getRigidBody(id).pos) but never
  // reach the mesh, leaving it visually stuck at its creation-time transform. Matches
  // physicsWorker.ts's writeBackTransforms() writing all body types for the same reason — the
  // per-step cost of re-copying a handful of unchanging static transforms is negligible next to
  // the physics step itself.
  syncStorage(world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL));
  syncStorage(world.getStorage(ComponentType.BODY_STATIC));
};

// --- Render interpolation (p059) ------------------------------------------------------------
//
// Every rendered pose is a monotone render clock, measured in simulated fixed steps, evaluated
// against the last three snapshots, whose endpoints carry the step index they describe:
//   alpha = (renderClock - prevStep) / (currStep - prevStep)
// The two modes run identical blend math and differ only in where the render clock comes from:
// - 'FIXED_PHYSICS' (open-loop): renderClock = simClock - delay, straight from the stepper.
//   Exact, but only valid when snapshots are visible in the frame they are issued (MAIN_THREAD).
// - 'RENDERER' (closed-loop): renderClock only ever advances by the stepper's own per-frame
//   advance, slightly sped up/slowed down (never displaced) toward a target anchored on every
//   newly visible snapshot. Worker latency is never estimated — it ends up as a constant lag.
// On MAIN_THREAD the target sits exactly on the FIXED_PHYSICS clock, so both modes converge.

/** Poses kept per entity (oldest → newest). Three, not two: under jitter the render clock can
 * legitimately fall before the previous snapshot, and two slots would clamp/stall there. */
const HISTORY_SLOTS = 3;
/** Floats per history slot: position xyz + (normalized) quaternion xyzw. */
const POSE_FLOATS = 7;
/** How many recent snapshot intervals the delay is the max of (~0.5s at 60 snapshots/s). */
const DELAY_WINDOW = 32;
/** Max render-clock speed-up/slow-down (and delay slew) relative to the simulation: a 15%
 * velocity error on a moving object is invisible, a position jump is not. */
const MAX_RATE_DEVIATION = 0.15;
/** Time constant (simulated seconds) of the RENDERER servo's lag correction. */
const SERVO_TIME_CONSTANT = 0.5;
/** Extra RENDERER delay under WORKER_THREAD, as a fraction of the delay, absorbing snapshot
 * arrival jitter (dominated by when the main thread gets around to reading). */
const JITTER_MARGIN_RATIO = 0.5;
/** RENDERER re-anchors outright (instead of servoing) once off by more than this many delays. */
const HARD_RESET_ERROR_RATIO = 4;
/** A quaternion shorter than this is no valid pose yet (e.g. rb.rot before the first snapshot
 * reads all zeros) — the entity is skipped rather than slerping NaN into its matrix. */
const MIN_QUAT_LENGTH_SQ = 1e-6;
const NO_SNAPSHOT = -1;

type InterpolationHistory = {
  /** HISTORY_SLOTS × POSE_FLOATS, oldest → newest, mutated in place. */
  poses: Float32Array;
  /** Step index of the snapshot the newest slot was captured at. Anything but the world
   * state's previous `lastStep` when a new snapshot arrives means this entity missed one (new,
   * disabled, skipped) — its history has a hole and gets reseeded instead of shifted. */
  capturedAt: number;
  /** Set by an explicit pose reset (setTransform/teleport): until a snapshot stamped at least
   * this step is visible, no snapshot reflects the new pose yet, so snapPose is shown as-is and
   * nothing is captured. 0 = not snapping. */
  snapUntilStep: number;
  /** The reset pose (POSE_FLOATS), allocated on the entity's first reset. */
  snapPose: Float32Array | null;
};

/** Live values for the Physics API debug tab, mutated in place (never reallocated). */
export type PhysicsInterpolationReadout = {
  /** Render clock behind the stepper's clock (ms of simulated time). */
  lagMs: number;
  /** Render clock speed relative to the simulation over the last frame (1 = nominal). */
  rate: number;
  /** Current (slewed) delay D (ms) — the max recent snapshot interval. */
  delayMs: number;
  /** Most recently measured snapshot interval (ms). */
  intervalMs: number;
  /** RENDERER: target minus render clock (ms); 0 for FIXED_PHYSICS. */
  errorMs: number;
  /** Hard resets (re-anchors) since boot. */
  resets: number;
};

type WorldInterpolationState = {
  histories: Map<number, InterpolationHistory>;
  /** Step index of each history slot, oldest → newest. Shared by the whole world — every
   * entity captures on the same snapshots, and a reseeded history holds one pose in all slots,
   * so its stamps don't matter. */
  stamps: Float64Array;
  /** Step index of the newest snapshot captured (NO_SNAPSHOT: none yet). */
  lastStep: number;
  clockEpoch: number;
  historyEpoch: number;
  mode: PhysicsInterpolationMode | null;
  timestepRatio: number;
  lastSimClock: number;
  /** Slewed D, in steps. */
  delay: number;
  intervals: Int32Array;
  intervalIndex: number;
  wasLastIntervalOutlier: boolean;
  /** RENDERER only. */
  renderClock: number;
  targetClock: number;
  hasTarget: boolean;
  isClockAnchored: boolean;
  readout: PhysicsInterpolationReadout;
};

// Per world: entity ids (and so history keys) are only unique within one world.
const worldInterpolationStates = new WeakMap<ECSWorld, WorldInterpolationState>();

const getWorldInterpolationState = (world: ECSWorld) => {
  let state = worldInterpolationStates.get(world);
  if (!state) {
    state = {
      histories: new Map(),
      stamps: new Float64Array(HISTORY_SLOTS),
      lastStep: NO_SNAPSHOT,
      clockEpoch: -1,
      historyEpoch: -1,
      mode: null,
      timestepRatio: 0,
      lastSimClock: 0,
      delay: 1,
      intervals: new Int32Array(DELAY_WINDOW).fill(1),
      intervalIndex: 0,
      wasLastIntervalOutlier: false,
      renderClock: 0,
      targetClock: 0,
      hasTarget: false,
      isClockAnchored: false,
      readout: { lagMs: 0, rate: 1, delayMs: 0, intervalMs: 0, errorMs: 0, resets: 0 },
    };
    worldInterpolationStates.set(world, state);
  }
  return state;
};

/** Throws away every pose history (they'll reseed on their next capture). Rare — world
 * replaced / snapshot restored — so the per-entity walk is fine. */
const resetInterpolationHistory = (state: WorldInterpolationState) => {
  for (const history of state.histories.values()) {
    history.capturedAt = NO_SNAPSHOT;
    history.snapUntilStep = 0; // a stale target from the previous timeline could never be reached
  }
  state.lastStep = NO_SNAPSHOT;
  state.intervals.fill(1);
  state.wasLastIntervalOutlier = false;
  state.hasTarget = false;
  state.isClockAnchored = false;
};

/** Live interpolation clock values of `world`, for the debug tab. Stable object, updated every
 * frame the interpolation system runs in an interpolating mode. */
export const getPhysicsInterpolationReadout = (world: ECSWorld) =>
  getWorldInterpolationState(world).readout;

const snapshotStamp = { step: 0, phase: 0 };
const scratchQuatA = new THREE.Quaternion();
const scratchQuatB = new THREE.Quaternion();
// Checked here rather than at initPhysics() so it also catches a mode restored from
// localStorage or switched live from the Physics API debug tab.
let hasWarnedInvalidInterpolationPairing = false;

/** Writes rb's current pose into history slot `slot`, normalizing the quaternion at capture
 * (Float32 round-trips drift off unit length, and slerp assumes unit inputs). */
/** [pos xyz, quat xyzw] every capture is read into (rb.readPoseInto, no per-read allocation). */
const capturePose = new Float64Array(POSE_FLOATS);

/** Normalizes capturePose's quaternion in place — at capture, since Float32 round-trips drift
 * off unit length and slerp assumes unit inputs. False when it is no valid pose yet (a (near)
 * zero quaternion, e.g. rb.rot before the first snapshot): the caller must skip the entity
 * rather than slerp NaN into its matrix. */
const normalizeCapturePose = (): boolean => {
  const p = capturePose;
  const quatLengthSq = p[3] * p[3] + p[4] * p[4] + p[5] * p[5] + p[6] * p[6];
  if (quatLengthSq < MIN_QUAT_LENGTH_SQ) return false;
  const invQuatLength = 1 / Math.sqrt(quatLengthSq);
  p[3] *= invQuatLength;
  p[4] *= invQuatLength;
  p[5] *= invQuatLength;
  p[6] *= invQuatLength;
  return true;
};

/** Copies capturePose into history slot `slot`. */
const writeHistorySlot = (poses: Float32Array, slot: number) => {
  const o = slot * POSE_FLOATS;
  for (let i = 0; i < POSE_FLOATS; i++) poses[o + i] = capturePose[i];
};

const createInterpolationHistory = (): InterpolationHistory => ({
  poses: new Float32Array(HISTORY_SLOTS * POSE_FLOATS),
  capturedAt: NO_SNAPSHOT,
  snapUntilStep: 0,
  snapPose: null,
});

// Explicit pose resets (setTransform/teleport) are discontinuities: without this the history
// would blend from the old position to the new one — a visible streak across the jump. The
// history isn't reseeded here: under WORKER_THREAD rb.pos is still the not-yet-stepped pending
// value, and stamping it with the latest snapshot's step would place it at a simulated time it
// doesn't belong to. The reset pose is shown as-is instead until a later-stamped snapshot lands.
ECSWorld.registerTransformResetListener((world, entityId) => {
  if (!world.hasComponent(entityId, ComponentType.BODY_DYNAMIC_VISUAL)) return;
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (!transform) return;
  const state = getWorldInterpolationState(world);
  let history = state.histories.get(entityId);
  if (!history) {
    history = createInterpolationHistory();
    state.histories.set(entityId, history);
  }
  const { position: pos, quaternion: q } = transform;
  capturePose[0] = pos.x;
  capturePose[1] = pos.y;
  capturePose[2] = pos.z;
  capturePose[3] = q.x;
  capturePose[4] = q.y;
  capturePose[5] = q.z;
  capturePose[6] = q.w;
  if (!normalizeCapturePose()) return;
  history.snapPose ??= new Float32Array(POSE_FLOATS);
  writeHistorySlot(history.snapPose, 0);
  history.snapUntilStep = getPhysicsWriteVisibleStep();
});

/**
 * Render-only smoothing on top of the discrete physics-step pose: writes the blended pose only
 * into the Object3D — TRANSFORM stays the authoritative, non-interpolated pose for gameplay
 * code (collision queries, AI, etc.). No-ops entirely for 'NONE', leaving object3DSyncSystem's
 * own MAIN-stage sync as the sole writer. See the section comment above for the clock model.
 */
export const physicsInterpolationSystem = (world: ECSWorld) => {
  const physicsState = getPhysicsState();
  const mode = physicsState.interpolationMode;
  if (mode === 'NONE') return;
  // Reserved, not implemented (p024 feasibility study).
  if (mode === 'EXTRAPOLATION') return;

  if (
    IS_DEBUG_ENV &&
    !hasWarnedInvalidInterpolationPairing &&
    mode === 'FIXED_PHYSICS' &&
    physicsState.workerTarget === 'WORKER_THREAD'
  ) {
    hasWarnedInvalidInterpolationPairing = true;
    lwarn(
      "interpolationMode 'FIXED_PHYSICS' is not valid with workerTarget 'WORKER_THREAD': its clock comes from the main thread's accumulator, but the snapshots arrive asynchronously from the worker, later than that clock assumes, so the pose freezes and jumps. Use 'RENDERER' for WORKER_THREAD (see docs/plans/p059_interpolation-optimization-and-fixes.md)."
    );
  }

  const state = getWorldInterpolationState(world);
  const timestepRatio = physicsState.timestepRatio;

  // --- Reset events (snap and re-anchor, no servoing) ---
  let resetClock = false;
  const historyEpoch = getPhysicsSimHistoryEpoch();
  if (state.historyEpoch !== historyEpoch) {
    state.historyEpoch = historyEpoch;
    resetInterpolationHistory(state);
    resetClock = true;
  }
  if (state.mode !== mode) {
    // The mode may have been 'NONE' until now, during which nothing here ran: the snapshot
    // tracking is stale (its next interval would span the whole gap).
    if (state.mode !== null) resetInterpolationHistory(state);
    state.mode = mode;
    resetClock = true;
  }
  const clockEpoch = getPhysicsSimClockEpoch();
  if (state.clockEpoch !== clockEpoch || state.timestepRatio !== timestepRatio) {
    state.clockEpoch = clockEpoch;
    state.timestepRatio = timestepRatio;
    resetClock = true;
  }

  // --- Newly visible snapshot? (identified by the step index it was stamped with) ---
  let prevStep = state.lastStep;
  let isNewSnapshot = false;
  if (readPhysicsSnapshotStamp(snapshotStamp) && snapshotStamp.step !== state.lastStep) {
    isNewSnapshot = true;
    const newestStep = state.stamps[HISTORY_SLOTS - 1];
    if (prevStep === NO_SNAPSHOT || snapshotStamp.step <= newestStep) {
      // First snapshot of a timeline (or one that doesn't follow the last): nothing to
      // interpolate from yet.
      if (prevStep !== NO_SNAPSHOT) resetInterpolationHistory(state);
      prevStep = NO_SNAPSHOT;
      state.stamps.fill(snapshotStamp.step);
      resetClock = true;
    } else {
      const interval = snapshotStamp.step - newestStep;
      const isOutlier = interval > HARD_RESET_ERROR_RATIO * state.delay;
      if (isOutlier && !state.wasLastIntervalOutlier) {
        // A one-off hitch (or a stall in delivery), not a cadence: snap past it rather than
        // stretching D — and so the lag — for the whole window.
        resetClock = true;
      } else {
        // Two in a row is a new cadence (e.g. the render rate dropped well below the physics
        // rate): adopt it at once.
        if (isOutlier) resetClock = true;
        state.intervals[state.intervalIndex] = interval;
        state.intervalIndex = (state.intervalIndex + 1) % DELAY_WINDOW;
      }
      state.wasLastIntervalOutlier = isOutlier;
      state.stamps.copyWithin(0, 1);
      state.stamps[HISTORY_SLOTS - 1] = snapshotStamp.step;
    }
    state.lastStep = snapshotStamp.step;
  }
  if (state.lastStep === NO_SNAPSHOT) return; // nothing stamped yet — leave the MAIN sync pose

  // --- Delay D: one snapshot interval, measured (max over the recent window, so alternating
  // intervals are extra-delayed on the short ones instead of clamping on the long ones) ---
  let maxInterval = 1;
  for (let i = 0; i < DELAY_WINDOW; i++) {
    if (state.intervals[i] > maxInterval) maxInterval = state.intervals[i];
  }
  const simClock = getPhysicsSimClock();
  const simAdvance = resetClock ? 0 : Math.max(0, simClock - state.lastSimClock);
  state.lastSimClock = simClock;
  if (resetClock) {
    state.delay = maxInterval;
  } else {
    const maxSlew = MAX_RATE_DEVIATION * simAdvance;
    state.delay += Math.min(maxSlew, Math.max(-maxSlew, maxInterval - state.delay));
  }

  // --- Render clock ---
  const prevRenderClock = state.renderClock;
  let error = 0;
  if (mode === 'FIXED_PHYSICS') {
    state.renderClock = simClock - state.delay;
  } else {
    const margin =
      physicsState.workerTarget === 'WORKER_THREAD' ? JITTER_MARGIN_RATIO * maxInterval : 0;
    if (isNewSnapshot) {
      // Where the render clock belongs at the moment this snapshot becomes visible: its step
      // plus the clock phase it was issued at (on MAIN_THREAD that is exactly simClock now).
      state.targetClock = snapshotStamp.step + snapshotStamp.phase - state.delay - margin;
      state.hasTarget = true;
    } else {
      state.targetClock += simAdvance;
    }

    if (!state.hasTarget) {
      state.renderClock = state.stamps[HISTORY_SLOTS - 1];
      state.isClockAnchored = false;
    } else if (resetClock || !state.isClockAnchored) {
      state.renderClock = state.targetClock;
      state.isClockAnchored = true;
      state.readout.resets++;
    } else {
      // Against where the clock lands this frame at nominal rate — the target has already
      // been advanced by this frame's simAdvance above.
      const nominalRenderClock = state.renderClock + simAdvance;
      error = state.targetClock - nominalRenderClock;
      if (Math.abs(error) > HARD_RESET_ERROR_RATIO * maxInterval) {
        state.renderClock = state.targetClock;
        state.readout.resets++;
      } else {
        // Time dilation, never displacement: the correction is bounded by a fraction of this
        // frame's own advance, so the clock is monotone and the pose continuous.
        const maxCorrection = MAX_RATE_DEVIATION * simAdvance;
        const gain = Math.min(1, (simAdvance * timestepRatio) / SERVO_TIME_CONSTANT);
        const correction = Math.min(maxCorrection, Math.max(-maxCorrection, error * gain));
        state.renderClock = nominalRenderClock + correction;
      }
    }
  }
  const renderClock = state.renderClock;

  const toMs = timestepRatio * 1000;
  const readout = state.readout;
  readout.lagMs = (simClock - renderClock) * toMs;
  if (simAdvance > 0) readout.rate = (renderClock - prevRenderClock) / simAdvance;
  readout.delayMs = state.delay * toMs;
  readout.intervalMs =
    state.intervals[(state.intervalIndex + DELAY_WINDOW - 1) % DELAY_WINDOW] * toMs;
  readout.errorMs = error * toMs;

  // --- Segment (shared by every entity: same stamps) ---
  const stamps = state.stamps;
  let slotA = 0;
  let slotB = 0;
  let alpha = 0;
  if (renderClock >= stamps[2]) {
    slotA = slotB = 2;
  } else if (renderClock >= stamps[1]) {
    slotA = 1;
    slotB = 2;
    alpha = (renderClock - stamps[1]) / (stamps[2] - stamps[1]);
  } else if (renderClock >= stamps[0]) {
    slotB = 1;
    alpha = (renderClock - stamps[0]) / (stamps[1] - stamps[0]);
  } // else: before the oldest snapshot — freeze on it rather than reverse (alpha stays 0)

  const a = slotA * POSE_FLOATS;
  const b = slotB * POSE_FLOATS;
  const dynamicVisuals = world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL);
  for (const entityId of dynamicVisuals.keys()) {
    if (world.isDisabled(entityId)) continue;
    const rb = dynamicVisuals.get(entityId)!;
    const obj3D = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
    if (!obj3D) continue;

    let history = state.histories.get(entityId);
    if (history && history.snapUntilStep > 0) {
      if (state.lastStep < history.snapUntilStep) {
        const p = history.snapPose!;
        obj3D.position.set(p[0], p[1], p[2]);
        obj3D.quaternion.set(p[3], p[4], p[5], p[6]);
        continue;
      }
      // The first snapshot that includes the reset: start the history over from it.
      history.snapUntilStep = 0;
      history.capturedAt = NO_SNAPSHOT;
    }
    if (!history || history.capturedAt !== state.lastStep) {
      rb.readPoseInto(capturePose);
      if (!normalizeCapturePose()) continue;
      if (!history) {
        history = createInterpolationHistory();
        state.histories.set(entityId, history);
      }
      const poses = history.poses;
      if (isNewSnapshot && prevStep !== NO_SNAPSHOT && history.capturedAt === prevStep) {
        poses.copyWithin(0, POSE_FLOATS);
        writeHistorySlot(poses, HISTORY_SLOTS - 1);
      } else {
        // Hole in the history (new, re-enabled, skipped, or reset): reseed every slot with the
        // current pose, which makes this frame (and the history) snap to it.
        for (let slot = 0; slot < HISTORY_SLOTS; slot++) {
          writeHistorySlot(poses, slot);
        }
      }
      history.capturedAt = state.lastStep;
    }

    const poses = history.poses;
    const invAlpha = 1 - alpha;
    obj3D.position.set(
      poses[a] * invAlpha + poses[b] * alpha,
      poses[a + 1] * invAlpha + poses[b + 1] * alpha,
      poses[a + 2] * invAlpha + poses[b + 2] * alpha
    );
    scratchQuatA.set(poses[a + 3], poses[a + 4], poses[a + 5], poses[a + 6]);
    scratchQuatB.set(poses[b + 3], poses[b + 4], poses[b + 5], poses[b + 6]);
    obj3D.quaternion.copy(scratchQuatA.slerp(scratchQuatB, alpha));
  }
};
