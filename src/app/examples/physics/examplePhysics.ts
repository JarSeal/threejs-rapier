import * as THREE from 'three/webgpu';
import { getECSWorld } from '../../../_engine/core/ECS';
import type { GeoProps } from '../../../_engine/core/Geometry';
import { createKeyBinding } from '../../../_engine/core/Input/KeyboardInput';
import type { MatProps } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import type { ColliderParams } from '../../../_engine/core/Physics/PhysicsAPITypes';
import { createPhysicsEntity } from '../../../_engine/core/PhysicsManager';
import { registerOnSceneExit } from '../../../_engine/core/Scene';
import { getHUDRootCMP } from '../../../_engine/core/HUD';

const SCENE_ID = 'examplePhysics';
/** The oldest dropped shape is deleted past this many */
const MAX_SHAPES = 80;

// #region physics-shapes (shown in the Hub: hub/pages/examples/physics/)
type Shape = { geo: GeoProps; mat: MatProps; collider: ColliderParams };

// A mesh and a collider of the same size. The ids register each geometry and material once:
// every shape of a kind shares them.
const SHAPES: Shape[] = [
  {
    geo: { id: 'physicsBox', type: 'BOX', params: { width: 1, height: 1, depth: 1 } },
    mat: { id: 'physicsBox', type: 'STANDARD', params: { color: '#e8833a' } },
    collider: { type: 'BOX', hx: 0.5, hy: 0.5, hz: 0.5 },
  },
  {
    geo: { id: 'physicsBall', type: 'SPHERE', params: { radius: 0.5 } },
    mat: { id: 'physicsBall', type: 'STANDARD', params: { color: '#4fa3d9' } },
    collider: { type: 'BALL', radius: 0.5, restitution: 0.5 },
  },
  {
    // three's capsule height is the straight part's, Rapier's halfHeight is half of it
    geo: { id: 'physicsCapsule', type: 'CAPSULE', params: { radius: 0.35, height: 0.7 } },
    mat: { id: 'physicsCapsule', type: 'STANDARD', params: { color: '#7cc46b' } },
    collider: { type: 'CAPSULE', radius: 0.35, halfHeight: 0.35 },
  },
  {
    geo: {
      id: 'physicsCylinder',
      type: 'CYLINDER',
      params: { radiusTop: 0.45, radiusBottom: 0.45, height: 1, radialSegments: 24 },
    },
    mat: { id: 'physicsCylinder', type: 'STANDARD', params: { color: '#c26bc4' } },
    collider: { type: 'CYLINDER', radius: 0.45, halfHeight: 0.5 },
  },
];
// #endregion physics-shapes

// #region physics-drop (shown in the Hub: hub/pages/examples/physics/)
const tmpEuler = new THREE.Euler();

/** A mesh entity, then a dynamic Rapier body attached to it: physics moves the mesh */
const dropShape = async (shape: Shape, position: { x: number; y: number; z: number }) => {
  const entityId = createMeshEntity({
    geo: shape.geo,
    mat: shape.mat,
    position,
    castShadow: true,
    receiveShadow: true,
  });
  const tilt = new THREE.Quaternion().setFromEuler(tmpEuler.set(position.z, 0, position.x));
  await createPhysicsEntity(
    shape.collider,
    { rigidType: 'DYNAMIC', translation: position, rotation: tilt },
    entityId
  );
  return entityId;
};
// #endregion physics-drop

/** A key hint over the canvas, removed with the scene */
const showDropHint = () => {
  const hint = getHUDRootCMP().add({
    text: 'Space: drop a shape',
    style: {
      // #hudRoot is a 0 × 0 box: place the hint against the viewport
      position: 'fixed',
      bottom: '72px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '6px 12px',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.5)',
      color: '#fff',
      font: '14px sans-serif',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    },
  });
  registerOnSceneExit(SCENE_ID, () => hint.remove());
};

// #region physics-scene (shown in the Hub: hub/pages/examples/physics/)
export const scene = async () => {
  // The ground: a mesh with a FIXED body, which nothing moves
  const groundId = createMeshEntity({
    geo: { id: 'physicsGround', type: 'BOX', params: { width: 20, height: 0.5, depth: 20 } },
    mat: { id: 'physicsGround', type: 'STANDARD', params: { color: '#59606e' } },
    position: { y: -0.25 },
    receiveShadow: true,
  });
  await createPhysicsEntity(
    { type: 'BOX', hx: 10, hy: 0.25, hz: 10 },
    { rigidType: 'FIXED', translation: { x: 0, y: -0.25, z: 0 } },
    groundId
  );

  // One of each, in a row: the same drop on every visit (scene loads are deterministic)
  const dropped = await Promise.all(
    SHAPES.map((shape, i) => dropShape(shape, { x: (i - 1.5) * 2, y: 3 + i, z: 0.3 * i }))
  );

  // Space drops a random shape (a scene binding: it does nothing in other scenes)
  const dropRandomShape = async () => {
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    const position = { x: Math.random() * 8 - 4, y: 8, z: Math.random() * 8 - 4 };
    dropped.push(await dropShape(shape, position));
    // Deleting the entity removes its body too
    if (dropped.length > MAX_SHAPES) getECSWorld().deleteEntity(dropped.shift()!);
  };
  createKeyBinding({
    id: 'examplePhysicsDrop',
    name: 'Drop a shape',
    chord: { key: ' ' },
    type: 'KEY_DOWN',
    sceneId: SCENE_ID,
    fn: () => void dropRandomShape(),
  });
  showDropHint();
};
// #endregion physics-scene
