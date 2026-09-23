import * as THREE from 'three/webgpu';

import { ECSSystemStage } from '../../AppECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { lerror } from '../utils/Logger';
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
  getPhysicsInterpolationAlpha,
  getPhysicsState,
} from './PhysicsAPI';
import { ColliderParams, RigidBodyAPI, RigidBodyParams } from './Physics/PhysicsAPITypes';
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
 * CONVEXHULL/HEIGHTFIELD/compound imports already get their own dedicated derivation in
 * ImportModel.ts's deriveMeshDependentColliderFields, which runs before this ever sees them). */
const deriveColliderDimensionsFromMesh = (
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
      interpolationStates.delete(entityId);
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
    physicsInterpolationSystem
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
    // A raw Object3D handed in as `target` (e.g. importMultiplePhysicsObjects's compound-collider
    // "keepMesh" case, which resolves its target mesh straight off the loaded glTF's children,
    // never through createMeshEntity) has no parent yet — createMeshEntity's own callers get this
    // for free, but this path doesn't, so without it the object becomes this entity's OBJECT3D
    // component and gets correctly positioned, yet never actually renders (no parent = not part
    // of any scene graph). Mirrors createMeshEntity's own default (rootScene.add unless opted out).
    // Always reparent onto the root scene (THREE.Object3D.add() removes from any existing
    // parent first, so this is a safe no-op for an object already correctly parented there —
    // e.g. one already created via createMeshEntity). This has to be unconditional, not just
    // "if it has no parent yet": importMultiplePhysicsObjects's compound-collider "keepMesh"
    // case resolves its target mesh straight off the loaded glTF's temporary root group, which
    // DOES give it a parent (that throwaway group), just not one connected to the real scene
    // graph — checking parent-ness alone would wrongly treat it as already placed.
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

/**
 * Update transform from physics
 */
export const physicsToTransformSystem = (world: ECSWorld) => {
  const transformStore = world.getTypedTransformStore();

  const syncStorage = (storage: IComponentStorage<RigidBodyAPI>) => {
    for (const [entityId, rb] of storage) {
      if (transformStore) {
        const slot = transformStore.getSlot(entityId);
        if (slot === -1) continue;
        // Direct SAB access from your Physics Proxy
        transformStore.setPosition(slot, rb.pos.x, rb.pos.y, rb.pos.z);
        transformStore.setQuaternion(slot, rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
        continue;
      }

      const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
      if (!transform) continue;

      // Direct SAB access from your Physics Proxy
      transform.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
      transform.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);

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

type InterpolationState = {
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  /** performance.now() timestamps of when prev/curr were captured — only used by
   * 'RENDERER' mode's wall-clock-based alpha; 'FIXED_PHYSICS' uses the physics
   * accumulator's own alpha instead (getPhysicsInterpolationAlpha()). */
  prevTime: number;
  currTime: number;
};

// Per-entity interpolation history, keyed by entity id — allocated once per entity (on
// first sight) and mutated in place every frame, matching PhysicsTransformBuffer's
// zero-per-frame-allocation hot path. Cleaned up in registerPhysicsManager's
// onDeleteEntity hook.
const interpolationStates = new Map<number, InterpolationState>();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

/**
 * Render-only smoothing on top of the discrete physics-step pose (Design Decision 4 of
 * docs/plans/p024_interpolation-in-the-physics-api.md): reads the same live rb.pos/rb.rot
 * physicsToTransformSystem already wrote into ECS TRANSFORM this frame, but writes the
 * blended pose only into the Object3D — TRANSFORM stays the authoritative, non-interpolated
 * pose for gameplay code (collision queries, AI, etc.). No-ops entirely for 'NONE' (the
 * default), leaving today's behavior — including object3DSyncSystem's own MAIN-stage sync —
 * completely untouched.
 */
export const physicsInterpolationSystem = (world: ECSWorld) => {
  const mode = getPhysicsState().interpolationMode;
  if (mode !== 'RENDERER' && mode !== 'FIXED_PHYSICS') return;

  const dynamicVisuals = world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL);
  const now = performance.now();
  const fixedAlpha = mode === 'FIXED_PHYSICS' ? getPhysicsInterpolationAlpha() : 0;

  for (const [entityId, rb] of dynamicVisuals) {
    const obj3D = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
    if (!obj3D) continue;

    let state = interpolationStates.get(entityId);
    if (!state) {
      state = {
        prevPos: new THREE.Vector3(rb.pos.x, rb.pos.y, rb.pos.z),
        prevQuat: new THREE.Quaternion(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w),
        currPos: new THREE.Vector3(rb.pos.x, rb.pos.y, rb.pos.z),
        currQuat: new THREE.Quaternion(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w),
        prevTime: now,
        currTime: now,
      };
      interpolationStates.set(entityId, state);
    } else if (
      state.currPos.x !== rb.pos.x ||
      state.currPos.y !== rb.pos.y ||
      state.currPos.z !== rb.pos.z ||
      state.currQuat.x !== rb.rot.x ||
      state.currQuat.y !== rb.rot.y ||
      state.currQuat.z !== rb.rot.z ||
      state.currQuat.w !== rb.rot.w
    ) {
      // A new physics step's result became visible since we last looked (works the same
      // way for MAIN_THREAD's always-fresh reads and WORKER_THREAD's SAB/MESSAGE_BATCH
      // reads — this is "received", not "stepped", which is exactly Design Decision 3's
      // Option A: decoupled from physics cadence).
      state.prevPos.copy(state.currPos);
      state.prevQuat.copy(state.currQuat);
      state.prevTime = state.currTime;
      state.currPos.set(rb.pos.x, rb.pos.y, rb.pos.z);
      state.currQuat.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
      state.currTime = now;
    }

    let alpha: number;
    if (mode === 'FIXED_PHYSICS') {
      alpha = fixedAlpha;
    } else {
      const interval = state.currTime - state.prevTime;
      alpha = interval > 0 ? Math.min(1, Math.max(0, (now - state.currTime) / interval)) : 1;
    }

    scratchPos.copy(state.prevPos).lerp(state.currPos, alpha);
    scratchQuat.copy(state.prevQuat).slerp(state.currQuat, alpha);
    obj3D.position.copy(scratchPos);
    obj3D.quaternion.copy(scratchQuat);
  }
};
