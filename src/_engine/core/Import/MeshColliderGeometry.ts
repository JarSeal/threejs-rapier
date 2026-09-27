import * as THREE from 'three/webgpu';
import { BufferGeometryUtils } from 'three/examples/jsm/Addons.js';
import { lerror } from '../../utils/Logger';
import { setMeshCreatePropsToUserData } from '../../utils/helpers';
import type { ColliderParams } from '../Physics/PhysicsAPITypes';
import { deriveColliderDimensionsFromMesh } from '../PhysicsManager';
import type { ImportedGeometryInfo } from './ImportTypes';

/** What a collider's shape is derived from: a registered geometry and its node's metadata. */
export type ColliderSource = { geometry: THREE.BufferGeometry; info: ImportedGeometryInfo };

/**
 * A throwaway mesh for the mesh-based derivations below (setMeshCreatePropsToUserData,
 * deriveColliderDimensionsFromMesh): its geometry shares every buffer attribute (no copies) with
 * the registered geometry but has its own `userData`, so their writes never reach the registered
 * asset. It carries the node's rotation + scale and custom props (eg. `spineAxis`), which those
 * helpers read from the mesh.
 */
const createScratchMesh = ({ geometry, info }: ColliderSource) => {
  const scratchGeometry = new THREE.BufferGeometry();
  scratchGeometry.setIndex(geometry.index);
  for (const name of Object.keys(geometry.attributes)) {
    scratchGeometry.setAttribute(name, geometry.getAttribute(name));
  }
  const mesh = new THREE.Mesh(scratchGeometry);
  const { quaternion, scale } = info.transform;
  mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  mesh.scale.set(scale.x, scale.y, scale.z);
  mesh.userData = { ...info.customProps.raw };
  mesh.updateMatrixWorld();
  return mesh;
};

/**
 * Shape data for TRIMESH/HEIGHTFIELD/CONVEXHULL, which the Physics API can't infer, read from the
 * node's geometry + scale (HEIGHTFIELD's row/column logic is fragile and geometry-dependent, don't
 * rewrite it lightly). Node scale is applied to every shape, TRIMESH vertices and HEIGHTFIELD
 * heights included. Returns null when the collider has to be skipped.
 */
const deriveMeshDependentColliderFields = (
  colliderParams: ColliderParams,
  source: ColliderSource,
  scratchMesh: THREE.Mesh
): ColliderParams | null => {
  const { geometry, info } = source;
  const { scale } = info.transform;

  if (colliderParams.type === 'TRIMESH') {
    if (colliderParams.vertices && colliderParams.indices) return colliderParams;
    // Attribute getters: correct for interleaved and quantized (normalized) positions too
    const position = geometry.getAttribute('position');
    const vertices = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      vertices[i * 3] = position.getX(i) * scale.x;
      vertices[i * 3 + 1] = position.getY(i) * scale.y;
      vertices[i * 3 + 2] = position.getZ(i) * scale.z;
    }
    const indices = geometry.index
      ? new Uint32Array(geometry.index.array)
      : new Uint32Array([...Array(position.count).keys()]);
    return { ...colliderParams, vertices, indices };
  }

  if (colliderParams.type === 'CONVEXHULL') {
    if (colliderParams.vertices) return colliderParams;
    const geoClone = scratchMesh.geometry.clone();
    geoClone.applyMatrix4(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
    geoClone.center();
    const vertices = new Float32Array(geoClone.attributes.position.array);
    geoClone.dispose();
    return { ...colliderParams, vertices };
  }

  if (colliderParams.type === 'HEIGHTFIELD') {
    if (info.isDracoCompressed) {
      lerror(
        `Import "${info.importId}", node "${info.nodeName}": HEIGHTFIELD collider skipped, the geometry is DRACO-compressed and DRACO's default encoding reorders the vertices the height grid is read from. Export heightfield terrains uncompressed (or with DRACO's sequential encoding).`
      );
      return null;
    }
    // Merged into a scratch copy: the registered geometry is never replaced
    const geo = BufferGeometryUtils.mergeVertices(scratchMesh.geometry);

    let nRows = colliderParams.nrows || 0;
    let nCols = colliderParams.ncols || 0;

    const bbox = new THREE.Box3().setFromObject(scratchMesh);
    const meshSize = new THREE.Vector3();
    bbox.getSize(meshSize);
    const heightfieldScale = { x: meshSize.x, y: scale.y, z: meshSize.z };

    const totalVertices = geo.attributes.position.count;

    if (!nCols && nRows > 0) {
      nCols = totalVertices / nRows;
    } else if (!nRows && nCols > 0) {
      nRows = totalVertices / nCols;
    } else if (!nRows && !nCols) {
      nRows = Math.sqrt(totalVertices) - 1;
      nCols = nRows;
      if (!Number.isInteger(nRows)) {
        lerror(
          `The HEIGHTFIELD importing failed because the squareroot of the totalVertices count (${totalVertices}) is not an integer (${nRows}). The vertices are either unindexed or the grid's number of columns does not match the number of rows. Index the vertices, use shade smooth, or provide the ncols and nrows as custom properties.`
        );
        geo.dispose();
        return colliderParams;
      }
    }
    const sizeX = nRows + 1;
    const sizeZ = nCols + 1;
    const heights = new Float32Array(sizeX * sizeZ);
    const posAttr = geo.attributes.position;
    for (let i = 0; i < sizeX; i++) {
      for (let j = 0; j < sizeZ; j++) {
        const rapierIndex = i * sizeZ + j;
        const flippedZ = sizeZ - 1 - j;
        const threeIndex = flippedZ * sizeX + i;
        heights[rapierIndex] = posAttr.getY(threeIndex);
      }
    }
    geo.dispose();
    return {
      ...colliderParams,
      nrows: Math.round(nRows),
      ncols: Math.round(nCols),
      heights,
      scale: heightfieldScale,
    };
  }

  return colliderParams;
};

/**
 * Completes a collider's shape from its node's registered geometry: TRIMESH/CONVEXHULL/
 * HEIGHTFIELD shape data, and primitive dimensions (hx/hy/hz, radius, halfHeight) from the
 * geometry's bounds × node scale, never overriding a dimension the params already set. Never
 * mutates the registered geometry.
 * @returns the completed collider params, or null when the collider has to be skipped
 */
export const deriveColliderFromGeometry = (
  colliderParams: ColliderParams,
  source: ColliderSource
): ColliderParams | null => {
  const scratchMesh = createScratchMesh(source);
  setMeshCreatePropsToUserData(colliderParams.type, scratchMesh);
  const withShapeData = deriveMeshDependentColliderFields(colliderParams, source, scratchMesh);
  return withShapeData ? deriveColliderDimensionsFromMesh(withShapeData, scratchMesh) : null;
};
