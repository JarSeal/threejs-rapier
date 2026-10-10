import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lerror } from '../../utils/Logger';
import { setMeshCreatePropsToUserData } from '../../utils/helpers';
import type { ColliderParams } from '../Physics/PhysicsAPITypes';
import { deriveColliderDimensionsFromMesh } from '../PhysicsManager';
import type { ImportedGeometryInfo, Vector3Like } from './ImportTypes';

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
 * The geometry's positions × node scale as floats. Reads through the attribute getters, so
 * interleaved and quantized (normalized integer) positions come out right too.
 */
const readScaledPositions = (geometry: THREE.BufferGeometry, scale: Vector3Like) => {
  const position = geometry.getAttribute('position');
  const vertices = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    vertices[i * 3] = position.getX(i) * scale.x;
    vertices[i * 3 + 1] = position.getY(i) * scale.y;
    vertices[i * 3 + 2] = position.getZ(i) * scale.z;
  }
  return vertices;
};

/**
 * Whether the position attribute is stored as integers (gltf-transform's `quantize()`, meshopt's
 * quantization, KHR_mesh_quantization). Checked by the array type, not by interleaving: the assets
 * worker hands quantized positions over de-interleaved.
 */
const isQuantizedPosition = (geometry: THREE.BufferGeometry) =>
  !(geometry.getAttribute('position').array instanceof Float32Array);

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
    const vertices = readScaledPositions(geometry, scale);
    const indices = geometry.index
      ? new Uint32Array(geometry.index.array)
      : new Uint32Array([...Array(vertices.length / 3).keys()]);
    return { ...colliderParams, vertices, indices };
  }

  if (colliderParams.type === 'CONVEXHULL') {
    if (colliderParams.vertices) return colliderParams;
    // In the node's space, like TRIMESH: the body sits at the node's origin
    return { ...colliderParams, vertices: readScaledPositions(geometry, scale) };
  }

  if (colliderParams.type === 'HEIGHTFIELD') {
    if (info.isDracoCompressed) {
      lerror(
        `Import "${info.importId}", node "${info.nodeName}": HEIGHTFIELD collider skipped, the geometry is DRACO-compressed and DRACO's default encoding reorders the vertices the height grid is read from. Export heightfield terrains uncompressed (or with DRACO's sequential encoding).`
      );
      return null;
    }
    // meshopt's quantization comes with a reorder, which can't be detected: refused on every
    // worker target alike
    if (isQuantizedPosition(geometry)) {
      lerror(
        `Import "${info.importId}", node "${info.nodeName}": HEIGHTFIELD collider skipped, the geometry's positions are quantized (${geometry.getAttribute('position').array.constructor.name}), and meshopt's quantization also reorders the vertices the height grid is read from. Set "optimize": { "mesh": { "quantize": false } } in the asset's importedAsset JSON (the asset pipeline's default for nodes with a colliderType), or export the terrain unquantized.`
      );
      return null;
    }
    // Merged into a scratch copy: the registered geometry is never replaced. mergeVertices
    // throws on interleaved attributes, so the scratch gets de-interleaved copies of them
    BufferGeometryUtils.deinterleaveGeometry(scratchMesh.geometry);
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
