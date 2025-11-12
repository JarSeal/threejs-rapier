import * as THREE from 'three/webgpu';
import type Rapier from '@dimforge/rapier3d-compat';
import { lerror, llog, lwarn } from '../utils/Logger';
import { getCurrentSceneId, getRootScene, getScene, isCurrentScene } from './Scene';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getConfig, isDebugEnvironment } from './Config';
import { createDebuggerTab, createNewDebuggerPane } from '../debug/DebuggerGUI';
import { getMesh } from './Mesh';
import { Pane } from 'tweakpane';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { updatePhysicsPanel } from '../debug/Stats';
import { updateOnScreenTools } from '../debug/OnScreenTools';
import { existsOrThrow, existsOrWarn, slerp, ThreeVector3 } from '../utils/helpers';
import { CMP, TCMP } from '../utils/CMP';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  updateDraggableWindow,
} from './UI/DraggableWindow';
import { LoopState } from './MainLoop';
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';

type CollisionEventFn = (
  collider1: Collider,
  collider2: Collider,
  started: boolean,
  physObj1: PhysicsObject,
  physObj2: PhysicsObject
) => void;

type ContactForceEventFn = (
  event: Rapier.TempContactForceEvent,
  physObj1: PhysicsObject,
  physObj2: PhysicsObject
) => void;

export type PhysicsObject = {
  id: string;
  name?: string;
  mesh?: THREE.Mesh;
  meshes?: THREE.Mesh[];
  collider: Rapier.Collider | Rapier.Collider[];
  rigidBody?: Rapier.RigidBody;
  collisionEventFn?: CollisionEventFn | CollisionEventFn[];
  contactForceEventFn?: ContactForceEventFn | ContactForceEventFn[];
  currentObjectIndex?: number;
  currentMeshIndex?: number;
  setTranslation: (translation: { x?: number; y?: number; z?: number }) => void;
};

export type ColliderParams = (
  | {
      type: 'CUBOID' | 'BOX';
      hx?: number;
      hy?: number;
      hz?: number;
      borderRadius?: number;
    }
  | {
      type: 'BALL' | 'SPHERE';
      radius?: number;
    }
  | {
      type: 'CAPSULE' | 'CONE' | 'CYLINDER';
      halfHeight?: number;
      radius?: number;
      borderRadius?: number;
    }
  | {
      type: 'TRIANGLE';
      a: Rapier.Vector3;
      b: Rapier.Vector3;
      c: Rapier.Vector3;
      borderRadius?: number;
    }
  | {
      type: 'TRIMESH';
      vertices?: Float32Array;
      indices?: Uint32Array;
    }
) & {
  /** Mass (default 1.0) */
  density?: number;

  /** Translation (position), only has affect if there is no rigid body */
  translation?: { x: number; y: number; z: number };

  /** Rotation (position) in quaternion, only has affect if there is no rigid body */
  rotation?: { x: number; y: number; z: number; w: number };

  /** Object's friction value, usually between 0 to 1 but can me more (default is @TODO: find out default) */
  friction?: number;

  /** How two colliding objects apply friction (default AVERAGE). The following precedence is used: MAX > MULTIPLY > MIN > AVERAGE. */
  frictionCombineRule?: 'MAX' | 'MULTIPLY' | 'MIN' | 'AVERAGE';

  /** Object restitution (bounce) value, usually between 0 to 1 but can me more (default is @TODO: find out default) */
  restitution?: number;

  /** How two colliding objects apply restitution (default AVERAGE). The following precedence is used: MAX > MULTIPLY > MIN > AVERAGE. */
  restitutionCombineRule?: 'MAX' | 'MULTIPLY' | 'MIN' | 'AVERAGE';

  /** Whether the collider is a sensor or not */
  isSensor?: boolean;

  /** Enables collision events, if collisionEventFn is defined this is enabled automatically */
  enableCollisionActiveEvents?: boolean;

  /** Enables collision events, if collisionEventFn is defined this is enabled automatically */
  enableContactForceActiveEvents?: boolean;

  /** Creates a collision event callback, automatically sets enableCollisionActiveEvents to true for the collider */
  collisionEventFn?: (
    collider1: Collider,
    collider2: Collider,
    started: boolean,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;

  /** Creates a contact force event callback, automatically sets enableContactForceActiveEvents to true for the collider */
  contactForceEventFn?: (
    e: Rapier.TempContactForceEvent,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;
};

export type RigidBodyParams = {
  /** Type of rigid body */
  rigidType: 'FIXED' | 'DYNAMIC' | 'POS_BASED' | 'VELO_BASED';

  /** Translation (position) */
  translation?: { x: number; y: number; z: number };

  /** Rotation (position) in quaternion */
  rotation?: { x: number; y: number; z: number; w: number };

  /** Linear (translation) velocity */
  linvel?: { x: number; y: number; z: number };

  /** Angular (rotation) velocity */
  angvel?: { x: number; y: number; z: number };

  /** Gravity scale */
  gravityScale?: number;

  /** Force to be applied (constant force) */
  force?: { x: number; y: number; z: number };

  /** Torque force to be applied (constant force) */
  torqueForce?: { x: number; y: number; z: number };

  /** Force at point to be applied (constant force) */
  forceAtPoint?: {
    force: { x: number; y: number; z: number };
    point: { x: number; y: number; z: number };
  };

  /** Impulse force to be applied */
  impulse?: { x: number; y: number; z: number };

  /** Impulse torque force to be applied */
  torqueImpulse?: { x: number; y: number; z: number };

  /** Impulse at point to be applied (constant force) */
  impulseAtPoint?: {
    force: { x: number; y: number; z: number };
    point: { x: number; y: number; z: number };
  };

  /** Translation locks */
  lockTranslations?: { x: boolean; y: boolean; z: boolean };

  /** Rotation locks */
  lockRotations?: { x: boolean; y: boolean; z: boolean };

  /** Linear damping (slowing down of movement, eg. air friction) */
  linearDamping?: number;

  /** Angular damping (slowing down of rotation, eg. air friction) */
  angularDamping?: number;

  /** Dominance group, from -127 to 127 (default 0) */
  dominance?: number;

  /** Continuous Collision Detection (CCD) enabled (default false) */
  ccdEnabled?: boolean;

  /** Soft CCD prediction distance */
  softCcdDistance?: number;

  /** Whether the body should be waken up or not (default true) */
  wakeUp?: boolean;

  /** User data to be added to the rigid body */
  userData?: { [key: string]: unknown };
};

type ScenePhysicsLooper = (delta: number) => void;

const scenePhysicsLoopers: { [id: string]: ScenePhysicsLooper } = {};

export type PhysicsParams = {
  /** Collider type and params {@link ColliderParams} */
  collider: ColliderParams;

  /** Rigid body type and params {@link RigidBodyParams} */
  rigidBody?: RigidBodyParams;
};

type ScenePhysicsState = {
  worldStepEnabled: boolean;
  visualizerEnabled: boolean;
  gravity: { x: number; y: number; z: number };
  solverIterations: number;
  internalPgsIterations: number;
  additionalFrictionIterations: number;
  interpolationEnabled: boolean;
};

type PhysicsState = {
  enabled: boolean;
  timestep: number;
  timestepRatio: number;
  scenes: { [sceneId: string]: ScenePhysicsState };
};

let physicsState: PhysicsState = {
  enabled: false,
  timestep: 60,
  timestepRatio: 1 / 60,
  scenes: {},
};

const LS_KEY = 'debugPhysics';
const DEFAULT_SCENE_PHYS_STATE: ScenePhysicsState = {
  worldStepEnabled: true,
  visualizerEnabled: false,
  gravity: { x: 0, y: -9.81, z: 0 },
  solverIterations: 10,
  internalPgsIterations: 1,
  additionalFrictionIterations: 4,
  interpolationEnabled: true,
};
const getDefaultScenePhysParams = () =>
  ({ ...DEFAULT_SCENE_PHYS_STATE, ...getConfig().physics }) as ScenePhysicsState;
let stepperFn: (loopState: LoopState) => void = () => {};
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World = { step: () => {} } as Rapier.World;
let physicsWorldEnabled = false;
let eventQueue: Rapier.EventQueue | undefined = undefined;
let collisionEventFnCount = 0;
let contactForceEventFnCount = 0;
const physicsObjects: { [sceneId: string]: { [id: string]: PhysicsObject } } = {};
// @OPTIMIZATION: This now also has physics objects without a mesh.
// Maybe it would be better to just add the physics objects with a mesh here,
// because now we have to check if they have a mesh in the baseStepper (for each physics object)
// which is not optimal.
let currentScenePhysicsObjects: PhysicsObject[] = [];
let debugMesh: THREE.LineSegments;
let debugMeshGeo: THREE.BufferGeometry;
let debugMeshMat: THREE.LineBasicMaterial;
let debugMeshAdded = false;
let physicsDebugGUI: Pane | null = null;
let physicsObjectsDebugList: TCMP | null = null;
let curScenePhysParams = { ...DEFAULT_SCENE_PHYS_STATE };

const getSceneIdForPhysics = (
  sceneId?: string,
  callerMethodString?: string,
  noWarnForUnitializedScene?: boolean
) => {
  let sId = getCurrentSceneId();
  if (sceneId) {
    const scene = getScene(sceneId);
    sId = scene.userData.id;
  }
  if (!sId) {
    const message = sceneId
      ? `Could not find scene with sceneId "${sceneId}" in ${callerMethodString || 'getCurrentSceneId'}. Set noWarnForUnitializedScene to true if need to suppress this warning.`
      : `Could not find current scene id in addPhysicsObject. If `;
    if (sceneId) {
      if (!noWarnForUnitializedScene) lwarn(message);
      sId = sceneId;
    } else {
      lerror(message);
      throw new Error(message);
    }
  }
  return sId;
};

export const createRigidBody = (physicsParams: PhysicsParams) => {
  const rigidBodyParams = physicsParams.rigidBody;
  let rigidBody: Rapier.RigidBody | undefined = undefined;
  let rigidBodyDesc: Rapier.RigidBodyDesc;

  if (!physicsWorldEnabled) createPhysicsWorld();

  if (!rigidBodyParams) return undefined;

  switch (rigidBodyParams.rigidType) {
    case 'DYNAMIC':
      rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
    case 'POS_BASED':
      rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
    case 'VELO_BASED':
      rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicVelocityBased();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
    case 'FIXED':
    default:
      rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
  }

  const wakeUp = rigidBodyParams.wakeUp !== false ? true : false;

  if (rigidBodyParams.translation) rigidBody.setTranslation(rigidBodyParams.translation, wakeUp);
  if (rigidBodyParams.rotation) rigidBody.setRotation(rigidBodyParams.rotation, wakeUp);
  if (rigidBodyParams.linvel) rigidBody.setLinvel(rigidBodyParams.linvel, wakeUp);
  if (rigidBodyParams.angvel) rigidBody.setAngvel(rigidBodyParams.angvel, wakeUp);
  if (rigidBodyParams.gravityScale) rigidBody.setGravityScale(rigidBodyParams.gravityScale, wakeUp);
  if (rigidBodyParams.force) rigidBody.addForce(rigidBodyParams.force, wakeUp);
  if (rigidBodyParams.torqueForce) rigidBody.addTorque(rigidBodyParams.torqueForce, wakeUp);
  if (rigidBodyParams.forceAtPoint)
    rigidBody.addForceAtPoint(
      rigidBodyParams.forceAtPoint.force,
      rigidBodyParams.forceAtPoint.point,
      wakeUp
    );
  if (rigidBodyParams.impulse) rigidBody.applyImpulse(rigidBodyParams.impulse, wakeUp);
  if (rigidBodyParams.torqueImpulse)
    rigidBody.applyTorqueImpulse(rigidBodyParams.torqueImpulse, wakeUp);
  if (rigidBodyParams.impulseAtPoint)
    rigidBody.applyImpulseAtPoint(
      rigidBodyParams.impulseAtPoint.force,
      rigidBodyParams.impulseAtPoint.point,
      wakeUp
    );
  if (rigidBodyParams.lockTranslations) {
    rigidBody.lockTranslations(true, wakeUp);
    rigidBody.setEnabledTranslations(
      !rigidBodyParams.lockTranslations.x,
      !rigidBodyParams.lockTranslations.y,
      !rigidBodyParams.lockTranslations.z,
      wakeUp
    );
  }
  if (rigidBodyParams.lockRotations) {
    rigidBody.lockRotations(true, wakeUp);
    rigidBody.setEnabledRotations(
      !rigidBodyParams.lockRotations.x,
      !rigidBodyParams.lockRotations.y,
      !rigidBodyParams.lockRotations.z,
      wakeUp
    );
    if (!rigidBody.userData) rigidBody.userData = {};
    (rigidBody.userData as { [key: string]: unknown }).lockRotationsX =
      rigidBodyParams.lockRotations.x;
    (rigidBody.userData as { [key: string]: unknown }).lockRotationsY =
      rigidBodyParams.lockRotations.y;
    (rigidBody.userData as { [key: string]: unknown }).lockRotationsZ =
      rigidBodyParams.lockRotations.z;
  }
  if (rigidBodyParams.linearDamping) rigidBody.setLinearDamping(rigidBodyParams.linearDamping);
  if (rigidBodyParams.angularDamping) rigidBody.setAngularDamping(rigidBodyParams.angularDamping);
  if (rigidBodyParams.dominance) rigidBody.setDominanceGroup(rigidBodyParams.dominance);
  if (rigidBodyParams.ccdEnabled) rigidBody.enableCcd(rigidBodyParams.ccdEnabled);
  if (rigidBodyParams.softCcdDistance)
    rigidBody.setSoftCcdPrediction(rigidBodyParams.softCcdDistance);

  if (rigidBodyParams.userData) rigidBody.userData = rigidBodyParams.userData;

  return rigidBody;
};

const getCombineRule = (rule?: 'MAX' | 'MULTIPLY' | 'MIN' | 'AVERAGE') => {
  switch (rule) {
    case 'MAX':
      return RAPIER.CoefficientCombineRule.Max;
    case 'MULTIPLY':
      return RAPIER.CoefficientCombineRule.Multiply;
    case 'MIN':
      return RAPIER.CoefficientCombineRule.Min;
    case 'AVERAGE':
    default:
      return RAPIER.CoefficientCombineRule.Average;
  }
};

/** Creates a RAPIER collider desc */
export const createCollider = (physicsParams: PhysicsParams, mesh?: THREE.Mesh) => {
  const colliderParams = physicsParams.collider;
  let shape: Rapier.Shape | null = null;
  let geo: THREE.BufferGeometry | undefined;
  let size: { [key: string]: number };

  if (!physicsWorldEnabled) createPhysicsWorld();

  switch (colliderParams.type) {
    case 'CUBOID':
    case 'BOX':
      size = { hx: 0.5, hy: 0.5, hz: 0.5 }; // Default size
      geo = mesh?.geometry;
      if (geo?.type === 'BoxGeometry') {
        size.hx = geo.userData.props?.params?.width / 2 || size.hx;
        size.hy = geo.userData.props?.params?.height / 2 || size.hy;
        size.hz = geo.userData.props?.params?.depth / 2 || size.hz;
      }
      shape = colliderParams.borderRadius
        ? new RAPIER.RoundCuboid(
            colliderParams.hx || size.hx,
            colliderParams.hy || size.hy,
            colliderParams.hz || size.hz,
            colliderParams.borderRadius
          )
        : new RAPIER.Cuboid(
            colliderParams.hx || size.hx,
            colliderParams.hy || size.hy,
            colliderParams.hz || size.hz
          );
      break;
    case 'BALL':
    case 'SPHERE':
      let radius = 0.5; // Default radius
      geo = mesh?.geometry;
      if (geo?.type === 'SphereGeometry') {
        radius = geo.userData.props?.params?.radius || radius;
      }
      shape = new RAPIER.Ball(colliderParams.radius || radius);
      break;
    case 'CAPSULE':
      {
        size = { halfHeight: 0.25, radius: 0.25 }; // Default values
        geo = mesh?.geometry;
        if (geo?.type === 'CapsuleGeometry') {
          size.halfHeight = geo.userData.props?.params.height / 2 || size.halfHeight;
          size.radius = geo.userData.props?.params?.radius || size.radius;
        }
        shape = new RAPIER.Capsule(
          colliderParams.halfHeight || size.halfHeight,
          colliderParams.radius || size.radius
        );
      }
      break;
    case 'CONE':
      {
        // @TODO: try to get the values straight from a Three.js Mesh
        const defaultHalfHeight = 0.25; // Default half height
        const defaultRadius = 0.25; // Default radius
        shape = colliderParams.borderRadius
          ? new RAPIER.RoundCone(
              colliderParams.halfHeight || defaultHalfHeight,
              colliderParams.radius || defaultRadius,
              colliderParams.borderRadius
            )
          : new RAPIER.Cone(
              colliderParams.halfHeight || defaultHalfHeight,
              colliderParams.radius || defaultRadius
            );
      }
      break;
    case 'CYLINDER':
      size = { halfHeight: 0.5, radius: 1 }; // Default values
      geo = mesh?.geometry;
      if (geo?.type === 'CylinderGeometry') {
        size.halfHeight = geo.userData.props?.params.height / 2 || size.halfHeight;
        size.radius =
          geo.userData.props?.params?.radiusBottom ||
          geo.userData.props?.params?.radiusTop ||
          size.radius;
      }
      shape = colliderParams.borderRadius
        ? new RAPIER.RoundCylinder(
            colliderParams.halfHeight || size.halfHeight,
            colliderParams.radius || size.radius,
            colliderParams.borderRadius
          )
        : new RAPIER.Cylinder(
            colliderParams.halfHeight || size.halfHeight,
            colliderParams.radius || size.radius
          );
      break;
    case 'TRIANGLE':
      // @TODO: try to get the values straight from a Three.js Mesh (and make colliderParams a, b, c optional)
      // For example, just take the first three vertices?
      shape = colliderParams.borderRadius
        ? new RAPIER.RoundTriangle(
            colliderParams.a,
            colliderParams.b,
            colliderParams.c,
            colliderParams.borderRadius
          )
        : new RAPIER.Triangle(colliderParams.a, colliderParams.b, colliderParams.c);
      break;
    case 'TRIMESH':
      geo = mesh?.geometry;
      if (colliderParams.vertices && colliderParams.indices) {
        shape = new RAPIER.TriMesh(colliderParams.vertices, colliderParams.indices);
        break;
      } else if (geo) {
        const vertices = new Float32Array(geo.attributes.position.array);
        let indices;
        if (geo.index) {
          indices = new Uint32Array(geo.index.array);
        } else {
          // Handle unindexed geometry by generating indices
          indices = new Uint32Array([...Array(vertices.length / 3).keys()]);
        }
        if (vertices && indices) {
          shape = new RAPIER.TriMesh(vertices, indices);
          break;
        }
      }
      const message = `Could not find vertices and indices in the collider params for trimesh, nor was there mesh with vertices present. Could not create trimesh physics shape in createCollider.`;
      lerror(message);
      throw new Error(message);

    // @TODO: Add HEIGHTFIELD type [ColliderDesc.heightfield(heights: matrix, scale)]
    // @TODO: Add COMPOUND type (compound objects)
  }

  if (!shape) {
    const message = 'Could not create collider shape in createCollider';
    lerror(message);
    throw new Error(message);
  }

  const colliderDesc = new RAPIER.ColliderDesc(shape);

  if (colliderParams.density !== undefined) colliderDesc.setDensity(colliderParams.density);
  if (colliderParams.translation)
    colliderDesc.setTranslation(
      colliderParams.translation.x,
      colliderParams.translation.y,
      colliderParams.translation.z
    );
  if (colliderParams.rotation) colliderDesc.setRotation(colliderParams.rotation);
  if (colliderParams.friction) colliderDesc.setFriction(colliderParams.friction);
  if (colliderParams.restitution) colliderDesc.setRestitution(colliderParams.restitution);
  if (colliderParams.frictionCombineRule)
    colliderDesc.setFrictionCombineRule(getCombineRule(colliderParams.frictionCombineRule));
  if (colliderParams.restitutionCombineRule)
    colliderDesc.setRestitutionCombineRule(getCombineRule(colliderParams.restitutionCombineRule));
  if (colliderParams.isSensor !== undefined) colliderDesc.setSensor(colliderParams.isSensor);

  if (
    colliderParams.enableCollisionActiveEvents ||
    colliderParams.enableContactForceActiveEvents ||
    colliderParams.collisionEventFn ||
    colliderParams.contactForceEventFn
  ) {
    let activeEvents: Rapier.ActiveEvents = RAPIER.ActiveEvents.NONE;
    if (
      (colliderParams.enableCollisionActiveEvents &&
        colliderParams.enableContactForceActiveEvents) ||
      (colliderParams.collisionEventFn && colliderParams.contactForceEventFn)
    ) {
      activeEvents =
        RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
    } else if (colliderParams.enableCollisionActiveEvents || colliderParams.collisionEventFn) {
      activeEvents = RAPIER.ActiveEvents.COLLISION_EVENTS;
      if (colliderParams.collisionEventFn) collisionEventFnCount++;
    } else if (
      colliderParams.enableContactForceActiveEvents ||
      colliderParams.contactForceEventFn
    ) {
      activeEvents = RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
      if (colliderParams.contactForceEventFn) contactForceEventFnCount++;
    }

    colliderDesc.setActiveEvents(activeEvents);
    if (!eventQueue && activeEvents !== RAPIER.ActiveEvents.NONE) {
      eventQueue = new RAPIER.EventQueue(true);
    }
  }

  return colliderDesc;
};

/**
 * Creates a new physics object without a mesh and registers it to the scene id (or current scene id if scene id is not provided) in the physicsObjects object.
 * @param id (string) physics object id
 * @param name (string) optional physics object name
 * @param physicsParamas (PhysicsParams | PhysicsParams[]) Params (or and array of them) for the physics object(s) ({@link PhysicsParams}), if an array is provided, then the object will be a multi object
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional value to suppress logger warning for unitialized scene (true = no warning, default = false)
 * @param currentObjectIndex (number) optional object index to be set as the first object for the multi object (only for arrays of params), if no index is provided, then the first (index 0) will be set
 * @param isCompoundObject (boolean) optional boolean value to tell whether the physics object has switchable colliders or not. This will set the first collider enabled and disable the rest.
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const createPhysicsObjectWithoutMesh = ({
  id,
  name,
  physicsParams,
  sceneId,
  noWarnForUnitializedScene,
  currentObjectIndex,
  isCompoundObject,
}: {
  id: string;
  name?: string;
  physicsParams: PhysicsParams | PhysicsParams[];
  sceneId?: string;
  noWarnForUnitializedScene?: boolean;
  currentObjectIndex?: number;
  isCompoundObject?: boolean;
}) => {
  if (!RAPIER) return;
  const sId = getSceneIdForPhysics(
    sceneId,
    'createPhysicsObjectWithoutMesh',
    noWarnForUnitializedScene
  );

  let rigidBody: Rapier.RigidBody | undefined = undefined;
  const colliders: Rapier.Collider[] = [];
  const collisionEventFn: CollisionEventFn[] = [];
  const contactForceEventFn: ContactForceEventFn[] = [];

  if (Array.isArray(physicsParams)) {
    existsOrThrow(
      physicsParams[0].rigidBody,
      `Could not find a RigidBody in the first index of the physicsParams in createPhysicsObjectWithoutMesh with id '${id}'.`
    );
    rigidBody = createRigidBody(physicsParams[0]);
    let colliderEnabled = false;
    for (let i = 0; i < physicsParams.length; i++) {
      const colliderDesc = createCollider(physicsParams[i]);
      const collider = physicsWorld.createCollider(colliderDesc, rigidBody);
      if (physicsParams[i].collider.collisionEventFn) {
        collisionEventFn.push(physicsParams[i].collider.collisionEventFn as CollisionEventFn);
      }
      if (physicsParams[i].collider.contactForceEventFn) {
        contactForceEventFn.push(
          physicsParams[i].collider.contactForceEventFn as ContactForceEventFn
        );
      }
      if (!isCompoundObject) {
        if (currentObjectIndex !== undefined && i === currentObjectIndex) {
          collider.setEnabled(true);
          colliderEnabled = true;
        } else {
          collider.setEnabled(false);
        }
      }
      colliders.push(collider);
    }
    if (!colliderEnabled) colliders[0].setEnabled(true);
  } else {
    rigidBody = createRigidBody(physicsParams);
    const colliderDesc = createCollider(physicsParams);
    const collider = physicsWorld.createCollider(colliderDesc, rigidBody);
    colliders.push(collider);
    if (physicsParams.collider.collisionEventFn) {
      collisionEventFn.push(physicsParams.collider.collisionEventFn);
    }
    if (physicsParams.collider.contactForceEventFn) {
      contactForceEventFn.push(physicsParams.collider.contactForceEventFn);
    }
  }

  existsOrThrow(
    colliders.length,
    `Could not create collider in createPhysicsObjectWithoutMesh with id '${id}'.`
  );

  const physObj: PhysicsObject = {
    id,
    name,
    ...(rigidBody ? { rigidBody } : {}),
    collider: colliders.length === 1 ? colliders[0] : colliders,
    ...(collisionEventFn ? { collisionEventFn } : {}),
    ...(contactForceEventFn ? { contactForceEventFn } : {}),
    ...(currentObjectIndex !== undefined ? { currentObjectIndex } : {}),
    setTranslation: (translation: { x?: number; y?: number; z?: number }) => {
      if (rigidBody) {
        rigidBody.setTranslation(
          ThreeVector3.set(
            translation.x || rigidBody.translation().x || 0,
            translation.y || rigidBody.translation().y || 0,
            translation.z || rigidBody.translation().z || 0
          ),
          true
        );
        return;
      }
      for (let i = 0; i < colliders.length; i++) {
        const collider = colliders[i];
        collider.setTranslation(
          ThreeVector3.set(
            translation.x || collider.translation().x || 0,
            translation.y || collider.translation().y || 0,
            translation.z || collider.translation().z || 0
          )
        );
      }
    },
  };
  if (!physicsObjects[sId]) physicsObjects[sId] = {};
  physicsObjects[sId][id] = physObj;

  if (sId === getCurrentSceneId()) {
    // @OPTIMIZATION: check currentScenePhysicsObjects type at the top of the file for more info
    currentScenePhysicsObjects.push(physObj);
    if (physObj.rigidBody) physObj.rigidBody.setEnabled(true);
  }

  updatePhysObjectDebuggerGUI('LIST');

  return physObj;
};

/**
 * Creates a new physics object with a mesh and registers it to the scene id (or current scene id if scene id is not provided) in the physicsObjects object. If an array of physics params is provided, then the object is a multi object, which means that the objects can be switched to another.
 * @param physicsParamas (PhysicsParams | PhysicsParams[]) Params (or and array of them) for the physics object(s) ({@link PhysicsParams}), if an array is provided, then the object will be a multi object
 * @param meshOrMeshId ((THREE.Mesh | string) | (THREE.Mesh | string)[]) mesh or a mesh id (or an array of either of them) of the representation of the physics object, if the physics object is a multi object, then the corresponding array index mesh will be used, but if the mesh is missing, then the first (or only) mesh will be used.
 * @param id (string) optional physics object id, if no id is provided then the mesh id is used
 * @param name (string) optional physics object name
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional boolean value to suppress logger warning for unitialized scene (true = no warning, default = false)
 * @param currentObjectIndex (number) optional object index to be set as the first object for the multi object (only for arrays of params), if no index is provided, then the first (index 0) will be set
 * @param currentMeshIndex (number) optional object index to be set as the first mesh for the multi object (only for arrays of params), if no index is provided, then the first (index 0) will be set
 * @param isCompoundObject (boolean) optional boolean value to tell whether the physics object has switchable colliders or not. This will set the first collider enabled and disable the rest.
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const createPhysicsObjectWithMesh = ({
  physicsParams,
  meshOrMeshId,
  id,
  name,
  sceneId,
  noWarnForUnitializedScene,
  currentObjectIndex,
  currentMeshIndex,
  isCompoundObject,
}: {
  physicsParams: PhysicsParams | PhysicsParams[];
  meshOrMeshId: (THREE.Mesh | string) | (THREE.Mesh | string)[];
  id?: string;
  name?: string;
  sceneId?: string;
  noWarnForUnitializedScene?: boolean;
  currentObjectIndex?: number;
  currentMeshIndex?: number;
  isCompoundObject?: boolean;
}) => {
  if (!RAPIER) return;
  const sId = getSceneIdForPhysics(
    sceneId,
    'createPhysicsObjectWithMesh',
    noWarnForUnitializedScene
  );
  let meshId: string = '';
  let mesh: THREE.Mesh | null = null;
  const meshes: THREE.Mesh[] = [];

  const meshWarnMsg = `Could not find mesh in createPhysicsObjectWithMesh (with id: '${id}'). Physics object was not added.`;

  if (typeof meshOrMeshId === 'string') {
    // Mesh id
    meshId = meshOrMeshId;
    mesh = getMesh(meshId);
    if (!mesh) {
      lwarn(meshWarnMsg, `Mesh id: ${meshId}`);
      return;
    }
    mesh.userData.isPhysicsObject = true;
    meshes.push(mesh);
  } else if (Array.isArray(meshOrMeshId) && meshOrMeshId.length) {
    // Array of meshes or mesh ids
    let visibleMeshIsSet = false;
    for (let i = 0; i < meshOrMeshId.length; i++) {
      const momid = meshOrMeshId[i];
      if (typeof momid === 'string') {
        const mId = momid;
        const m = getMesh(mId);
        m.visible = false;
        if (currentMeshIndex !== undefined && i === currentMeshIndex) {
          meshId = mId;
          mesh = m;
          m.visible = true;
          visibleMeshIsSet = true;
        }
        if (!m) {
          lwarn(meshWarnMsg, `Mesh id: ${meshId}`);
          return;
        }
        m.userData.isPhysicsObject = true;
        meshes.push(m);
      } else {
        const mId = momid.userData.id;
        const m = momid;
        m.visible = false;
        if (currentObjectIndex !== undefined && i === currentObjectIndex) {
          meshId = mId;
          mesh = m;
          m.visible = true;
          visibleMeshIsSet = true;
        }
        m.userData.isPhysicsObject = true;
        meshes.push(m);
      }
    }
    if (!visibleMeshIsSet) {
      mesh = meshes[0];
      meshId = mesh.userData.id;
      mesh.visible = true;
    }
  } else if ('isMesh' in meshOrMeshId) {
    // Single mesh
    meshes.push(meshOrMeshId);
    meshId = meshOrMeshId.userData.id;
    mesh = meshOrMeshId;
    mesh.userData.isPhysicsObject = true;
  }

  if (!mesh) {
    lwarn(meshWarnMsg, `Mesh id: ${meshId}`);
    return;
  }

  if (!id) id = meshId;

  if (id && sId) {
    const existingPhysObject = getPhysicsObject(id, sId);
    if (existingPhysObject) return existingPhysObject;
  }

  let rigidBody: Rapier.RigidBody | undefined = undefined;
  const colliders: Rapier.Collider[] = [];
  const collisionEventFn: CollisionEventFn[] = [];
  const contactForceEventFn: ContactForceEventFn[] = [];

  if (Array.isArray(physicsParams)) {
    existsOrThrow(
      physicsParams[0].rigidBody,
      `Could not find a RigidBody in the first index of the physicsParams in createPhysicsObjectWithMesh with id '${id}'. The first index of a multi object should have a rigidbody.`
    );
    rigidBody = createRigidBody(physicsParams[0]);
    let colliderEnabled = false;
    for (let i = 0; i < physicsParams.length; i++) {
      const colliderDesc = createCollider(physicsParams[i], mesh);
      const collider = physicsWorld.createCollider(colliderDesc, rigidBody);
      if (physicsParams[i].collider.collisionEventFn) {
        collisionEventFn.push(physicsParams[i].collider.collisionEventFn as CollisionEventFn);
      }
      if (physicsParams[i].collider.contactForceEventFn) {
        contactForceEventFn.push(
          physicsParams[i].collider.contactForceEventFn as ContactForceEventFn
        );
      }
      // @TODO: refactor this to have multiple objects enabled (this only supports one)
      if (!isCompoundObject) {
        if (currentObjectIndex !== undefined && i === currentObjectIndex) {
          collider.setEnabled(true);
          colliderEnabled = true;
        } else {
          collider.setEnabled(false);
        }
      }
      // @TODO: refactor this to have the enabled param in the phys obj params
      if (physicsParams[i].collider.isSensor) collider.setEnabled(true);
      colliders.push(collider);
    }
    // @TODO: this might not be needed after the refactoring above
    if (!colliderEnabled) colliders[0].setEnabled(true);
  } else {
    rigidBody = createRigidBody(physicsParams);
    const colliderDesc = createCollider(physicsParams, mesh);
    const collider = physicsWorld.createCollider(colliderDesc, rigidBody);
    colliders.push(collider);
    if (physicsParams.collider.collisionEventFn) {
      collisionEventFn.push(physicsParams.collider.collisionEventFn as CollisionEventFn);
    }
    if (physicsParams.collider.contactForceEventFn) {
      contactForceEventFn.push(physicsParams.collider.contactForceEventFn as ContactForceEventFn);
    }
  }

  existsOrThrow(
    colliders.length,
    `Could not create collider in createPhysicsObjectWithoutMesh with id '${id}'.`
  );

  const physObj: PhysicsObject = {
    id,
    name,
    mesh: mesh,
    ...(meshes.length > 1 ? { meshes } : {}),
    ...(rigidBody ? { rigidBody } : {}),
    collider: colliders.length === 1 ? colliders[0] : colliders,
    ...(collisionEventFn.length
      ? { collisionEventFn: collisionEventFn.length === 1 ? collisionEventFn[0] : collisionEventFn }
      : {}),
    ...(contactForceEventFn.length
      ? {
          contactForceEventFn:
            contactForceEventFn.length === 1 ? contactForceEventFn[0] : contactForceEventFn,
        }
      : {}),
    ...(currentObjectIndex !== undefined ? { currentObjectIndex } : {}),
    ...(currentMeshIndex !== undefined ? { currentMeshIndex } : {}),
    setTranslation: (translation: { x?: number; y?: number; z?: number }) => {
      if (rigidBody) {
        rigidBody.setTranslation(
          ThreeVector3.set(
            translation.x || rigidBody.translation().x,
            translation.y || rigidBody.translation().y,
            translation.z || rigidBody.translation().z
          ),
          true
        );
      } else {
        for (let i = 0; i < colliders.length; i++) {
          const collider = colliders[i];
          collider.setTranslation(
            ThreeVector3.set(
              translation.x || collider.translation().x,
              translation.y || collider.translation().y,
              translation.z || collider.translation().z
            )
          );
        }
      }
      mesh.position.set(
        translation.x || mesh.position.x,
        translation.y || mesh.position.y,
        translation.z || mesh.position.z
      );
    },
    // @TODO: add setRotation
  };
  if (!physicsObjects[sId]) physicsObjects[sId] = {};
  physicsObjects[sId][id] = physObj;

  if (sId === getCurrentSceneId()) {
    // @OPTIMIZATION: check currentScenePhysicsObjects type at the top of the file for more info
    currentScenePhysicsObjects.push(physObj);
    if (physObj.rigidBody) physObj.rigidBody.setEnabled(true);
  }

  updatePhysObjectDebuggerGUI('LIST');

  return physObj;
};

export const switchPhysicsCollider = (id: string, newIndex: number) => {
  const obj = existsOrThrow(
    getPhysicsObject(id),
    `Could not find physics object with id '${id}' in switchPhysicsCollider.`
  );
  if (!Array.isArray(obj.collider)) {
    lwarn(
      `Physics object has only 1 collider and cannot be switched in switchPhysicsCollider (id: '${id}').`
    );
    return;
  }
  const newCollider = obj.collider[newIndex];
  if (!newCollider) {
    lwarn(
      `Physics object collider not found with index ${newIndex} in switchPhysicsCollider (id: '${id}')`
    );
  }

  const currentIndex = obj.currentObjectIndex || 0;
  obj.collider[currentIndex].setEnabled(false);
  newCollider.setEnabled(true);
  obj.currentObjectIndex = newIndex;

  updatePhysObjectDebuggerGUI('WINDOW');
};

export const switchPhysicsMesh = (id: string, newIndex: number) => {
  const obj = existsOrThrow(
    getPhysicsObject(id),
    `Could not find physics object with id '${id}' in switchPhysicsMesh.`
  );
  if (!obj.meshes) {
    lwarn(
      `Physics object has only 1 mesh and cannot be switched in switchPhysicsMesh (id: '${id}').`
    );
    return;
  }
  const newMesh = obj.meshes[newIndex];
  if (!newMesh) {
    lwarn(
      `Physics object mesh not found with index ${newIndex} in switchPhysicsMesh (id: '${id}')`
    );
  }

  const currentIndex = obj.currentObjectIndex || 0;
  obj.meshes[currentIndex].visible = false;
  newMesh.visible = true;
  obj.mesh = newMesh;
  obj.currentMeshIndex = newIndex;

  updatePhysObjectDebuggerGUI('WINDOW');
};

/**
 * Deletes a physics object
 * @param id string
 * @param sceneId optional string, if not provided the current scene id will be used
 */
export const deletePhysicsObject = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'removePhysicsObject');
  const scenePhysicsObjects = physicsObjects[sId];
  if (!scenePhysicsObjects) return;

  const obj = scenePhysicsObjects[id];
  if (!obj) return;
  if (obj.rigidBody) {
    physicsWorld.removeRigidBody(obj.rigidBody);
  } else {
    if (Array.isArray(obj.collider)) {
      for (let i = 0; i < obj.collider.length; i++) {
        physicsWorld.removeCollider(obj.collider[i], false);
      }
    } else {
      physicsWorld.removeCollider(obj.collider, false);
    }
  }

  delete scenePhysicsObjects[id];

  if (isCurrentScene(sId)) {
    currentScenePhysicsObjects = currentScenePhysicsObjects.filter((obj) => {
      if (obj.id === id) {
        if (obj.collisionEventFn) collisionEventFnCount--;
        if (obj.contactForceEventFn) contactForceEventFnCount--;
        if (collisionEventFnCount < 0) collisionEventFnCount = 0;
        if (contactForceEventFnCount < 0) contactForceEventFnCount = 0;
      }
      return obj.id !== id;
    });
  }

  updatePhysObjectDebuggerGUI('LIST');
};

/**
 * Deletes all physics objects for a scene
 * @param sceneId (string) scene id
 */
export const deletePhysicsObjectsBySceneId = (sceneId: string) => {
  const objects = physicsObjects[sceneId];
  if (!objects) return;
  const keys = Object.keys(objects);
  for (let i = 0; i < keys.length; i++) {
    deletePhysicsObject(keys[i], sceneId);
  }
  delete physicsObjects[sceneId];
  if (isCurrentScene(sceneId)) deleteCurrentScenePhysicsObjects();

  updatePhysObjectDebuggerGUI();
};

// @CONSIDER: maybe remove this as we anyways destroy all the physics objects during scene (un)load
export const deleteCurrentScenePhysicsObjects = () => {
  for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
    const obj = currentScenePhysicsObjects[i];
    if (obj.rigidBody) {
      obj.rigidBody.setEnabled(false);
      physicsWorld.removeRigidBody(obj.rigidBody);
    } else {
      if (Array.isArray(obj.collider)) {
        for (let i = 0; i < obj.collider.length; i++) {
          obj.collider[i].setEnabled(false);
          physicsWorld.removeCollider(obj.collider[i], false);
        }
      } else {
        obj.collider.setEnabled(false);
        physicsWorld.removeCollider(obj.collider, false);
      }
    }
  }
  currentScenePhysicsObjects = [];

  const currentSceneId = getCurrentSceneId();
  !existsOrWarn(
    currentSceneId,
    `Could not find currentSceneId (id: ${currentSceneId}) in deleteCurrentScenePhysicsObjects`
  );
  if (currentSceneId) physicsObjects[currentSceneId] = {};

  updatePhysObjectDebuggerGUI();
};

/**
 * Deletes all physics objects and clears the currentScenePhysicsObjects
 */
export const deleteAllPhysicsObjects = () => {
  const sceneIds = Object.keys(physicsObjects);
  for (let i = 0; i < sceneIds.length; i++) {
    deletePhysicsObjectsBySceneId(sceneIds[i]);
  }
  currentScenePhysicsObjects = [];
};

/**
 * Checks, with a physics object id, whether a physics object exists or not
 * @param id (string) physics object id
 * @param sceneId (string) optional scene id, if not defined the current scene id will be used
 * @returns boolean
 */
export const doesPOExist = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'doesGeoExist', true);
  return Boolean(physicsObjects[sId][id]);
};

/** Returns the current physicsState */
export const getPhysicsState = () => physicsState;

/**
 * Creates the physics world and sets gravity
 */
export const createPhysicsWorld = () => {
  const currentSceneId = getCurrentSceneId();
  if (!RAPIER || !currentSceneId) return;

  const defaultParams = getDefaultScenePhysParams();

  const gravity = physicsState.scenes[currentSceneId]?.gravity || defaultParams.gravity;
  const solverIterations =
    physicsState.scenes[currentSceneId]?.solverIterations || defaultParams.solverIterations;
  const internalPgsIterations =
    physicsState.scenes[currentSceneId]?.internalPgsIterations ||
    defaultParams.internalPgsIterations;
  const additionalFrictionIterations =
    physicsState.scenes[currentSceneId]?.additionalFrictionIterations ||
    defaultParams.additionalFrictionIterations;
  physicsWorld = new RAPIER.World(new RAPIER.Vector3(gravity.x, gravity.y, gravity.z));
  physicsWorld.timestep = physicsState.timestepRatio;
  physicsWorldEnabled = true;
  if (solverIterations) physicsWorld.numSolverIterations = solverIterations;
  if (internalPgsIterations) physicsWorld.numInternalPgsIterations = internalPgsIterations;
  if (additionalFrictionIterations)
    physicsWorld.numAdditionalFrictionIterations = additionalFrictionIterations;

  if (isDebugEnvironment()) initDebuggerScenePhysState();
};

/**
 * Deletes the physics world and all its children
 */
export const deletePhysicsWorld = () => {
  if (!physicsWorldEnabled) return;
  physicsWorldEnabled = false;
  physicsWorld.free();
  physicsWorld = { step: () => {} } as Rapier.World;
  const sceneIds = Object.keys(physicsObjects);
  for (let i = 0; i < sceneIds.length; i++) {
    delete physicsObjects[sceneIds[i]];
  }
  currentScenePhysicsObjects = [];
};

/**
 * Return a physics object by id and sceneId
 * @param id string
 * @param sceneId optional string, if not provided the current scene id will be used
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const getPhysicsObject = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'getPhysicsObject');
  const scenePhysicsObjects = physicsObjects[sId];
  if (!scenePhysicsObjects) return undefined;
  return scenePhysicsObjects[id];
};

/**
 * Return a physics objects by array of ids
 * @param ids array of strings
 * @param sceneId optional scene id string where the physics object searched from
 * @returns PhysicsObject[] ({@link PhysicsObject})
 */
export const getPhysicsObjects = (ids: string[], sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'getPhysicsObjects');
  const scenePhysicsObjects = physicsObjects[sId] || [];
  const objects: PhysicsObject[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!scenePhysicsObjects[ids[i]]) continue;
    objects.push(scenePhysicsObjects[ids[i]]);
  }
  return objects;
};

/**
 * Returns the Rapier object or throws an error if physics is not initialized.
 * @returns Rapier
 */
export const getRAPIER = () => {
  if (!RAPIER) {
    const message =
      'Trying to access RAPIER object but physics has not been initalized. Call "await InitPhysics()" in the "InitEngine" callback.';
    lerror(message);
    throw new Error(message);
  }
  return RAPIER;
};

/**
 * Returns the physicsWorld object or throws an error if physics is not initialized.
 * @returns Rapier.World
 */
export const getPhysicsWorld = () => {
  if (!RAPIER) {
    const message =
      'Trying to access physicsWorld object but physics has not been initalized. Call "await InitPhysics()" in the "InitEngine" callback.';
    lerror(message);
    throw new Error(message);
  }
  return physicsWorld as Rapier.World;
};

/**
 * Creates physics debug mesh (only in debug mode)
 */
export const createPhysicsDebugMesh = () => {
  if (debugMesh) {
    debugMesh.removeFromParent();
    debugMeshAdded = false;
  }
  if (debugMeshGeo) {
    debugMeshGeo.dispose();
    debugMeshGeo = new THREE.BufferGeometry();
  }
  if (!debugMeshMat) {
    debugMeshMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
    });
  }
  debugMesh = new THREE.LineSegments(debugMeshGeo, debugMeshMat);
  debugMesh.frustumCulled = false;
};

let accDelta = 0;
const clock = new THREE.Clock();

const prevTransforms = new Map<number, { pos: THREE.Vector3; rot: THREE.Quaternion }>();
const currTransforms = new Map<number, { pos: THREE.Vector3; rot: THREE.Quaternion }>();

// Different stepper functions to use for debug and production.
// baseStepper is used for both.
const baseStepper = () => {
  const delta = clock.getDelta();
  accDelta += delta;

  while (accDelta >= physicsState.timestepRatio) {
    // Store previous transforms
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      const po = currentScenePhysicsObjects[i];
      if (checkDynamicPhysicsObjectInvalidity(po)) continue;
      const rb = po.rigidBody as RigidBody;
      const handle = rb.handle;
      const t = rb.translation();
      const r = rb.rotation();
      const curr = new THREE.Vector3(t.x, t.y, t.z);
      const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      prevTransforms.set(
        handle,
        currTransforms.get(handle) ?? { pos: curr.clone(), rot: quat.clone() }
      );
      currTransforms.set(handle, { pos: curr, rot: quat });
    }

    if (collisionEventFnCount) {
      eventQueue?.drainCollisionEvents((handle1, handle2, started) => {
        let collider1: Collider | null = null;
        let collider2: Collider | null = null;
        const physObj1 = currentScenePhysicsObjects.find((obj) => {
          if (Array.isArray(obj.collider)) {
            const foundCollider = obj.collider.find((collider) => collider.handle === handle1);
            if (foundCollider) {
              collider1 = foundCollider;
              return true;
            }
            return false;
          }
          if (obj.collider.handle === handle1) {
            collider1 = obj.collider;
            return true;
          }
          return false;
        });
        const physObj2 = currentScenePhysicsObjects.find((obj) => {
          if (Array.isArray(obj.collider)) {
            const foundCollider = obj.collider.find((collider) => collider.handle === handle2);
            if (foundCollider) {
              collider2 = foundCollider;
              return true;
            }
            return false;
          }
          if (obj.collider.handle === handle2) {
            collider2 = obj.collider;
            return true;
          }
          return false;
        });
        if (!collider1 || !collider2) return;
        if (physObj1?.collisionEventFn && physObj2) {
          if (Array.isArray(physObj1.collisionEventFn)) {
            for (let i = 0; i < physObj1.collisionEventFn.length; i++) {
              physObj1.collisionEventFn[i](collider1, collider2, started, physObj1, physObj2);
            }
          } else {
            physObj1.collisionEventFn(collider1, collider2, started, physObj1, physObj2);
          }
        }
        if (physObj2?.collisionEventFn && physObj1) {
          if (Array.isArray(physObj2.collisionEventFn)) {
            for (let i = 0; i < physObj2.collisionEventFn.length; i++) {
              physObj2.collisionEventFn[i](collider1, collider2, started, physObj1, physObj2);
            }
          } else {
            physObj2.collisionEventFn(collider1, collider2, started, physObj1, physObj2);
          }
        }
      });
    }

    if (contactForceEventFnCount) {
      eventQueue?.drainContactForceEvents((event) => {
        const handle1 = event.collider1();
        const handle2 = event.collider2();
        const physObj1 = currentScenePhysicsObjects.find((obj) => {
          if (Array.isArray(obj.collider)) {
            return Boolean(obj.collider.find((collider) => collider.handle === handle1));
          }
          return obj.collider.handle === handle1;
        });
        const physObj2 = currentScenePhysicsObjects.find((obj) => {
          if (Array.isArray(obj.collider)) {
            return Boolean(obj.collider.find((collider) => collider.handle === handle2));
          }
          return obj.collider.handle === handle2;
        });
        if (physObj1?.contactForceEventFn && physObj2) {
          if (Array.isArray(physObj1.contactForceEventFn)) {
            for (let i = 0; i < physObj1.contactForceEventFn.length; i++) {
              physObj1.contactForceEventFn[i](event, physObj1, physObj2);
            }
          } else {
            physObj1.contactForceEventFn(event, physObj1, physObj2);
          }
        }
        if (physObj2?.contactForceEventFn && physObj1) {
          if (Array.isArray(physObj2.contactForceEventFn)) {
            for (let i = 0; i < physObj2.contactForceEventFn.length; i++) {
              physObj2.contactForceEventFn[i](event, physObj1, physObj2);
            }
          } else {
            physObj2.contactForceEventFn(event, physObj1, physObj2);
          }
        }
      });
    }

    // Run scenePhysicsLoopers
    const looperKeys = Object.keys(scenePhysicsLoopers);
    for (let i = 0; i < looperKeys.length; i++) {
      scenePhysicsLoopers[looperKeys[i]](delta);
    }

    // Step the world
    physicsWorld.step(eventQueue);
    accDelta -= physicsState.timestepRatio;
  }
};

// PRODUCTION STEPPER
const stepperFnProduction = (loopState: LoopState) => {
  if (!loopState.masterPlay || !loopState.appPlay) return;
  baseStepper();
};

// DEBUG STEPPER
const stepperFnDebug = (loopState: LoopState) => {
  const startMeasuring = performance.now();

  if (!loopState.masterPlay || !loopState.appPlay) return;

  const curSceneParams = physicsState.scenes[getCurrentSceneId() || ''];
  if (!curSceneParams?.worldStepEnabled) return;

  baseStepper();

  if (physicsWorldEnabled && curSceneParams?.visualizerEnabled) {
    const { vertices, colors } = physicsWorld.debugRender();
    if (!vertices.length) return;
    if (!debugMeshAdded) {
      getRootScene()?.add(debugMesh);
      debugMeshAdded = true;
    }
    debugMesh.visible = true;
    const posAttr = debugMesh.geometry.attributes.position;
    const colorAttr = debugMesh.geometry.attributes.color;
    if (vertices.length !== posAttr?.array.length) {
      debugMeshGeo = new THREE.BufferGeometry();
      debugMesh.geometry = debugMeshGeo;
      debugMesh.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      debugMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      debugMesh.geometry.getAttribute('position').needsUpdate = true;
      debugMesh.geometry.getAttribute('color').needsUpdate = true;
    }
    if (posAttr) {
      posAttr.array.set(vertices);
      colorAttr.array.set(colors);
      posAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
    }
  } else {
    debugMesh.visible = false;
  }

  const stopMeasuring = performance.now();
  updatePhysicsPanel(stopMeasuring - startMeasuring);
};

/**
 * Steps the physics world (called in the main loop) and sets mesh positions and rotations in the current scene.
 */
export const stepPhysicsWorld = (loopState: LoopState) => stepperFn(loopState);

const checkDynamicPhysicsObjectInvalidity = (po: PhysicsObject) =>
  !po.mesh ||
  (po.rigidBody &&
    (!po.rigidBody?.isMoving() || po.rigidBody.isFixed() || !po.rigidBody.isEnabled()));

export const renderPhysicsObjects = () => {
  if (getCurrentScenePhysParams().interpolationEnabled) {
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      const po = currentScenePhysicsObjects[i];
      // @OPTIMIZATION: check currentScenePhysicsObjects type at the top of the file for more info
      if (checkDynamicPhysicsObjectInvalidity(po)) continue;
      const mesh = po.mesh as THREE.Mesh; // Casting is safe here because we check the validity (checkDynamicPhysicsObjectInvalidity)
      const rb = po.rigidBody as RigidBody; // Casting is safe here because we check the validity (checkDynamicPhysicsObjectInvalidity)
      const prev = prevTransforms.get(rb.handle);
      const curr = currTransforms.get(rb.handle);
      if (!prev || !curr) continue;

      const alpha = Math.min(accDelta / physicsState.timestepRatio, 1);

      // Interpolated position
      const interpPos = prev.pos.clone().lerp(curr.pos, alpha);

      // Interpolated rotation
      const interpRot = slerp(prev.rot, curr.rot, alpha);

      mesh.position.copy(interpPos);
      const userData = po.rigidBody?.userData as { [key: string]: unknown };
      if (!userData?.lockRotationsX && !userData?.lockRotationsX && !userData?.lockRotationsX) {
        mesh.quaternion.copy(interpRot);
      } else {
        mesh.quaternion.copy({
          x: userData.lockRotationsX ? mesh.quaternion.x : interpRot.x,
          y: userData.lockRotationsY ? mesh.quaternion.y : interpRot.y,
          z: userData.lockRotationsZ ? mesh.quaternion.z : interpRot.z,
          w: mesh.quaternion.w,
        });
      }
    }
  } else {
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      const po = currentScenePhysicsObjects[i];
      // @OPTIMIZATION: check currentScenePhysicsObjects type at the top of the file for more info
      if (checkDynamicPhysicsObjectInvalidity(po)) continue;
      const mesh = po.mesh as THREE.Mesh; // Casting is safe here because we check the validity (checkDynamicPhysicsObjectInvalidity)
      const rb = po.rigidBody as RigidBody; // Casting is safe here because we check the validity (checkDynamicPhysicsObjectInvalidity)

      mesh.position.copy(rb.translation());
      const userData = rb.userData as { [key: string]: unknown };
      if (!userData?.lockRotationsX && !userData?.lockRotationsX && !userData?.lockRotationsX) {
        mesh.quaternion.copy(rb.rotation());
      } else {
        const colliderRotation = rb.rotation();
        mesh.quaternion.copy({
          x: userData.lockRotationsX ? mesh.quaternion.x : colliderRotation.x,
          y: userData.lockRotationsY ? mesh.quaternion.y : colliderRotation.y,
          z: userData.lockRotationsZ ? mesh.quaternion.z : colliderRotation.z,
          w: mesh.quaternion.w,
        });
      }
    }
  }
};

/**
 * Changes the scene to be used for the scene's physics objects (optimizes the stepping)
 * @param sceneId string of the new scene id to change to
 */
export const setCurrentScenePhysicsObjects = (sceneId: string | null) => {
  if (!RAPIER) return;

  initDebuggerScenePhysState();

  currentScenePhysicsObjects = [];
  collisionEventFnCount = 0;
  contactForceEventFnCount = 0;
  if (eventQueue) eventQueue.clear();

  if (!sceneId) return;

  const allNewPhysicsObjects = physicsObjects[sceneId];
  if (!allNewPhysicsObjects) {
    createPhysicsDebugMesh();
    return;
  }

  const keys = Object.keys(allNewPhysicsObjects);
  for (let i = 0; i < keys.length; i++) {
    const obj = allNewPhysicsObjects[keys[i]];
    if (!obj) continue;
    currentScenePhysicsObjects.push(obj);
    if (obj.rigidBody) {
      obj.rigidBody.setEnabled(true);
    } else {
      if (Array.isArray(obj.collider)) {
        obj.collider[obj.currentObjectIndex || 0].setEnabled(true);
      } else {
        obj.collider.setEnabled(true);
      }
    }
    if (obj.collisionEventFn) collisionEventFnCount++;
    if (obj.contactForceEventFn) contactForceEventFnCount++;
  }

  createPhysicsDebugMesh();
};

/**
 * Returns the current scene physics objects
 * @returns currentScenePhysicsObjects
 */
export const getCurrentScenePhysicsObjects = () => currentScenePhysicsObjects;

export const togglePhysicsVisualizer = (value: boolean) => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  if (!physicsState.scenes[currentSceneId]) {
    physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
  }
  physicsState.scenes[currentSceneId].visualizerEnabled = value;
  curScenePhysParams = physicsState.scenes[currentSceneId];
  updateOnScreenTools('SWITCH');
  lsSetItem(LS_KEY, physicsState);
};

const initDebuggerScenePhysState = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  if (!physicsState.scenes[currentSceneId]) {
    physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
  }
  curScenePhysParams = physicsState.scenes[currentSceneId];
  buildPhysicsDebugGUI();
};

const createDebugControls = () => {
  const savedValues = lsGetItem(LS_KEY, physicsState);
  physicsState = {
    ...physicsState,
    ...savedValues,
  };
  physicsState.timestepRatio = 1 / (physicsState.timestep || 60);

  initDebuggerScenePhysState();

  const icon = getSvgIcon('rocketTakeoff');
  createDebuggerTab({
    id: 'physicsControls',
    buttonText: icon,
    title: 'Physics controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('physics', `${icon} Physics Controls`);
      physicsDebugGUI = debugGUI;
      buildPhysicsDebugGUI();
      container.add(buildPhysicsObjectsDebugList());
      return container;
    },
  });
};

export const buildPhysicsDebugGUI = () => {
  const debugGUI = physicsDebugGUI;
  if (!debugGUI) return;

  const blades = debugGUI?.children || [];
  for (let i = 0; i < blades.length; i++) {
    blades[i].dispose();
  }

  debugGUI
    .addBinding(physicsState, 'timestep', { label: 'Global timestep (1 / ts)', step: 1, min: 1 })
    .on('change', (e) => {
      physicsState.timestepRatio = 1 / e.value;
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI.addBlade({ view: 'separator' });
  debugGUI
    .addBinding(curScenePhysParams, 'worldStepEnabled', { label: 'Enable world step' })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].worldStepEnabled = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI
    .addBinding(curScenePhysParams, 'visualizerEnabled', { label: 'Enable visualizer' })
    .on('change', (e) => {
      togglePhysicsVisualizer(e.value);
    });
  debugGUI.addBinding(curScenePhysParams, 'gravity', { label: 'Gravity' }).on('change', (e) => {
    const currentSceneId = getCurrentSceneId();
    if (!currentSceneId) return;
    if (!physicsState.scenes[currentSceneId]) {
      physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
    }
    physicsState.scenes[currentSceneId].gravity = { ...e.value };
    curScenePhysParams = physicsState.scenes[currentSceneId];
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      currentScenePhysicsObjects[i].rigidBody?.wakeUp();
    }
    lsSetItem(LS_KEY, physicsState);
    if (!physicsWorld?.gravity) return;
    physicsWorld.gravity.x = e.value.x;
    physicsWorld.gravity.y = e.value.y;
    physicsWorld.gravity.z = e.value.z;
  });
  debugGUI
    .addBinding(curScenePhysParams, 'solverIterations', {
      label: 'Solver iterations',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].solverIterations = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
        currentScenePhysicsObjects[i].rigidBody?.wakeUp();
      }
      lsSetItem(LS_KEY, physicsState);
      physicsWorld.numSolverIterations = e.value;
    });
  debugGUI
    .addBinding(curScenePhysParams, 'internalPgsIterations', {
      label: 'Internal PGS iterations (run at each solver iteration)',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].internalPgsIterations = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
        currentScenePhysicsObjects[i].rigidBody?.wakeUp();
      }
      lsSetItem(LS_KEY, physicsState);
      physicsWorld.numInternalPgsIterations = e.value;
    });
  debugGUI
    .addBinding(curScenePhysParams, 'additionalFrictionIterations', {
      label: 'Additional friction iterations',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].additionalFrictionIterations = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
        currentScenePhysicsObjects[i].rigidBody?.wakeUp();
      }
      lsSetItem(LS_KEY, physicsState);
      physicsWorld.numAdditionalFrictionIterations = e.value;
    });
  debugGUI
    .addBinding(curScenePhysParams, 'interpolationEnabled', { label: 'Enable interpolation' })
    .on('change', () => {
      lsSetItem(LS_KEY, physicsState);
    });
};

export const EDIT_PHY_OBJ_WIN_ID = 'physicsObjectEditorWindow';
let debuggerWindowPane: Pane | null = null;
let debuggerWindowCmp: TCMP | null = null;

const getColliderShapeName = (enumNumber: number) => {
  switch (enumNumber) {
    case 0:
      return 'Ball';
    case 2:
      return 'Capsule';
    case 11:
      return 'Cone';
    case 9:
      return 'ConvexPolyhedron';
    case 1:
      return 'Cuboid';
    case 10:
      return 'Cylinder';
    case 17:
      return 'HalfSpace';
    case 7:
      return 'HeightField';
    case 4:
      return 'Polyline';
    case 15:
      return 'RoundCone';
    case 16:
      return 'RoundConvexPolyhedron';
    case 12:
      return 'RoundCuboid';
    case 14:
      return 'RoundCylinder';
    case 13:
      return 'RoundTriangle';
    case 3:
      return 'Segment';
    case 6:
      return 'TriMesh';
    case 5:
      return 'Triangle';
  }
  return '[UNKNOWN]';
};

export const createEditPhysObjContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const obj = currentScenePhysicsObjects.find((obj) => obj.id === d.id);
  if (debuggerWindowPane) {
    debuggerWindowPane.dispose();
    debuggerWindowPane = null;
  }
  if (debuggerWindowCmp) {
    debuggerWindowCmp.remove();
    debuggerWindowCmp = null;
  }
  if (!obj) {
    // We want to close the window when no phys object is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => {
      closeDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
    }, 0);
    return CMP();
  }

  addOnCloseToWindow(EDIT_PHY_OBJ_WIN_ID, () => {
    updateDebuggerPhysObjListSelectedClass(null);
  });
  updateDebuggerPhysObjListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    onRemoveCmp: () => (debuggerWindowPane = null),
  });

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  // @TODO: copy code button
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this physics object to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('PHYSICS OBJECT:***************', obj, '**********************');
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Remove physics object (only for this browser load, does not delete character permanently)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      deletePhysicsObject(obj.id);
      closeDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
    },
  });

  // const colliders = Array.isArray(obj.collider) ?

  debuggerWindowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Name:</span> ${obj.name || ''}</div>
  <div><span class="winSmallLabel">Id:</span> ${obj.id}</div>
  ${
    Array.isArray(obj.collider)
      ? `<div><span class="winSmallLabel">Colliders (${obj.collider.length}):</span> ${obj.collider.map((coll) => getColliderShapeName(coll.shape.type)).join(', ')}</div>`
      : `<div><span class="winSmallLabel">Collider:</span> ${getColliderShapeName(obj.collider.shape.type)}</div>`
  }
  ${Array.isArray(obj.collider) ? `<div><span class="winSmallLabel">Current obj index:</span> ${obj.currentObjectIndex || 0}</div>` : ''}
  ${
    Array.isArray(obj.meshes)
      ? `<div><span class="winSmallLabel">Meshes (${obj.meshes.length}):</span> ${obj.meshes.map((m) => m.userData.id).join(', ')}</div>`
      : `<div><span class="winSmallLabel">Mesh:</span> ${obj.mesh?.userData.id || '[No mesh]'}</div>`
  }
  ${Array.isArray(obj.collider) ? `<div><span class="winSmallLabel">Current mesh index:</span> ${obj.currentMeshIndex || 0}</div>` : ''}
</div>
<div style="text-align:right">${logButton}${deleteButton}</div>
</div>`,
  });

  if (obj.rigidBody) {
    const rigidBody = {
      position: obj.rigidBody.translation(),
      rotation: new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          obj.rigidBody.rotation().x,
          obj.rigidBody.rotation().y,
          obj.rigidBody.rotation().z,
          obj.rigidBody.rotation().w
        )
      ),
    };
    // Position
    const positionInput = debuggerWindowPane.addBinding(rigidBody, 'position', {
      label: 'Position',
    });
    debuggerWindowPane.addButton({ title: 'Set position' }).on('click', () => {
      obj.rigidBody?.setTranslation(
        new THREE.Vector3(rigidBody.position.x, rigidBody.position.y, rigidBody.position.z),
        true
      );
    });
    debuggerWindowPane.addButton({ title: 'Update position input' }).on('click', () => {
      rigidBody.position = obj.rigidBody?.translation() || rigidBody.position;
      positionInput.refresh();
    });
    debuggerWindowPane.addBlade({ view: 'separator' });
    // Rotation
    const rotationInput = debuggerWindowPane.addBinding(rigidBody, 'rotation', {
      label: 'Rotation',
      step: Math.PI / 8,
    });
    debuggerWindowPane.addButton({ title: 'Set rotation' }).on('click', () => {
      obj.rigidBody?.setRotation(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rigidBody.rotation.x, rigidBody.rotation.y, rigidBody.rotation.z)
        ),
        true
      );
    });
    debuggerWindowPane.addButton({ title: 'Update rotation input' }).on('click', () => {
      rigidBody.rotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          obj.rigidBody?.rotation().x,
          obj.rigidBody?.rotation().y,
          obj.rigidBody?.rotation().z,
          obj.rigidBody?.rotation().w
        )
      );
      rotationInput.refresh();
    });
  }

  return debuggerWindowCmp;
};

const buildPhysicsObjectsDebugList = () => {
  if (!physicsObjectsDebugList) physicsObjectsDebugList = CMP();

  let html = `<div><h3 class="listItemCount">${currentScenePhysicsObjects.length} physics objects:</h3>`;

  html += '<ul class="ulList">';
  for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
    const obj = currentScenePhysicsObjects[i];
    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
        if (winState?.isOpen && winState?.data?.id === obj.id) {
          closeDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
          return;
        }
        openDraggableWindow({
          id: EDIT_PHY_OBJ_WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit physics object: ${obj.name || `[${obj.id}]`}`,
          isDebugWindow: true,
          content: createEditPhysObjContent,
          data: { id: obj.id, winId: EDIT_PHY_OBJ_WIN_ID },
          closeOnSceneChange: true,
          onClose: () => updateDebuggerPhysObjListSelectedClass(null),
        });
        updateDebuggerPhysObjListSelectedClass(obj.id);
      },
      html: `<button class="listItemWithId">
  <span class="itemId">[${obj.id}]${Array.isArray(obj.collider) ? '<span class="additionalInfo">MULTI</span>' : ''}</span>
  <h4>${obj.name || `[${obj.id}]`}</h4>
</button>`,
    });

    html += `<li data-id="${obj.id}">${button}</li>`;
  }

  if (!currentScenePhysicsObjects.length) {
    html += `<li class="emptyState">No physics objects registered..</li>`;
  }
  html += '</ul></div>';

  physicsObjectsDebugList.update({ html: () => html });

  return physicsObjectsDebugList;
};

export const updatePhysObjectDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!isDebugEnvironment()) return;
  if (only !== 'WINDOW') buildPhysicsObjectsDebugList();
  if (only === 'LIST') return;
  const winState = getDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
  if (winState) updateDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
};

export const updateDebuggerPhysObjListSelectedClass = (id: string | null) => {
  const ulElem = physicsObjectsDebugList?.elem.getElementsByTagName('ul')[0];
  if (!ulElem) return;

  for (const child of ulElem.children) {
    child.classList.remove('selected');
    if (id === null) continue;
    const elemId = child.getAttribute('data-id');
    if (elemId === id) {
      child.classList.add('selected');
    }
  }
};

const initRapier = async () => {
  const mod = await import('@dimforge/rapier3d-compat');
  const RAPIER = mod.default;
  await RAPIER.init();
  return RAPIER;
};

/**
 * Initializes the Rapier physics
 * @param initPhysicsCallback ((Rapier.World, Rapier) => void) optional function that will be called after the physics have been initalized
 * @returns Promise<Rapier>
 */
export const InitRapierPhysics = async (
  initPhysicsCallback?: (physicsWorld: Rapier.World, RAPIER: typeof Rapier) => void
) => {
  const physicsConfig = getConfig().physics;
  const enabled = physicsConfig?.enabled || false;
  return enabled
    ? initRapier().then((rapier) => {
        physicsState = {
          ...physicsState,
          ...(physicsConfig?.timestep ? { timestep: physicsConfig.timestep } : {}),
          enabled,
        };
        physicsState.timestepRatio = 1 / (physicsState.timestep || 60);

        RAPIER = rapier;
        if (isDebugEnvironment()) {
          createDebugControls();
          stepperFn = stepperFnDebug;
        } else {
          stepperFn = stepperFnProduction;
        }
        if (initPhysicsCallback) initPhysicsCallback(physicsWorld as Rapier.World, RAPIER);

        return rapier;
      })
    : null;
};

export const addScenePhysicsLooper = (id: string, looper: ScenePhysicsLooper) =>
  (scenePhysicsLoopers[id] = looper);

export const deleteScenePhysicsLooper = (id: string) => delete scenePhysicsLoopers[id];

export const deleteAllScenePhysicsLoopers = () => {
  const looperKeys = Object.keys(scenePhysicsLoopers);
  for (let i = 0; i < looperKeys.length; i++) {
    deleteScenePhysicsLooper(looperKeys[i]);
  }
};

export const getCurrentScenePhysParams = () => {
  const currentSceneId = existsOrThrow(
    getCurrentSceneId(),
    "Could not get current scene id in 'getCurrentScenePhysParams'."
  );
  if (!physicsState.scenes[currentSceneId]) {
    physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
  }
  curScenePhysParams = physicsState.scenes[currentSceneId];
  return curScenePhysParams;
};
