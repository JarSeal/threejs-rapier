import * as THREE from 'three/webgpu';
import Rapier from '@dimforge/rapier3d';
import { lerror, lwarn } from '../utils/Logger';
import { getCurrentScene, getCurrentSceneId, getScene, isCurrentScene } from './Scene';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getEnv, isDebugEnvironment } from './Config';
import { createDebuggerTab, createNewDebuggerPane } from '../debug/DebuggerGUI';
import { getMesh } from './Mesh';

export type PhysicsObject = {
  id?: string;
  mesh: THREE.Mesh;
  collider: Rapier.Collider;
  rigidBody?: Rapier.RigidBody;
};

export type PhysicsParams = {
  /** Collider type and params */
  collider: (
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
  };

  /** Rigid body type and params */
  rigidBody?: {
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
  };
};

type PhysicsState = {
  stepperEnabled: boolean;
  timestep: number;
  timestepRatio: number;
  gravity: { x: number; y: number; z: number };
  visualizerEnabled: boolean;
};

let physicsState: PhysicsState = {
  stepperEnabled: true,
  timestep: 60,
  timestepRatio: 1 / 60,
  gravity: { x: 0, y: -9.81, z: 0 },
  visualizerEnabled: false,
};

const LS_KEY = 'debugPhysics';
let stepperFn = (_: number) => {};
let accDelta = 0;
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World = { step: () => {} } as Rapier.World;
const physicsObjects: { [sceneId: string]: { [id: string]: PhysicsObject } } = {};
let currentScenePhysicsObjects: PhysicsObject[] = [];
let debugMesh: THREE.LineSegments;
let debugMeshGeo: THREE.BufferGeometry;
let debugMeshMat: THREE.LineBasicMaterial;

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

const createRigidBody = (physicsParams: PhysicsParams) => {
  const rigidBodyParams = physicsParams.rigidBody;
  let rigidBody: Rapier.RigidBody | undefined = undefined;
  let rigidBodyDesc: Rapier.RigidBodyDesc;

  if (!rigidBodyParams) return undefined;

  switch (rigidBodyParams.rigidType) {
    case 'DYNAMIC':
      rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic();
      rigidBody = getPhysicsWorld().createRigidBody(rigidBodyDesc);
      break;
    case 'POS_BASED':
      rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      rigidBody = getPhysicsWorld().createRigidBody(rigidBodyDesc);
      break;
    case 'VELO_BASED':
      rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicVelocityBased();
      rigidBody = getPhysicsWorld().createRigidBody(rigidBodyDesc);
      break;
    case 'FIXED':
    default:
      rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
      rigidBody = getPhysicsWorld().createRigidBody(rigidBodyDesc);
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
      rigidBodyParams.lockTranslations.x,
      rigidBodyParams.lockTranslations.y,
      rigidBodyParams.lockTranslations.z,
      wakeUp
    );
  }
  if (rigidBodyParams.lockRotations) {
    rigidBody.lockRotations(true, wakeUp);
    rigidBody.setEnabledRotations(
      rigidBodyParams.lockRotations.x,
      rigidBodyParams.lockRotations.y,
      rigidBodyParams.lockRotations.z,
      wakeUp
    );
  }
  if (rigidBodyParams.linearDamping) rigidBody.setLinearDamping(rigidBodyParams.linearDamping);
  if (rigidBodyParams.angularDamping) rigidBody.setAngularDamping(rigidBodyParams.angularDamping);
  if (rigidBodyParams.dominance) rigidBody.setDominanceGroup(rigidBodyParams.dominance);
  if (rigidBodyParams.ccdEnabled) rigidBody.enableCcd(rigidBodyParams.ccdEnabled);
  if (rigidBodyParams.softCcdDistance)
    rigidBody.setSoftCcdPrediction(rigidBodyParams.softCcdDistance);

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

const createCollider = (physicsParams: PhysicsParams, mesh: THREE.Mesh) => {
  const colliderParams = physicsParams.collider;
  let shape: Rapier.Shape | null = null;
  let geo: THREE.BufferGeometry;
  let size: { [key: string]: number };

  switch (colliderParams.type) {
    case 'CUBOID':
    case 'BOX':
      size = { hx: 0.5, hy: 0.5, hz: 0.5 };
      geo = mesh.geometry;
      if (geo.type === 'BoxGeometry') {
        size.hx = mesh.geometry.userData.props?.params?.width / 2 || size.hx;
        size.hx = mesh.geometry.userData.props?.params?.height / 2 || size.hy;
        size.hx = mesh.geometry.userData.props?.params?.depth / 2 || size.hz;
      }
      shape = colliderParams.borderRadius
        ? new RAPIER.RoundCuboid(
            colliderParams.hx || size.hx,
            colliderParams.hy || size.hy,
            colliderParams.hz || size.hz,
            colliderParams.borderRadius || 0
          )
        : new RAPIER.Cuboid(
            colliderParams.hx || size.hx,
            colliderParams.hy || size.hy,
            colliderParams.hz || size.hz
          );
      break;
    case 'BALL':
    case 'SPHERE':
      let radius = 0.5;
      geo = mesh.geometry;
      if (geo.type === 'SphereGeometry') {
        radius = geo.userData.props?.params?.radius || radius;
      }
      shape = new RAPIER.Ball(colliderParams.radius || radius);
      break;
    case 'CAPSULE':
      shape = new RAPIER.Capsule(colliderParams.halfHeight || 0.25, colliderParams.radius || 0.25);
      break;
    case 'CONE':
      shape = colliderParams.borderRadius
        ? new RAPIER.RoundCone(
            colliderParams.halfHeight || 0.25,
            colliderParams.radius || 0.25,
            colliderParams.borderRadius || 0
          )
        : new RAPIER.Cone(colliderParams.halfHeight || 0.25, colliderParams.radius || 0.25);
      break;
    case 'CYLINDER':
      size = { halfHeight: 0.5, radius: 1 };
      geo = mesh.geometry;
      if (geo.type === 'CylinderGeometry') {
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
            colliderParams.borderRadius || 0
          )
        : new RAPIER.Cylinder(
            colliderParams.halfHeight || size.halfHeight,
            colliderParams.radius || size.radius
          );
      break;
    case 'TRIANGLE':
      shape = colliderParams.borderRadius
        ? new RAPIER.RoundTriangle(
            colliderParams.a,
            colliderParams.b,
            colliderParams.c,
            colliderParams.borderRadius || 0
          )
        : new RAPIER.Triangle(colliderParams.a, colliderParams.b, colliderParams.c);
      break;
    case 'TRIMESH':
      geo = mesh.geometry;
      if (colliderParams.vertices && colliderParams.indices) {
        shape = new RAPIER.TriMesh(colliderParams.vertices, colliderParams.indices);
        break;
      } else if (geo) {
        // size = { hx: 0.5, hy: 0.5, hz: 0.5 };
        // geo = mesh.geometry;
        // shape = new RAPIER.Cuboid(size.hx, size.hy, size.hz);
        // break;
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
      const message = `Could not find vertices and indices in the collider params, nor was there mesh with vertices present. Could not create trimesh physics shape in createCollider.`;
      lerror(message);
      throw new Error(message);
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

  return colliderDesc;
};

/**
 * Creates a new physics object and registers it to the scene id (or current scene id if scene id is not provided) in the physicsObjects object.
 * @param physicsParamas (PhysicsParams) ({@link PhysicsParams})
 * @param meshOrMeshId (THREE.Mesh | string) mesh or mesh id of the representation of the physics object
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional value to suppress logger warning for unitialized scene (true = no warning, default = false)
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const createPhysicsObjectWithMesh = (
  physicsParams: PhysicsParams,
  meshOrMeshId: THREE.Mesh | string,
  sceneId?: string,
  noWarnForUnitializedScene?: boolean
) => {
  const sId = getSceneIdForPhysics(sceneId, 'createPhysicsObject', noWarnForUnitializedScene);
  let id: string;
  let mesh: THREE.Mesh;

  if (typeof meshOrMeshId === 'string') {
    id = meshOrMeshId;
    mesh = getMesh(id);
    if (!mesh) {
      lwarn(
        `Could not find mesh with id "${id}" in createPhysicsObjectWithMesh. Physics object was not added.`
      );
      return;
    }
  } else {
    id = meshOrMeshId.userData.id;
    mesh = meshOrMeshId;
  }
  mesh.userData.isPhysicsObject = true;

  const rigidBody = createRigidBody(physicsParams);
  const colliderDesc = createCollider(physicsParams, mesh);
  const collider = getPhysicsWorld().createCollider(colliderDesc, rigidBody);

  const physObj: PhysicsObject = {
    id,
    mesh,
    ...(rigidBody ? { rigidBody } : {}),
    collider,
  };
  if (!physicsObjects[sId]) physicsObjects[sId] = {};
  physicsObjects[sId][id] = physObj;

  if (sId === getCurrentSceneId()) {
    currentScenePhysicsObjects.push(physObj);
  }

  return physObj;
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
  physicsWorld.removeCollider(obj.collider, false);
  if (obj.rigidBody) physicsWorld.removeRigidBody(obj.rigidBody);

  delete scenePhysicsObjects[id];

  if (sId === getCurrentSceneId()) {
    currentScenePhysicsObjects = currentScenePhysicsObjects.filter(
      (obj) => obj.mesh.userData.id !== id
    );
  }

  if (isCurrentScene(sId)) {
    currentScenePhysicsObjects.filter((obj) => obj.id !== id);
  }
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
};

/**
 * Creates the physics world and sets gravity
 */
export const createPhysicsWorld = () => {
  physicsWorld = new RAPIER.World(
    new THREE.Vector3(physicsState.gravity.x, physicsState.gravity.y, physicsState.gravity.z)
  );
};

/**
 * Deletes the physics world and all its children
 */
export const deletePhysicsWorld = () => {
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
export const createPhysicsDebugMesh = (onUpdate?: boolean) => {
  if (!onUpdate && debugMesh) debugMesh.removeFromParent();
  if (!onUpdate && debugMeshGeo) debugMeshGeo.dispose();
  debugMeshGeo = new THREE.BufferGeometry();
  if (onUpdate) {
    debugMesh.geometry = debugMeshGeo;
  } else {
    if (!debugMeshMat)
      debugMeshMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
      });
    debugMesh = new THREE.LineSegments(debugMeshGeo, debugMeshMat);
    debugMesh.frustumCulled = false;
    getCurrentScene().add(debugMesh);
  }
};

// Different stepper functions to use for debug and production
const baseStepper = (delta: number) => {
  accDelta += delta;
  if (accDelta < physicsState.timestepRatio) return;
  accDelta = accDelta % physicsState.timestepRatio;

  // Step the world
  physicsWorld.step();

  // Set physics objects mesh positions and rotations
  for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
    const po = currentScenePhysicsObjects[i];
    if (po.id === 'importedMesh01') continue;
    po.mesh.position.copy(po.collider.translation());
    po.mesh.quaternion.copy(po.collider.rotation());
    // Uncomment for debug of dynamic bodies
    // if (po.rigidBody?.bodyType() === Rapier.RigidBodyType.Dynamic && !po.rigidBody?.isSleeping()) {
    //   console.log(po.id, `Index: ${i}`, po.collider.translation());
    // }
  }
};
const stepperFnProduction = (delta: number) => {
  baseStepper(delta);
};
const stepperFnDebug = (delta: number) => {
  if (!physicsState.stepperEnabled) return;

  baseStepper(delta);

  if (physicsState.visualizerEnabled) {
    const { vertices, colors } = physicsWorld.debugRender();
    createPhysicsDebugMesh(true);
    debugMesh.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    debugMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    debugMesh.visible = true;
    debugMesh.geometry.getAttribute('position').needsUpdate = true;
  } else {
    debugMesh.visible = false;
  }
};

/**
 * Steps the physics world (called in main loop) and sets mesh positions and rotations in the current scene.
 */
export const stepPhysicsWorld = (delta: number) => stepperFn(delta);

/**
 * Changes the scene to be used for the scene's physics objects (optimizes the stepping)
 * @param sceneId string of the new scene id to change to
 */
export const setCurrentScenePhysicsObjects = (sceneId: string | null) => {
  if (!RAPIER) return;

  currentScenePhysicsObjects = [];

  if (!sceneId) return;

  const allNewPhysicsObjects = physicsObjects[sceneId];
  if (!allNewPhysicsObjects) return;

  const keys = Object.keys(allNewPhysicsObjects);
  for (let i = 0; i < keys.length; i++) {
    if (!allNewPhysicsObjects[keys[i]]) continue;
    currentScenePhysicsObjects.push(allNewPhysicsObjects[keys[i]]);
  }

  createPhysicsDebugMesh();
};

const createDebugGUI = () => {
  const savedValues = lsGetItem(LS_KEY, physicsState);
  physicsState = {
    ...physicsState,
    ...savedValues,
  };
  physicsState.timestepRatio = 1 / (physicsState.timestep || 60);
  physicsWorld.gravity = physicsState.gravity;

  createDebuggerTab({
    id: 'physicsControls',
    buttonText: 'PHYSICS',
    title: 'Physics controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('physics', 'Physics Controls');
      debugGUI
        .addBinding(physicsState, 'stepperEnabled', { label: 'Enable world step' })
        .on('change', () => {
          lsSetItem(LS_KEY, physicsState);
        });
      debugGUI
        .addBinding(physicsState, 'visualizerEnabled', { label: 'Enable visualizer' })
        .on('change', () => {
          lsSetItem(LS_KEY, physicsState);
        });
      debugGUI
        .addBinding(physicsState, 'timestep', { label: 'Timestep (1 / ts)', step: 1, min: 1 })
        .on('change', (e) => {
          physicsState.timestepRatio = 1 / e.value;
          lsSetItem(LS_KEY, physicsState);
        });
      debugGUI.addBinding(physicsState, 'gravity', { label: 'Gravity' }).on('change', (e) => {
        physicsWorld.gravity.x = e.value.x;
        physicsWorld.gravity.y = e.value.y;
        physicsWorld.gravity.z = e.value.z;
        for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
          currentScenePhysicsObjects[i].rigidBody?.wakeUp();
        }
        lsSetItem(LS_KEY, physicsState);
      });

      return container;
    },
  });
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

const initRapier = async () => {
  const mod = await import('@dimforge/rapier3d');
  const RAPIER = mod.default;
  return RAPIER;
};

/**
 * Initializes the Rapier physics
 * @param initPhysicsCallback ((Rapier.World, Rapier) => void) optional function that will be called after the physics have been initalized
 * @returns Promise<Rapier>
 */
export const InitRapierPhysics = async (
  initPhysicsCallback?: (physicsWorld: Rapier.World, RAPIER: typeof Rapier) => void
) =>
  initRapier().then((rapier) => {
    const gravity = getEnv<{ x: number; y: number; z: number }>('VITE_GRAVITY');
    const timestep = getEnv<number>('VITE_TIMESTEP');
    physicsState = {
      ...physicsState,
      ...(gravity ? { gravity } : {}),
      ...(timestep ? { timestep } : {}),
    };
    physicsState.timestepRatio = 1 / (physicsState.timestep || 60);

    RAPIER = rapier;
    createPhysicsWorld();
    physicsWorld.timestep = physicsState.timestepRatio;
    if (isDebugEnvironment()) {
      createDebugGUI();
      stepperFn = stepperFnDebug;
    } else {
      stepperFn = stepperFnProduction;
    }
    if (initPhysicsCallback) initPhysicsCallback(physicsWorld as Rapier.World, RAPIER);
  });
