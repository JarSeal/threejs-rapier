// The octahedral impostor's material nodes (docs/plans/p351_impostor-billboard-lod.md §2.2, Phase 3):
// a quad that faces the camera from each instance's centre, showing the atlas frame baked nearest
// to the direction it's seen from, shaded with the baked object-space normals.
//
// The billboard needs each instance's centre and rotation, but three r186 multiplies
// `positionLocal` by the instance matrix before `positionNode` runs (`NodeMaterial.setupPosition`,
// `Instance.js`) and keeps the matrix to itself. So the material binds the instance matrix a
// second time: `impostorInstanceMatrix` resolves the drawn object's when its shader is built
// (three builds every InstancedMesh on its own, LodFade.ts), and reads `positionGeometry`, the
// quad's corners before any transform. On a plain mesh it's the identity.
//
// The shadow pass reuses `positionNode` and `colorNode` (`Renderer._getShadowNodes`): there the
// quad faces the light and shows the frame seen from it, so the impostor casts its own silhouette.
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  floor,
  instancedDynamicBufferAttribute,
  mat3,
  mat4,
  modelWorldMatrix,
  NodeUpdateType,
  positionGeometry,
  select,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  decodeOctahedralNode,
  encodeOctahedralNode,
  getOctahedralFrameBasisNode,
} from './Octahedral';
import type { OctahedralImpostorLayout } from './OctahedralImpostor';

// --- THE INSTANCE MATRIX, BOUND A SECOND TIME ---

/** A second GPU buffer over each instance matrix's array (three's own binding is private), kept at
 * its version: it re-uploads whenever the pool marks the matrices changed. */
const instanceMatrixBuffers = new WeakMap<
  THREE.InstancedBufferAttribute,
  THREE.InstancedInterleavedBuffer
>();
const instanceMatrixNodes = new WeakMap<THREE.InstancedInterleavedBuffer, THREE.Node>();
const IDENTITY = new THREE.Matrix4();

const getInstanceMatrixBuffer = (matrices: THREE.InstancedBufferAttribute) => {
  let buffer = instanceMatrixBuffers.get(matrices);
  if (!buffer) {
    buffer = new THREE.InstancedInterleavedBuffer(matrices.array as Float32Array, 16, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    buffer.version = matrices.version;
    instanceMatrixBuffers.set(matrices, buffer);
  }
  return buffer;
};

/** The drawn object's instance matrix: an InstancedMesh's per instance, else the identity. */
class ImpostorInstanceMatrixNode extends THREE.Node {
  static get type() {
    return 'ImpostorInstanceMatrixNode';
  }

  constructor() {
    super('mat4');
    // Before the object's attributes are uploaded (Renderer._renderObjectDirect)
    this.updateBeforeType = NodeUpdateType.OBJECT;
  }

  setup(builder: THREE.NodeBuilder) {
    const mesh = builder.object as THREE.InstancedMesh | null;
    if (!mesh?.isInstancedMesh) return mat4(IDENTITY);
    const buffer = getInstanceMatrixBuffer(mesh.instanceMatrix);
    let node = instanceMatrixNodes.get(buffer);
    if (!node) {
      const column = (offset: number) =>
        instancedDynamicBufferAttribute(
          buffer,
          'vec4',
          16,
          offset
        ) as unknown as THREE.Node<'vec4'>;
      node = mat4(column(0), column(4), column(8), column(12)) as unknown as THREE.Node;
      instanceMatrixNodes.set(buffer, node);
    }
    return node;
  }

  updateBefore({ object }: THREE.NodeFrame) {
    const matrices = (object as THREE.InstancedMesh | null)?.instanceMatrix;
    const buffer = matrices && instanceMatrixBuffers.get(matrices);
    if (buffer && buffer.version !== matrices.version) buffer.version = matrices.version;
    return undefined;
  }
}

const impostorInstanceMatrix = new ImpostorInstanceMatrixNode() as unknown as THREE.Node<'mat4'>;

// --- THE MATERIAL ---

/** A matrix node's column `index` (TSL's `.element()`, which three's typings leave off matrices). */
const column = <T extends 'vec3' | 'vec4'>(matrix: THREE.Node, index: number) =>
  (matrix as unknown as { element: (i: number) => THREE.Node<T> }).element(index);

export type OctahedralImpostorNodes = {
  /** The quad's corner, facing the camera from the instance's centre (local space, after the
   * instance transform: what `positionLocal` would be). */
  positionNode: THREE.Node<'vec3'>;
  /** The nearest frame's albedo and coverage alpha, for the alpha cut (and the shadow pass's). */
  colorNode: THREE.Node<'vec4'>;
  /** The baked object-space normal, in view space. */
  normalNode: THREE.Node<'vec3'>;
};

/**
 * The nodes that draw an octahedral impostor's atlases on its quad geometry (see
 * `generateOctahedralImpostor`): set them on a material as `positionNode`, `colorNode` and
 * `normalNode`, with an `alphaTest`.
 */
export const createOctahedralImpostorNodes = (
  layout: OctahedralImpostorLayout,
  albedo: THREE.Texture,
  normalDepth: THREE.Texture
): OctahedralImpostorNodes => {
  const { frames, hemi, frameSize, gutter, atlasSize, center, extent } = layout;
  const cellSize = frameSize + 2 * gutter;
  const centerLocal = vec3(...center);

  // The direction toward the camera in the instance's space: the frame's (an orthographic
  // camera's forward is the same everywhere, eg. a directional light's shadow camera)
  const instance = impostorInstanceMatrix;
  const world = modelWorldMatrix.mul(instance);
  const worldBasisInverse = mat3(world).inverse();
  const centerWorld = world.mul(vec4(centerLocal, 1)).xyz;
  const isOrthographic = column<'vec4'>(cameraProjectionMatrix, 3).w.greaterThan(0.5);
  const toCamera = select(
    isOrthographic,
    column<'vec4'>(cameraWorldMatrix, 2).xyz,
    cameraPosition.sub(centerWorld)
  );
  const viewDir = worldBasisInverse.mul(toCamera).normalize();

  // The quad's corners are ±extent around the centre (createOctahedralImpostorQuad), put on the
  // plane facing the camera with the frames' own basis, so it shows them upright
  const quad = getOctahedralFrameBasisNode(viewDir);
  const corner = positionGeometry.xy.sub(vec2(center[0], center[1]));
  const offset = quad.right.mul(corner.x).add(quad.up.mul(corner.y));
  const positionNode = instance.mul(vec4(centerLocal.add(offset), 1)).xyz;

  // The frame nearest to the view direction on the grid, and the corner's place in it: the
  // corner projected onto the frame's image plane (exact for the frame seen head-on, and linear,
  // so the vertex stage computes it)
  const grid = encodeOctahedralNode(viewDir, hemi)
    .mul(0.5)
    .add(0.5)
    .mul(frames - 1);
  const cell = clamp(floor(grid.add(0.5)), 0, frames - 1);
  const frameDir = decodeOctahedralNode(
    cell
      .div(frames - 1)
      .mul(2)
      .sub(1),
    hemi
  );
  const frame = getOctahedralFrameBasisNode(frameDir);
  const frameCoord = vec2(offset.dot(frame.right), offset.dot(frame.up)).div(extent);

  // Fragment: the atlas texel, the frame's image from its cell's top left (v = 0 is the top).
  // Clamped to the frame: its edge is clear (the bounding sphere stays inside its margin), and a
  // neighbouring frame never shows through
  const f = clamp(frameCoord.toVarying('vImpostorFrameCoord'), -1, 1);
  const cellIndex = floor(cell.toVarying('vImpostorFrameCell').add(0.5));
  const texel = cellIndex
    .mul(cellSize)
    .add(gutter)
    .add(vec2(f.x, f.y.negate()).mul(0.5).add(0.5).mul(frameSize));
  const atlasUV = texel.div(atlasSize) as unknown as Parameters<typeof texture>[1];
  const colorNode = texture(albedo, atlasUV) as unknown as THREE.Node<'vec4'>;

  // Object space to view space for normals (the inverse transpose), by columns: varyings can't be
  // matrices
  const normalMatrix = mat3(cameraViewMatrix).mul(worldBasisInverse.transpose());
  const nx = column<'vec3'>(normalMatrix, 0).toVarying('vImpostorNormalX');
  const ny = column<'vec3'>(normalMatrix, 1).toVarying('vImpostorNormalY');
  const nz = column<'vec3'>(normalMatrix, 2).toVarying('vImpostorNormalZ');
  const n = (texture(normalDepth, atlasUV) as unknown as THREE.Node<'vec4'>).xyz.mul(2).sub(1);
  const normalNode = nx.mul(n.x).add(ny.mul(n.y)).add(nz.mul(n.z)).normalize();

  return {
    positionNode: positionNode as unknown as THREE.Node<'vec3'>,
    colorNode,
    normalNode: normalNode as unknown as THREE.Node<'vec3'>,
  };
};

/**
 * The impostor's quad: four corners ±`extent` around the bounding sphere's centre in its xy plane
 * (the material turns them to face the camera), and the sphere as its bounds, so frustum culling
 * and LOD screen sizes measure the object, not the quad.
 */
export const createOctahedralImpostorQuad = (layout: OctahedralImpostorLayout) => {
  const { center, radius, extent } = layout;
  const [cx, cy, cz] = center;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    positions.push(cx + sx * extent, cy + sy * extent, cz);
    normals.push(0, 0, 1);
    uvs.push((sx + 1) / 2, (1 - sy) / 2);
  }
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  quad.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  quad.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const centerVec = new THREE.Vector3(cx, cy, cz);
  quad.boundingSphere = new THREE.Sphere(centerVec.clone(), radius);
  quad.boundingBox = new THREE.Box3(
    centerVec.clone().subScalar(radius),
    centerVec.clone().addScalar(radius)
  );
  return quad;
};
