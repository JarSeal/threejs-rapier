import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';

/**
 * Main-thread physics API MVP verification scene
 * (docs/plans/p020_main-thread-physics-api-mvp.md §3.7): a static ground box,
 * a falling ball, and a falling box.
 */
export const scene = async () => {
  const groundGeo = createGeometry({
    id: 'physicsTestGround',
    type: 'BOX',
    params: { width: 10, height: 0.5, depth: 10 },
  });
  const groundMat = createMaterial({
    id: 'physicsTestGround',
    type: 'BASIC',
    params: { color: 0x666666 },
  });
  const groundEntityId = createMeshEntity(
    { geo: groundGeo, mat: groundMat, position: { x: 0, y: 0, z: 0 } },
    { appId: 'physicsTestGroundMesh' }
  );
  await createPhysicsEntity(
    { type: 'BOX', hx: 5, hy: 0.25, hz: 5 },
    { rigidType: 'FIXED', translation: { x: 0, y: 0, z: 0 } },
    groundEntityId
  );

  const ballGeo = createGeometry({
    id: 'physicsTestBall',
    type: 'SPHERE',
    params: { radius: 0.5 },
  });
  const ballMat = createMaterial({
    id: 'physicsTestBall',
    type: 'BASIC',
    params: { color: 0xff4444 },
  });
  const ballEntityId = createMeshEntity(
    { geo: ballGeo, mat: ballMat, position: { x: -1, y: 5, z: 0 } },
    { appId: 'physicsTestBallMesh' }
  );
  await createPhysicsEntity(
    { type: 'BALL', radius: 0.5 },
    { rigidType: 'DYNAMIC', translation: { x: -1, y: 5, z: 0 }, angvel: { x: 0, y: 0, z: -3 } },
    ballEntityId
  );

  const boxGeo = createGeometry({
    id: 'physicsTestBox',
    type: 'BOX',
    params: { width: 1, height: 1, depth: 1 },
  });
  const boxMat = createMaterial({
    id: 'physicsTestBox',
    type: 'BASIC',
    params: { color: 0x4488ff },
  });
  const boxEntityId = createMeshEntity(
    { geo: boxGeo, mat: boxMat, position: { x: 1, y: 7, z: 0 } },
    { appId: 'physicsTestBoxMesh' }
  );
  await createPhysicsEntity(
    { type: 'BOX', hx: 0.5, hy: 0.5, hz: 0.5 },
    { rigidType: 'DYNAMIC', translation: { x: 1, y: 7, z: 0 }, angvel: { x: 1, y: 7, z: 0 } },
    boxEntityId
  );
};
