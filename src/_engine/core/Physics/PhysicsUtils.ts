import {
  ColliderAPI,
  EngineAPIType,
  PhysicsEngine,
  PhysicsObject,
  PhysicsProtocolType,
  PhysicsState,
  RigidBodyAPI,
} from './PhysicsAPITypes';
import { ENGINES } from './ENGINES';

let curEngineObj: unknown = null;
let curEngineKey: string | null = null;
let curEngineAPI: EngineAPIType | null = null;

export const initPhysicsEngine = async (engineKey: PhysicsEngine) => {
  const engineFns = ENGINES[engineKey];
  curEngineObj = await engineFns.init();
  curEngineKey = engineKey;
  curEngineAPI = engineFns.engineAPI;
  return { engine: engineFns.forceTypeEngine(curEngineObj), engineAPI: engineFns.engineAPI };
};

export const getPhysicsEngineKey = () => curEngineKey;
export const getPhysicsEngine = () => curEngineObj;
export const getEngineAPI = () => curEngineAPI;

export const getColliderShapeName = (enumNumber: number) => {
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

export const isDynamicPhysicsObjectValid = (po: PhysicsObject) =>
  po.mesh &&
  po.rigidBody &&
  !po.rigidBody?.isSleeping() &&
  po.rigidBody?.isMoving() &&
  !po.rigidBody.isFixed() &&
  po.rigidBody.isEnabled();

export const setPhysicsPauseTime = (physicsState: PhysicsState) => {
  const now = performance.now();
  if (physicsState.pausedTime > 0) {
    physicsState.pauseDurationTotal += now - physicsState.pausedTime;
  }
  physicsState.pausedTime = now;
};

export const ValidProtocolTypes = new Set(
  Object.values(PhysicsProtocolType).filter((v) => typeof v === 'number')
);

export const getCollOrRigidId = (idOrAPI?: number | RigidBodyAPI | ColliderAPI) =>
  typeof idOrAPI === 'number' ? idOrAPI : idOrAPI?.id;
