import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createGeometry, deleteGeometry } from '../../_engine/core/Geometry';
import { createSeededRandom } from './seededRandom';

export interface TreeGeometryOptions {
  trunkRadius?: number;
  trunkHeight?: number;
  foliageRadius?: number;
  foliageHeight?: number;
  /** Kept low for a "very low poly" look (see docs/plans/p090_large-ecs-test-world-scene.md). */
  radialSegments?: number;
}

export interface GeneratedTreeGeometry {
  geometry: THREE.BufferGeometry;
  /**
   * Material group indices set by `mergeGeometries(..., true)` — pass a 2-element material
   * array (trunk, foliage) to whatever consumes this geometry (`Mesh`/`InstancedMesh` both
   * support per-group materials the same way).
   */
  materialGroups: { trunk: number; foliage: number };
}

/**
 * Very-low-poly procedural tree: a cylinder trunk topped with a cone canopy, merged into one
 * geometry with two material groups. No GLTF — follows
 * `src/_engine/utils/world/characterTestObjects.ts`'s `mergeGeometries` use (merge, then
 * delete the intermediate registered sub-geometries so they don't linger in the geometry
 * registry after being folded into the merged result).
 */
export const generateTreeGeometry = (opts: TreeGeometryOptions = {}): GeneratedTreeGeometry => {
  const {
    trunkRadius = 0.15,
    trunkHeight = 1.5,
    foliageRadius = 0.9,
    foliageHeight = 2,
    radialSegments = 5,
  } = opts;

  const trunkGeo = createGeometry({
    type: 'CYLINDER',
    params: {
      radiusTop: trunkRadius,
      radiusBottom: trunkRadius * 1.3,
      height: trunkHeight,
      radialSegments,
    },
  });
  trunkGeo.translate(0, trunkHeight / 2, 0);

  const foliageGeo = createGeometry({
    type: 'CONE',
    params: { radius: foliageRadius, height: foliageHeight, radialSegments },
  });
  // Overlap the cone slightly into the trunk so there's no visible gap at the seam.
  foliageGeo.translate(0, trunkHeight + foliageHeight / 2 - 0.15, 0);

  const geometry = mergeGeometries([trunkGeo, foliageGeo], true)!;
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  deleteGeometry([trunkGeo.userData.id, foliageGeo.userData.id]);

  return { geometry, materialGroups: { trunk: 0, foliage: 1 } };
};

export interface BushGeometryOptions {
  /** Number of merged low-poly blobs making up the shrub. */
  clusterCount?: number;
  baseRadius?: number;
  radiusVariance?: number;
  /** Kept low for a "very low poly" look. */
  segments?: number;
  seed?: number;
}

/**
 * Very-low-poly procedural bush/shrub: a handful of small merged spheres clustered around the
 * origin, single material (no groups needed — unlike `generateTreeGeometry`, there's no
 * separate trunk).
 */
export const generateBushGeometry = (opts: BushGeometryOptions = {}): THREE.BufferGeometry => {
  const { clusterCount = 3, baseRadius = 0.5, radiusVariance = 0.2, segments = 5, seed = 1 } = opts;

  const random = createSeededRandom(seed);
  const blobGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < clusterCount; i++) {
    const radius = baseRadius + (random() - 0.5) * radiusVariance;
    const blobGeo = createGeometry({
      type: 'SPHERE',
      params: { radius, widthSegments: segments, heightSegments: segments },
    });
    blobGeo.translate(
      (random() - 0.5) * baseRadius,
      radius * 0.6 + (random() - 0.5) * 0.1,
      (random() - 0.5) * baseRadius
    );
    blobGeos.push(blobGeo);
  }

  const geometry = mergeGeometries(blobGeos, false)!;
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  deleteGeometry(blobGeos.map((geo) => geo.userData.id));

  return geometry;
};
