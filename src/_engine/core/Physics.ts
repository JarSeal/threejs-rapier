import * as THREE from 'three/webgpu';
import Rapier from '@dimforge/rapier3d';
import { lerror, lwarn } from '../utils/Logger';
import { getCurrentSceneId, getScene } from './Scene';

export type PhysicsObject = {
  id?: string;
  mesh: THREE.Mesh;
  collider: Rapier.Collider;
  rigidBody: Rapier.RigidBody;
  // fn?: Function;
  // autoAnimate: boolean;
};

// @TODO: add these values to env, LS, and debugger controllable values
const GRAVITY = new THREE.Vector3(0, -9.81, 0);
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World | { step: () => void } = { step: () => {} };
const physicsObjects: { [sceneId: string]: { [id: string]: PhysicsObject } } = {};
let currentScenePhysicsObjects: PhysicsObject[] = [];

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

const initRapier = async () => {
  const mod = await import('@dimforge/rapier3d');
  const RAPIER = mod.default;
  return RAPIER;
};

// @TODO: add jsDoc
export const InitPhysics = async (
  initPhysicsUpdate?: (RAPIER: typeof Rapier, physicsWorld: Rapier.World) => boolean
) => {
  return initRapier().then((rapier) => {
    RAPIER = rapier;
    physicsWorld = new RAPIER.World(GRAVITY);
    if (initPhysicsUpdate) initPhysicsUpdate(RAPIER, physicsWorld as Rapier.World);
  });
};

/**
 * Registers the physics object to the scene id (or current scene id) in the physicsObjects object.
 * @param obj PhysicsObject ({@link PhysicsObject})
 * @param sceneId optional scene id string where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene optional boolean to suppress logger warning for unitialized scene (true = no warning, default = false)
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const addPhysicsObject = (
  obj: PhysicsObject,
  sceneId?: string,
  noWarnForUnitializedScene?: boolean
) => {
  const sId = getSceneIdForPhysics(sceneId, 'addPhysicsObject', noWarnForUnitializedScene);

  const id = obj.id ? obj.id : obj.mesh.userData.id || obj.mesh.uuid;
  obj.mesh.userData.isPhysicsObject = true;
  physicsObjects[sId][id] = obj;

  if (sceneId === getCurrentSceneId()) {
    currentScenePhysicsObjects.push(obj);
  }

  return obj;
};

/**
 * Removes a physics object (WIP, check the TODOs after this jsDoc)
 * @param id string
 * @param sceneId optional string, if not provided the current scene id will be used
 */
// @TODO: add options to delete the mesh, material, and textures
// @TODO: remove the physics object collider properly (not sure how to do it yet)
export const removePhysicsObject = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'removePhysicsObject');
  const scenePhysicsObjects = physicsObjects[sId];
  if (!scenePhysicsObjects) return;
  delete scenePhysicsObjects[id];

  if (sId === getCurrentSceneId()) {
    currentScenePhysicsObjects = currentScenePhysicsObjects.filter(
      (obj) => obj.mesh.userData.id !== id
    );
  }
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
 * Steps the physics world (called in main loop) and sets mesh positions and rotations in the current scene.
 */
export const stepPhysicsWorld = () => {
  // Step the world
  physicsWorld.step();

  // Set physics objects mesh positions and rotations
  for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
    const po = currentScenePhysicsObjects[i];
    po.mesh.position.copy(po.collider.translation());
    po.mesh.quaternion.copy(po.collider.rotation());
  }
};

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
};
