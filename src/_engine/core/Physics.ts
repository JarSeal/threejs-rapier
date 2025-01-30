import * as THREE from 'three/webgpu';
import Rapier from '@dimforge/rapier3d';

export type PhysicsObject = {
  mesh: THREE.Mesh;
  collider: Rapier.Collider;
  rigidBody: Rapier.RigidBody;
  // fn?: Function;
  // autoAnimate: boolean;
};

// @TODO: add these values to env, LS, and debugger controllable values
const GRAVITY = new THREE.Vector3(0, -9.81, 0);

const initRapier = async () => {
  const mod = await import('@dimforge/rapier3d');
  const RAPIER = mod.default;
  return RAPIER;
};

let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World;
const physicsObjects: PhysicsObject[] = [];

export const InitPhysics = async () => {
  return initRapier().then((rapier) => {
    RAPIER = rapier;
    physicsWorld = new RAPIER.World(GRAVITY);
    return 'shit';
  });
};
