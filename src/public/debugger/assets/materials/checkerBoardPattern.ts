import * as THREE from 'three/webgpu';
import {
  uniform, // Uniforms
  color, // Vectors and colors
  uv, // Standard UV coordinates
  attribute,
} from 'three/tsl';
import { existsOrThrow } from '../../../../_engine/utils/helpers';
import { createMaterial } from '../../../../_engine/core/Material';

export const getUVRepeatFactor = (mesh: THREE.Mesh, metersPerTile: number) => {
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();

  const size = new THREE.Vector3();
  existsOrThrow(
    geometry.boundingBox,
    'Geometry does not have a boundingBox (in getUVRepeatFactor).'
  ).getSize(size); // Gets the size in world units (meters)

  // Check which axes the UVs are mapped to.
  // For a typical box/plane, we usually use the two largest dimensions.
  // Assuming U maps to X and V maps to Y for simplicity here.
  const worldWidth = size.x;
  const worldHeight = size.y;

  // Calculate how many tiles fit into the world width/height
  const repeatX = worldWidth / metersPerTile;
  const repeatY = worldHeight / metersPerTile;

  return new THREE.Vector2(repeatX, repeatY);
};

// Constants
const METERS_PER_CHECKER_TILE = 0.05;

// A TSL function that takes a vec2 coordinate and returns the checkerboard color
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createCheckerboardNode = (p: any) => {
  const colorA = color(0.5, 0.5, 0.5); // Light Gray
  const colorB = color(0.1, 0.1, 0.1); // Dark Gray

  // floor(p.x) + floor(p.y)
  const blocks = p.x.floor().add(p.y.floor());

  // mod(..., 2.0)
  const checker = blocks.mod(2.0);

  // mix(colorB, colorA, checker)
  return colorB.mix(colorA, checker);
};

const applyRepeatFactorAsAttribute = (mesh: THREE.Mesh, repeatFactor: THREE.Vector2) => {
  const geometry = mesh.geometry;

  // We only need one value per object, so we'll use a single-item BufferAttribute
  // and let it broadcast to all vertices.
  const attributeArray = new Float32Array([repeatFactor.x, repeatFactor.y]);

  // Create the BufferAttribute (2 components per item, 1 item total)
  const uvRepeatBufferAttribute = new THREE.InstancedBufferAttribute(attributeArray, 2);

  // Set the attribute on the geometry, using the name specified in the TSL shader
  geometry.setAttribute('uvRepeatFactor', uvRepeatBufferAttribute);

  // TSL requires this attribute to be marked as an instance attribute if it's
  // intended to be read just once per object (even on a non-instanced mesh)
  // (uvRepeatBufferAttribute as any).gpuType = THREE.InstancedBufferAttribute;
  // uvRepeatBufferAttribute.count = 1;
  uvRepeatBufferAttribute.needsUpdate = true;
};

export const addCheckerboardMaterialToMesh = (
  id: string,
  mesh: THREE.Mesh,
  opts: {
    metersPerCheckerTile?: number;
    useConstantCheckerSize?: boolean;
    nodeMaterialType?:
      | 'BASICNODEMATERIAL'
      | 'PHONGNODEMATERIAL'
      | 'LAMBERTNODEMATERIAL'
      | 'PHYSICALNODEMATERIAL'
      | 'STANDARDNODEMATERIAL';
  } = {
    metersPerCheckerTile: METERS_PER_CHECKER_TILE,
    useConstantCheckerSize: true,
    nodeMaterialType: 'PHONGNODEMATERIAL',
  }
) => {
  const repeatFactor = getUVRepeatFactor(
    mesh,
    opts?.metersPerCheckerTile || METERS_PER_CHECKER_TILE
  );

  // TSL Uniforms
  const uvRepeat = uniform(repeatFactor);

  // --- Coordinate Definitions ---
  const uvRepeatAttribute = attribute('uvRepeatFactor', 'vec2');
  const uvCoords = uv().mul(opts.useConstantCheckerSize ? uvRepeatAttribute : uvRepeat);

  // Call the corrected function node
  const fragmentColor = createCheckerboardNode(uvCoords);

  const checkerboardMaterial = createMaterial({
    id,
    type: opts.nodeMaterialType || 'PHONGNODEMATERIAL',
    params: {
      colorNode: fragmentColor,
      side: THREE.DoubleSide,
    },
  });

  mesh.material = checkerboardMaterial;

  applyRepeatFactorAsAttribute(mesh, repeatFactor);

  return checkerboardMaterial;
};
