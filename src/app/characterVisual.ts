import type * as THREE from 'three/webgpu';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { loadTexture } from '../_engine/core/Texture';

/**
 * The test characters' visual: a capsule sized like the character's collider, with a beak
 * pointing along its facing (+X at yaw 0). Creates the mesh entities (`meshDynamicChar-<key>` and
 * its beak) and returns the capsule mesh, ready for createDynamicCharacter's `visual`.
 */
export const createCharacterVisual = ({
  key,
  height,
  radius,
  beakColor,
}: {
  /** Unique per character in the scene (part of the mesh app ids). */
  key: string | number;
  height: number;
  radius: number;
  beakColor: string;
}): THREE.Mesh => {
  const capsule = createGeometry({
    // Geometries are cached by id: the id carries the size
    id: `capsuleDynamicChar_${height}_${radius}`,
    type: 'CAPSULE',
    params: { radius, height: height - radius * 2 },
  });
  const material = createMaterial({
    id: 'materialDynamicChar',
    type: 'PHONG',
    params: {
      map: loadTexture({
        id: 'box1Texture',
        fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
      }),
    },
  });
  createMeshEntity(
    {
      geo: createGeometry({
        id: `directionBeakGeoDynamicChar${key}`,
        type: 'BOX',
        params: { width: 0.25, height: 0.25, depth: 0.7 },
      }),
      mat: createMaterial({
        id: `directionBeakMatDynamicChar${key}`,
        type: 'BASIC',
        params: { color: beakColor },
      }),
      position: { x: 0.35, y: 0.43, z: 0 },
    },
    { appId: `directionBeakMeshDynamicChar-${key}`, doNotAddToScene: true }
  );
  createMeshEntity(
    { geo: capsule, mat: material, receiveShadow: true, castShadow: true },
    { appId: `meshDynamicChar-${key}` }
  );
  const mesh = getMeshByAppId(`meshDynamicChar-${key}`)!;
  mesh.add(getMeshByAppId(`directionBeakMeshDynamicChar-${key}`)!);
  return mesh;
};
