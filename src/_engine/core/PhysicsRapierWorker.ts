import {
  type PhysicsObject,
  type ColliderParams,
  type RigidBodyParams,
  type PhysicsParams,
  createRigidBody,
  createCollider,
  createPhysicsObjectWithoutMesh,
  createPhysicsObjectWithMesh,
  switchPhysicsCollider,
  switchPhysicsMesh,
  deletePhysicsObject,
  deletePhysicsObjectsBySceneId,
  deleteCurrentScenePhysicsObjects,
  deleteAllPhysicsObjects,
  doesPOExist,
  createPhysicsWorld,
  deletePhysicsWorld,
  getPhysicsObject,
  getPhysicsObjects,
  getRAPIER,
  getPhysicsWorld,
  createPhysicsDebugMesh,
  stepPhysicsWorld,
  setCurrentScenePhysicsObjects,
  getCurrentScenePhysicsObjects,
  togglePhysicsVisualizer,
  InitRapierPhysics,
  addScenePhysicsLooper,
  deleteScenePhysicsLooper,
  deleteAllScenePhysicsLoopers,
  getCurrentScenePhysParams,
} from './PhysicsRapier';

// @TODO: move this file to the worker folder (create it first)
// @TODO: refactor the current PhysicsRapier.ts to not return any actual Rapier physics entities (RigidBody, Collider, World etc.).
// Replace the current physics entities as APIs: eg. physObj = { rigidBody: setLinvel = (Vec3, wakeUp) => { // Custom function here that checks whether we are using threaded version or not and also if we are in the worker or in the main thread. } }
// Also eg. getPhysicsWorld = () => { // Same check here... }
