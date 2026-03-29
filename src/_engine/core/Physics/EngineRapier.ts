import * as THREE from 'three/webgpu';
import type Rapier from '@dimforge/rapier3d-compat';
import { lerror, lwarn } from '../../utils/Logger';
import { getCurrentSceneId, isCurrentScene } from '../Scene';
import { getConfig, isDebugEnvironment } from '../Config';
import { deleteMesh, getMesh } from '../Mesh';
import { updatePhysicsPanel } from '../../debug/Stats';
import { existsOrThrow, ThreeVector3 } from '../../utils/helpers';
import { addVisibilityChangeFn, LoopState } from '../MainLoop';
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import { updateInputControllerLoopActions } from '../InputControls';
import { BufferGeometryUtils } from 'three/examples/jsm/Addons.js';
import {
  ColliderParams as ColliderParamsBase,
  isDynamicPhysicsObjectValid,
  PhysicsObject as PhysicsObjectBase,
  PhysicsParams as PhysicsParamsBase,
  PhysicsState,
  ScenePhysicsState,
  setPhysicsPauseTime,
} from './PhysicsUtils';

type RapierEvents = {
  collisionEventFn?: (
    collider1: Rapier.Collider,
    collider2: Rapier.Collider,
    started: boolean,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;
  contactForceEventFn?: (
    e: Rapier.TempContactForceEvent,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;
};

type PhysicsObject = Omit<
  PhysicsObjectBase,
  'rigidBody' | 'collider' | 'collisionEventFn' | 'contactForceEventFn'
> & {
  rigidBody?: Rapier.RigidBody;
  collider: Rapier.Collider | Rapier.Collider[];
  collisionEventFn?: RapierEvents['collisionEventFn'] | RapierEvents['collisionEventFn'][];
  contactForceEventFn?: RapierEvents['contactForceEventFn'] | RapierEvents['contactForceEventFn'][];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

type RapierColliderParams = DistributiveOmit<
  ColliderParamsBase,
  'collisionEventFn' | 'contactForceEventFn'
> &
  RapierEvents;

type PhysicsParams = Omit<PhysicsParamsBase, 'collider'> & {
  collider: RapierColliderParams;
};

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

// @CHORE: needs a setter function
let physicsState: PhysicsState = {
  enabled: false,
  physicsEngine: 'RAPIER',
  workerTarget: 'MAIN_THREAD',
  timestep: 60,
  timestepRatio: 1 / 60,
  backgroundBehavior: 'PAUSE',
  isPaused: false,
  pausedTime: 0,
  pauseDurationTotal: 0,
  pauseReason: null,
  minDeltaTime: 1 / 30,
  maxDeltaTime: 1 / 10,
  minSubSteps: 0,
  maxSubSteps: 60,
  scenes: {},
};

// @CHORE: check what needs to removed after other CHORES are done
const DEFAULT_SCENE_PHYS_STATE: ScenePhysicsState = {
  worldStepEnabled: true,
  visualizerEnabled: false,
  gravity: { x: 0, y: -9.81, z: 0 },
  solverIterations: 10,
  internalPgsIterations: 1,
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
const allPhysicsObjects: { [id: string]: PhysicsObject } = {};
let currentScenePhysicsObjects: PhysicsObject[] = [];
let debugMesh: THREE.LineSegments;

/** Creates a Rapier Rigid Body */
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
  if (rigidBodyParams.additionalMass !== undefined)
    rigidBody.setAdditionalMass(rigidBodyParams.additionalMass, wakeUp);
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

// @CHORE: split between PhysicsAPI.ts (Rapier stuff stays here, other stuff like size sniffing to PhysicsAPI.ts)
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
      if (geo?.type === 'BoxGeometry' || geo?.type === 'BufferGeometry') {
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
      if (geo?.type === 'SphereGeometry' || geo?.type === 'BufferGeometry') {
        radius = geo.userData.props?.params?.radius || radius;
      }
      shape = new RAPIER.Ball(colliderParams.radius || radius);
      break;
    case 'CAPSULE':
      {
        size = { halfHeight: 0.25, radius: 0.25 }; // Default values
        geo = mesh?.geometry;
        if (geo?.type === 'CapsuleGeometry' || geo?.type === 'BufferGeometry') {
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
        // @TODO: add logic helpers.ts setMeshCreatePropsToUserData to set the mesh dimensions props
        size = { halfHeight: 0.25, radius: 0.25 }; // Default values
        geo = mesh?.geometry;
        if (geo?.type === 'ConeGeometry' || geo?.type === 'BufferGeometry') {
          size.halfHeight = geo.userData.props?.params.height / 2 || size.halfHeight;
          size.radius = geo.userData.props?.params?.radius || size.radius;
        }
        shape = colliderParams.borderRadius
          ? new RAPIER.RoundCone(
              colliderParams.halfHeight || size.halfHeight,
              colliderParams.radius || size.radius,
              colliderParams.borderRadius
            )
          : new RAPIER.Cone(
              colliderParams.halfHeight || size.halfHeight,
              colliderParams.radius || size.radius
            );
      }
      break;
    case 'CYLINDER':
      size = { halfHeight: 0.5, radius: 1 }; // Default values
      geo = mesh?.geometry;
      if (geo?.type === 'CylinderGeometry' || geo?.type === 'BufferGeometry') {
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
      const message =
        'Could not find vertices and indices in the collider params for trimesh, nor was there mesh with vertices present. Could not create trimesh physics shape in createCollider.';
      lerror(message);
      throw new Error(message);
    case 'HEIGHTFIELD':
      geo = existsOrThrow(
        mesh?.geometry,
        'Could not find mesh or geometry in the mesh for heightfield. Could not create height field physics shape in createCollider.'
      );
      // Merge all vertices that share a position
      geo = BufferGeometryUtils.mergeVertices(geo);
      (mesh as THREE.Mesh).geometry = geo;

      let nRows = colliderParams.nrows || 0;
      let nCols = colliderParams.ncols || 0;

      // 1. Get the bounding box of your imported terrain mesh
      const bbox = new THREE.Box3().setFromObject(mesh as THREE.Object3D);
      // 2. Calculate the size
      const meshSize = new THREE.Vector3();
      bbox.getSize(meshSize);
      const scale = new RAPIER.Vector3(meshSize.x, 1, meshSize.z);

      const totalVertices = geo.attributes.position.count;

      if (!nCols && nRows > 0) {
        // Only nRows provided, count the ncols from vertices
        nCols = totalVertices / nRows;
      } else if (!nRows && nCols > 0) {
        // Only nCols provided, count the nrows from vertices
        nRows = totalVertices / nCols;
      } else if (!nRows && !nCols) {
        // No nRows or nCols provided, count them as a square (nRows === nCols)
        nRows = Math.sqrt(totalVertices) - 1;
        nCols = nRows;
        if (!Number.isInteger(nRows)) {
          lerror(
            `The HEIGHTFIELD importing failed because the squareroot of the totalVertices count (${totalVertices}) is not an integer (${nRows}). The vertices are either unindexed or the grid's number of columns does not match the number of rows. Index the vertices, use shade smooth, or provide the ncols and nrows as custom properties.`
          );
          break;
        }
      }
      const sizeX = nRows + 1;
      const sizeZ = nCols + 1;
      const heights = new Float32Array(sizeX * sizeZ);
      const posAttr = mesh?.geometry.attributes.position;
      for (let i = 0; i < sizeX; i++) {
        // Outer loop: X-axis (Rapier Rows)
        for (let j = 0; j < sizeZ; j++) {
          // Inner loop: Z-axis (Rapier Columns)
          // Rapier Index: i is row, j is column
          const rapierIndex = i * sizeZ + j;

          /**
           * THREE.JS INDEXING
           * Usually, Three.js stores grids Z-first, then X.
           * index = (z_index * total_vertices_in_x) + x_index
           */
          const flippedZ = sizeZ - 1 - j; // We need to flip the z-axis
          const threeIndex = flippedZ * sizeX + i;

          // Pull the Y height
          if (posAttr) {
            heights[rapierIndex] = posAttr.getY(threeIndex);
          }
        }
      }
      shape = new RAPIER.Heightfield(
        Math.round(nRows),
        Math.round(nCols),
        new Float32Array(heights),
        scale
      );
      break;
    case 'CONVEXHULL':
      const vertParams = colliderParams.vertices;
      if (vertParams) {
        shape = new RAPIER.ConvexPolyhedron(new Float32Array(vertParams));
      } else {
        geo = existsOrThrow(
          mesh?.geometry,
          'Could not find mesh or geometry in the mesh for convex hull. Could not create convex hull physics shape in createCollider.'
        );
        // 1. Get a copy of the geometry
        const geoClone = geo.clone();
        // 2. (Optional) If you haven't applied transforms in Blender,
        // Apply the mesh's local scale to the vertices here.
        geoClone.applyMatrix4(
          new THREE.Matrix4().makeScale(mesh?.scale.x || 1, mesh?.scale.y || 1, mesh?.scale.z || 1)
        );
        // 3. Center it so the physics hull is balanced on the Body's origin
        geoClone.center();
        // 4. Extract the clean, centered, scaled vertices, and create shape
        const vertices = geoClone.attributes.position.array;
        shape = new RAPIER.ConvexPolyhedron(new Float32Array(vertices));
        geoClone.dispose();
      }
      break;
  }

  if (!shape) {
    const message = 'Could not create collider shape in createCollider';
    lerror(message);
    throw new Error(message);
  }

  const colliderDesc = new RAPIER.ColliderDesc(shape);

  // @CHORE: create an optional geoOrientation param for collider physicsParams ('x' | 'z')
  // Since Rapier shapes start on Y, we rotate them if the Blender spine was X or Z (for CYLINDER and CAPSULE)
  if (geo?.userData.props?.params?.orientation === 'x') {
    // Rotate 90 degrees around Z to lay the cylinder along the X-axis
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    colliderDesc.setRotation(q);
  } else if (geo?.userData.props?.params?.orientation === 'z') {
    // Rotate 90 degrees around X to lay the cylinder along the Z-axis
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    colliderDesc.setRotation(q);
  }

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

  return colliderDesc as Rapier.ColliderDesc;
};

// @CHORE: split between PhysicsAPI.ts (Rapier stuff stays here, other stuff to PhysicsAPI.ts)
// @CHORE: change this function name to ... here in EngineRapier.ts
/**
 * Creates a new physics object without a mesh and registers it to the scene id (or current scene id if scene id is not provided) in the physicsObjects object.
 * @param id (string) physics object id
 * @param name (string) optional physics object name
 * @param physicsParams (PhysicsParams | PhysicsParams[]) Params (or and array of them) for the physics object(s) ({@link PhysicsParams}), if an array is provided, then the object will be a multi object
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
    setTranslation: (translation: { x?: number; y?: number; z?: number; wakeUp?: boolean }) => {
      if (rigidBody) {
        rigidBody.setTranslation(
          ThreeVector3.set(
            translation.x !== undefined ? translation.x : rigidBody.translation().x || 0,
            translation.y !== undefined ? translation.y : rigidBody.translation().y || 0,
            translation.z !== undefined ? translation.z : rigidBody.translation().z || 0
          ),
          translation.wakeUp === false ? false : true
        );
        return;
      }
      for (let i = 0; i < colliders.length; i++) {
        const collider = colliders[i];
        collider.setTranslation(
          ThreeVector3.set(
            translation.x !== undefined ? translation.x : collider.translation().x || 0,
            translation.y !== undefined ? translation.y : collider.translation().y || 0,
            translation.z !== undefined ? translation.z : collider.translation().z || 0
          )
        );
      }
    },
    setRotation: (rotation: {
      x?: number;
      y?: number;
      z?: number;
      w?: number;
      wakeUp?: boolean;
    }) => {
      // @TODO: add setRotation
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

// @CHORE: split between PhysicsAPI.ts (Rapier stuff stays here, other stuff to PhysicsAPI.ts)
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
        if (!m) {
          lwarn(meshWarnMsg, `Mesh id: ${mId}`);
          return;
        }
        m.visible = false;
        if (currentMeshIndex !== undefined && i === currentMeshIndex) {
          meshId = mId;
          mesh = m;
          m.visible = true;
          visibleMeshIsSet = true;
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
      const foundMesh =
        physicsParams[i].meshId && Array.isArray(meshes) && meshes.length
          ? meshes.find((m) => m.userData.id === physicsParams[i].meshId)
          : meshes[i] || mesh;
      const colliderDesc = createCollider(physicsParams[i], foundMesh);
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
    setTranslation: (
      translation: { x?: number; y?: number; z?: number; wakeUp?: boolean },
      meshGroup?: THREE.Group
    ) => {
      if (rigidBody) {
        rigidBody.setTranslation(
          ThreeVector3.set(
            translation.x !== undefined ? translation.x : rigidBody.translation().x,
            translation.y !== undefined ? translation.y : rigidBody.translation().y,
            translation.z !== undefined ? translation.z : rigidBody.translation().z
          ),
          translation.wakeUp === false ? false : true
        );
      } else {
        for (let i = 0; i < colliders.length; i++) {
          const collider = colliders[i];
          collider.setTranslation(
            ThreeVector3.set(
              translation.x !== undefined ? translation.x : collider.translation().x,
              translation.y !== undefined ? translation.y : collider.translation().y,
              translation.z !== undefined ? translation.z : collider.translation().z
            )
          );
        }
      }
      if (meshGroup) {
        // If a meshGroup is provided, then translate that instead of individual meshes
        meshGroup.position.set(
          translation.x !== undefined ? translation.x : meshGroup.position.x,
          translation.y !== undefined ? translation.y : meshGroup.position.y,
          translation.z !== undefined ? translation.z : meshGroup.position.z
        );
      } else {
        mesh.position.set(
          translation.x !== undefined ? translation.x : mesh.position.x,
          translation.y !== undefined ? translation.y : mesh.position.y,
          translation.z !== undefined ? translation.z : mesh.position.z
        );
        for (let i = 0; i < meshes.length; i++) {
          const curMesh = meshes[i];
          curMesh.position.set(
            translation.x !== undefined ? translation.x : mesh.position.x,
            translation.y !== undefined ? translation.y : mesh.position.y,
            translation.z !== undefined ? translation.z : mesh.position.z
          );
        }
      }
    },
    setRotation: (rotation: {
      x?: number;
      y?: number;
      z?: number;
      w?: number;
      wakeUp?: boolean;
    }) => {
      // @TODO: add setRotation
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

// @CHORE: refactor (this and the one in PhysicsAPI.ts)
// @CHORE: add removeRigidBodyFromWorld and removeColliderFromWorld to here
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
    // Delete rigidBody (also deletes all child colliders)
    physicsWorld.removeRigidBody(obj.rigidBody);
  } else {
    // If the object does not have a rigidBody then delete the individual colliders
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

  // Delete possible meshes
  if (obj.meshes?.length) {
    for (let i = 0; i < obj.meshes.length; i++) {
      const mesh = obj.meshes[i];
      if (mesh?.userData.id) deleteMesh(mesh.userData.id, { deleteAll: true });
    }
  }
  if (obj.mesh?.userData.id) deleteMesh(obj.mesh.userData.id, { deleteAll: true });

  updatePhysObjectDebuggerGUI('LIST');
};

/** Returns the current physicsState */
export const getPhysicsState = () => physicsState;

// @CHORE: refactor so that the currentSceneId is passed as a parameter
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
  physicsWorld = new RAPIER.World(new RAPIER.Vector3(gravity.x, gravity.y, gravity.z));
  physicsWorld.timestep = physicsState.timestepRatio;
  physicsWorldEnabled = true;
  if (solverIterations) physicsWorld.numSolverIterations = solverIterations;
  if (internalPgsIterations) physicsWorld.numInternalPgsIterations = internalPgsIterations;

  // @CHORE: move to PhysicsAPI.ts and out of createPhysicsWorld (could be already done, check)
  if (isDebugEnvironment()) initDebuggerScenePhysState();
  addVisibilityChangeFn('pausePhysicsOnVisibilityChange', physicsVisibilityChange);
};

// @CHORE: add to PhysicsAPI.ts and refactor (this and the new one)
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
      'Trying to access RAPIER physicsWorld object but physics has not been initalized. Call "await InitPhysics()" in the "InitEngine" callback.';
    lerror(message);
    throw new Error(message);
  }
  return physicsWorld as Rapier.World;
};

/**
 * Return a physics object by id and sceneId
 * @param id string
 * @param sceneId optional string, if not provided the current scene id will be used
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const getPhysicsObject = (id: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'getPhysicsObject');
  const scenePhysicsObjects = physicsObjects[sId];
  if (!scenePhysicsObjects) return undefined;
  return scenePhysicsObjects[id];
};

// @CHORE: Refactor the stepper(s) to be in both PhysicsAPI.ts and EngineRapier.ts
let accDelta = 0;
let timerRunning = true;
const timer = new THREE.Timer();
const updateTimer = () => {
  if (timerRunning) {
    timer.update();
  }
};

const prevTransforms = new Map<number, { pos: THREE.Vector3; rot: THREE.Quaternion }>();
const currTransforms = new Map<number, { pos: THREE.Vector3; rot: THREE.Quaternion }>();

// Different stepper functions to use for debug and production.
// baseStepper is used for both.
const baseStepper = (loopState: LoopState) => {
  updateTimer();
  if (loopState.isLoadingScene) return;

  let delta = timer.getDelta();
  if (loopState.isWindowHidden || !loopState.masterPlay || !loopState.appPlay) {
    if (
      physicsState.backgroundBehavior === 'KEEP_RUNNING_USE_MIN_DELTA' &&
      physicsState.minDeltaTime > 0
    ) {
      delta = physicsState.minDeltaTime;
    } else if (
      physicsState.backgroundBehavior === 'PAUSE' ||
      !loopState.masterPlay ||
      !loopState.appPlay
    ) {
      setPhysicsPauseTime(physicsState);
      physicsState.isPaused = true;
      timerRunning = false;
      return;
    }
  } else if (physicsState.isPaused) {
    timerRunning = true;
    updateTimer();
    delta = timer.getDelta();
    delta = 0;
    accDelta = 0;
    if (physicsState.minDeltaTime > 0) delta = physicsState.minDeltaTime;
    physicsState.isPaused = false;
    physicsState.pauseDurationTotal += performance.now() - physicsState.pausedTime;
    physicsState.pausedTime = 0;
  }
  let stepsTaken = 0;
  const scaledDelta = delta * loopState.playSpeedMultiplier;
  accDelta += scaledDelta;
  if (physicsState.maxDeltaTime > 0) delta = Math.min(delta, physicsState.maxDeltaTime);

  while (
    accDelta >= physicsState.timestepRatio &&
    (physicsState.minSubSteps === 0 || stepsTaken <= physicsState.minSubSteps) &&
    (physicsState.maxSubSteps === 0 || stepsTaken < physicsState.maxSubSteps)
  ) {
    if (physicsState.isPaused) break;

    // Update loop action inputs
    // @CHORE: all loopers need to be run in the main thread.
    updateInputControllerLoopActions(physicsState.timestepRatio);

    // Store previous transforms
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      const po = currentScenePhysicsObjects[i];
      // @CHORE: isDynamicPhysicsObjectValid needs to have the correct type and should be in this file.
      if (!isDynamicPhysicsObjectValid(po)) continue;
      const rb = po.rigidBody as RigidBody;
      const handle = rb.handle;
      const t = rb.translation();
      const r = rb.rotation();
      // 1. Ensure storage exists (allocate once)
      if (!prevTransforms.has(handle)) {
        prevTransforms.set(handle, { pos: new THREE.Vector3(), rot: new THREE.Quaternion() });
        currTransforms.set(handle, { pos: new THREE.Vector3(), rot: new THREE.Quaternion() });
      }
      const prev = prevTransforms.get(handle)!;
      const curr = currTransforms.get(handle)!;
      // 2. Cycle the data: Current becomes Previous
      prev.pos.copy(curr.pos);
      prev.rot.copy(curr.rot);
      // 3. Update Current from Rapier (Zero Allocation)
      curr.pos.set(t.x, t.y, t.z);
      curr.rot.set(r.x, r.y, r.z, r.w);
    }

    // @CHORE: This logic cannot work like this. We need to somehow drain and mark the events here and then pass them to the PhysicsAPI to run the functions in the main thread.
    // if (collisionEventFnCount) {
    //   eventQueue?.drainCollisionEvents((handle1, handle2, started) => {
    //     let collider1: Collider | null = null;
    //     let collider2: Collider | null = null;
    //     const physObj1 = currentScenePhysicsObjects.find((obj) => {
    //       if (Array.isArray(obj.collider)) {
    //         const foundCollider = obj.collider.find((collider) => collider.handle === handle1);
    //         if (foundCollider) {
    //           collider1 = foundCollider;
    //           return true;
    //         }
    //         return false;
    //       }
    //       if (obj.collider.handle === handle1) {
    //         collider1 = obj.collider;
    //         return true;
    //       }
    //       return false;
    //     });
    //     const physObj2 = currentScenePhysicsObjects.find((obj) => {
    //       if (Array.isArray(obj.collider)) {
    //         const foundCollider = obj.collider.find((collider) => collider.handle === handle2);
    //         if (foundCollider) {
    //           collider2 = foundCollider;
    //           return true;
    //         }
    //         return false;
    //       }
    //       if (obj.collider.handle === handle2) {
    //         collider2 = obj.collider;
    //         return true;
    //       }
    //       return false;
    //     });
    //     if (!collider1 || !collider2) return;
    //     if (physObj1?.collisionEventFn && physObj2) {
    //       if (Array.isArray(physObj1.collisionEventFn)) {
    //         for (let i = 0; i < physObj1.collisionEventFn.length; i++) {
    //           physObj1.collisionEventFn[i](collider1, collider2, started, physObj1, physObj2);
    //         }
    //       } else {
    //         physObj1.collisionEventFn(collider1, collider2, started, physObj1, physObj2);
    //       }
    //     }
    //     if (physObj2?.collisionEventFn && physObj1) {
    //       if (Array.isArray(physObj2.collisionEventFn)) {
    //         for (let i = 0; i < physObj2.collisionEventFn.length; i++) {
    //           physObj2.collisionEventFn[i](collider1, collider2, started, physObj1, physObj2);
    //         }
    //       } else {
    //         physObj2.collisionEventFn(collider1, collider2, started, physObj1, physObj2);
    //       }
    //     }
    //   });
    // }

    // if (contactForceEventFnCount) {
    //   eventQueue?.drainContactForceEvents((event) => {
    //     const handle1 = event.collider1();
    //     const handle2 = event.collider2();
    //     const physObj1 = currentScenePhysicsObjects.find((obj) => {
    //       if (Array.isArray(obj.collider)) {
    //         return Boolean(obj.collider.find((collider) => collider.handle === handle1));
    //       }
    //       return obj.collider.handle === handle1;
    //     });
    //     const physObj2 = currentScenePhysicsObjects.find((obj) => {
    //       if (Array.isArray(obj.collider)) {
    //         return Boolean(obj.collider.find((collider) => collider.handle === handle2));
    //       }
    //       return obj.collider.handle === handle2;
    //     });
    //     if (physObj1?.contactForceEventFn && physObj2) {
    //       if (Array.isArray(physObj1.contactForceEventFn)) {
    //         for (let i = 0; i < physObj1.contactForceEventFn.length; i++) {
    //           physObj1.contactForceEventFn[i](event, physObj1, physObj2);
    //         }
    //       } else {
    //         physObj1.contactForceEventFn(event, physObj1, physObj2);
    //       }
    //     }
    //     if (physObj2?.contactForceEventFn && physObj1) {
    //       if (Array.isArray(physObj2.contactForceEventFn)) {
    //         for (let i = 0; i < physObj2.contactForceEventFn.length; i++) {
    //           physObj2.contactForceEventFn[i](event, physObj1, physObj2);
    //         }
    //       } else {
    //         physObj2.contactForceEventFn(event, physObj1, physObj2);
    //       }
    //     }
    //   });
    // }

    // Run scenePhysicsLoopers
    // @CHORE: all loopers need to be run in the main thread.
    const looperKeys = Object.keys(scenePhysicsLoopers);
    for (let i = 0; i < looperKeys.length; i++) {
      scenePhysicsLoopers[looperKeys[i]](physicsState.timestepRatio);
    }

    // Step the world
    physicsWorld.step(eventQueue);

    accDelta -= physicsState.timestepRatio;
    stepsTaken++;
  }

  // Run scenePhysicsAfterStepLoopers
  // @CHORE: all loopers need to be run in the main thread.
  const afterStepLooperKeys = Object.keys(scenePhysicsAfterStepLoopers);
  for (let i = 0; i < afterStepLooperKeys.length; i++) {
    scenePhysicsAfterStepLoopers[afterStepLooperKeys[i]](scaledDelta);
  }
};

// PRODUCTION STEPPER
const stepperFnProduction = (loopState: LoopState) => baseStepper(loopState);

// DEBUG STEPPER
const stepperFnDebug = (loopState: LoopState) => {
  const startMeasuring = performance.now();

  const curSceneParams = physicsState.scenes[getCurrentSceneId() || ''];
  if (!curSceneParams?.worldStepEnabled) return;

  baseStepper(loopState);

  if (!loopState.masterPlay || !loopState.appPlay) return;

  // @CHORE: rewrite this part in the renderPhysicsObjects

  // if (physicsWorldEnabled && debugMesh && curSceneParams?.visualizerEnabled) {
  //   // Physics debug visualizer
  //   const { vertices, colors } = physicsWorld.debugRender();

  //   debugMesh.visible = true;

  //   let currentGeo = debugMesh.geometry;
  //   const posAttr = currentGeo.attributes.position;

  //   // Check if we need to resize (Grow the buffer)
  //   if (vertices.length > posAttr.array.length) {
  //     // 1. Dispose of the old geometry to free GPU memory
  //     currentGeo.dispose();

  //     // 2. Create a BRAND NEW Geometry
  //     const newGeo = new THREE.BufferGeometry();

  //     // 3. Allocate LARGER buffers
  //     const newSize = vertices.length + 5000; // Add generous padding to avoid frequent resizing
  //     newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newSize), 3));
  //     newGeo.setAttribute(
  //       'color',
  //       new THREE.BufferAttribute(new Float32Array((newSize / 3) * 4), 4)
  //     );
  //     newGeo.boundingSphere = new THREE.Sphere();
  //     newGeo.boundingSphere.radius = Infinity;

  //     // 4. Assign the new geometry to the mesh
  //     // This forces the renderer to bind the new, larger buffer immediately
  //     debugMesh.geometry = newGeo;

  //     // Update local reference
  //     currentGeo = newGeo;
  //   }

  //   // Update Data
  //   // We get the *latest* attribute reference in case we just resized it
  //   const finalPosAttr = currentGeo.attributes.position as THREE.BufferAttribute;
  //   const finalColAttr = currentGeo.attributes.color as THREE.BufferAttribute;

  //   // Copy data into the existing typed arrays
  //   // .set is very fast for Float32Array
  //   finalPosAttr.array.set(vertices);
  //   finalColAttr.array.set(colors);

  //   // Mark as needing upload to GPU
  //   finalPosAttr.needsUpdate = true;
  //   finalColAttr.needsUpdate = true;

  //   // CRITICAL: Tell GPU how many vertices to actually draw
  //   // If buffer has 10,000 spots but we only have 50 vertices, draw only 50.
  //   // vertices is a Float32Array (x,y,z), so vertex count is length / 3
  //   currentGeo.setDrawRange(0, vertices.length / 3);
  // } else {
  //   debugMesh.visible = false;
  // }

  const stopMeasuring = performance.now();
  updatePhysicsPanel(stopMeasuring - startMeasuring);
};

/**
 * Steps the physics world (called in the main loop) and sets mesh positions and rotations in the current scene.
 */
export const stepPhysicsWorld = (loopState: LoopState) => stepperFn(loopState);

// @CHORE: if the initialisation in the worker does not work from PhysicsUtils.ts, then this is still needed for the physicsWorker.ts, but it might need refactoring (change name to InitPhysics)
const initRapier = async () => {
  const mod = await import('@dimforge/rapier3d-compat');
  const RAPIER = mod.default;
  await RAPIER.init();
  return RAPIER;
};

// @CHORE: if the initialisation in the worker does not work from PhysicsUtils.ts, then this is still needed for the physicsWorker.ts, but it might need refactoring (change name to InitPhysics)
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
          createPhysicsDebugMesh();
          stepperFn = stepperFnDebug;
        } else {
          stepperFn = stepperFnProduction;
        }
        if (initPhysicsCallback) initPhysicsCallback(physicsWorld as Rapier.World, RAPIER);

        return rapier;
      })
    : null;
};
