// The octahedral impostor's material nodes (docs/plans/p351_impostor-billboard-lod.md §2.2, Phase 3):
// a quad that faces the camera from each instance's centre, blending the three atlas frames baked
// nearest to the direction it's seen from, shaded with the baked object-space normals.
//
// Each pixel follows its view ray: where it crosses a frame's image plane gives that frame's
// texel, and one parallax step along the ray to the depth baked there moves it onto the object's
// surface, so the three frames show the same point and blend without ghosting. The weights are
// the view direction's barycentric coordinates in its grid triangle, continuous across frames, so
// nothing pops as the camera moves.
//
// The billboard needs each instance's centre and rotation, but three r186 multiplies
// `positionLocal` by the instance matrix before `positionNode` runs (`NodeMaterial.setupPosition`,
// `Instance.js`) and keeps the matrix to itself. So the material binds the instance matrix a
// second time: `impostorInstanceMatrix` resolves the drawn object's when its shader is built
// (three builds every InstancedMesh on its own, LodFade.ts), and reads `positionGeometry`, the
// quad's corners before any transform. On a plain mesh it's the identity.
//
// The shadow pass reuses `positionNode`, `colorNode` and `depthNode` (`Renderer._getShadowNodes`):
// there the quad faces the light and shows the frames seen from it, so the impostor casts its own
// silhouette. Both passes write the depth of the surface point the pixel's ray meets, not the
// quad's, and the impostor receives its shadows at that point (`receivedShadowPositionNode`): the
// light-facing and the camera-facing quads are different planes through the centre, and comparing
// one against the other shadowed whatever half of the camera's quad lay behind the light's.
import * as THREE from 'three/webgpu';
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  float,
  floor,
  Fn,
  instancedDynamicBufferAttribute,
  mat3,
  mat4,
  max,
  min,
  modelWorldMatrix,
  NodeUpdateType,
  positionGeometry,
  select,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
  viewZToLogarithmicDepth,
  viewZToOrthographicDepth,
  viewZToPerspectiveDepth,
  viewZToReversedOrthographicDepth,
  viewZToReversedPerspectiveDepth,
} from 'three/tsl';
import { IMPOSTOR_DEPTH_MIN } from './ImpostorBake';
import {
  decodeOctahedralNode,
  encodeOctahedralNode,
  getOctahedralFrameBasisNode,
} from './Octahedral';
import type { ImpostorAtlasVOrigin } from './ImpostorFormat';
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

/** How far the point the impostor receives its shadows at sits out along its normal, in frame
 * texels: the surface is known to about a texel (and an 8-bit depth step), and the light's frames
 * and the camera's disagree by that much, which drew acne on lit faces. One texel removes it; more
 * removes the impostor's real self-shadowing too. */
const SHADOW_OFFSET_TEXELS = 1;

/** Parallax steps per frame: each samples the depth where the last one landed. */
const PARALLAX_STEPS = 2;
/** Where a hemi impostor's parallax fades out below the horizon, by the view direction's y: whole
 * down to about -20°, gone by about -45°. */
const HEMI_PARALLAX_FADE: [whole: number, gone: number] = [-0.35, -0.7];

/** A matrix node's column `index` (TSL's `.element()`, which three's typings leave off matrices). */
const column = <T extends 'vec3' | 'vec4'>(matrix: THREE.Node, index: number) =>
  (matrix as unknown as { element: (i: number) => THREE.Node<T> }).element(index);

type Vec2Node = THREE.Node<'vec2'>;
type Vec3Node = THREE.Node<'vec3'>;
type Vec4Node = THREE.Node<'vec4'>;
type TextureUV = Parameters<typeof texture>[1];

export type OctahedralImpostorNodes = {
  /** The quad's corner, facing the camera from the instance's centre (local space, after the
   * instance transform: what `positionLocal` would be). */
  positionNode: THREE.Node<'vec3'>;
  /** The three nearest frames' albedo and coverage alpha, blended, for the alpha cut (and the
   * shadow pass's). */
  colorNode: THREE.Node<'vec4'>;
  /** The baked object-space normals, blended, in view space. */
  normalNode: THREE.Node<'vec3'>;
  /** The depth of the surface point the pixel's ray meets (the frames' baked depths), for the main
   * and the shadow pass, instead of the quad's. */
  depthNode: THREE.Node<'float'>;
  /** That surface point in the world, out along its normal by a frame texel
   * (`SHADOW_OFFSET_TEXELS`): where the impostor receives its shadows. */
  receivedShadowPositionNode: THREE.Node<'vec3'>;
};

/**
 * The nodes that draw an octahedral impostor's atlases on its quad geometry (see
 * `generateOctahedralImpostor`): set them on a material as `positionNode`, `colorNode`,
 * `normalNode`, `depthNode` and `receivedShadowPositionNode`, with an `alphaTest`. `vOrigin` is the
 * atlases' (both the same), fixed in the shader; the layout's cells are from the image's top left
 * either way.
 */
export const createOctahedralImpostorNodes = (
  layout: OctahedralImpostorLayout,
  albedo: THREE.Texture,
  normalDepth: THREE.Texture,
  vOrigin: ImpostorAtlasVOrigin = 'TOP'
): OctahedralImpostorNodes => {
  const { frames, hemi, frameSize, gutter, atlasSize, center, radius, extent } = layout;
  const cellSize = frameSize + 2 * gutter;
  const centerLocal = vec3(...center);

  // --- VERTEX: per instance, constant over its quad ---

  // The camera in the instance's space, relative to its centre (an orthographic camera's forward
  // is the same everywhere, eg. a directional light's shadow camera)
  const instance = impostorInstanceMatrix;
  const world = modelWorldMatrix.mul(instance);
  const worldBasisInverse = mat3(world).inverse();
  const centerWorld = world.mul(vec4(centerLocal, 1)).xyz;
  const isOrthographic = column<'vec4'>(cameraProjectionMatrix, 3).w.greaterThan(0.5);
  const toCamera = worldBasisInverse.mul(
    select(
      isOrthographic,
      column<'vec4'>(cameraWorldMatrix, 2).xyz,
      cameraPosition.sub(centerWorld)
    )
  );
  const viewDir = toCamera.normalize();

  // The quad's corners are ±extent around the centre (createOctahedralImpostorQuad), put on the
  // plane facing the camera. Its roll doesn't matter (the rays pick the texels), only that it
  // covers the bounding sphere
  const quad = getOctahedralFrameBasisNode(viewDir);
  const corner = positionGeometry.xy.sub(vec2(center[0], center[1]));
  const offset = quad.right.mul(corner.x).add(quad.up.mul(corner.y));
  const positionNode = instance.mul(vec4(centerLocal.add(offset), 1)).xyz;

  // The view direction's place on the frame grid (hemi: below the horizon, on its edge)
  const grid = encodeOctahedralNode(viewDir, hemi)
    .mul(0.5)
    .add(0.5)
    .mul(frames - 1);

  // To the fragment stage: the corner's offset from the centre and the view ray through it, in the
  // instance's space and in the world (all linear over the quad, so interpolated exactly), and the
  // grid position
  const ray = select(isOrthographic, viewDir.negate(), offset.sub(toCamera));
  const pixelOffset = offset.toVarying('vImpostorOffset');
  const pixelRayLocal = ray.toVarying('vImpostorRay');
  const pixelRay = pixelRayLocal.normalize();
  const pixelCornerWorld = world
    .mul(vec4(centerLocal.add(offset), 1))
    .xyz.toVarying('vImpostorCornerWorld');
  const pixelRayWorld = mat3(world).mul(ray).toVarying('vImpostorRayWorld');
  const pixelGrid = grid.toVarying('vImpostorGrid');
  // A hemi bake has nothing below the horizon: from well under it, the horizon frames are drawn as
  // the flat cards they are (their parallax fades out, HEMI_PARALLAX_FADE), as stepping along a
  // steep ray through a side view pulls texels from far up or down its image and tears it apart
  const parallax = hemi
    ? smoothstep(HEMI_PARALLAX_FADE[1], HEMI_PARALLAX_FADE[0], viewDir.y).toVarying(
        'vImpostorParallax'
      )
    : float(1);

  // --- FRAGMENT: the three frames ---

  // The grid cell's diagonal splits it into two triangles: the base and far corners, plus the
  // corner on the view's side of the diagonal. Barycentric weights, continuous across cells
  const base = clamp(floor(pixelGrid), 0, frames - 2);
  const f = clamp(pixelGrid.sub(base), 0, 1);
  const cells: Vec2Node[] = [
    base,
    base.add(select(f.x.greaterThan(f.y), vec2(1, 0), vec2(0, 1))),
    base.add(1),
  ];
  const weights = [max(f.x, f.y).oneMinus(), abs(f.x.sub(f.y)), min(f.x, f.y)];

  /** The atlas uv of a point (relative to the centre) in frame `cell`'s image: from the cell's top
   * left, clamped to the frame (its edge is clear, and a neighbouring frame never shows through),
   * then v flipped for an atlas stored v up. */
  const toAtlasUV = (cell: Vec2Node, point: Vec3Node, right: Vec3Node, up: Vec3Node) => {
    const coord = clamp(vec2(point.dot(right), point.dot(up)).div(extent), -1, 1);
    const fromTop = cell
      .mul(cellSize)
      .add(gutter)
      .add(vec2(coord.x, coord.y.negate()).mul(0.5).add(0.5).mul(frameSize))
      .div(atlasSize);
    return (vOrigin === 'TOP'
      ? fromTop
      : vec2(fromTop.x, fromTop.y.oneMinus())) as unknown as TextureUV;
  };

  /** A depth atlas alpha as the distance from the frame's image plane toward its camera (±radius),
   * scaled down by the hemi parallax fade. */
  const decodeDepth = (depthAlpha: THREE.Node<'float'>) =>
    clamp(
      depthAlpha
        .sub(IMPOSTOR_DEPTH_MIN)
        .div(1 - IMPOSTOR_DEPTH_MIN)
        .sub(0.5)
        .mul(2 * radius),
      -radius,
      radius
    ).mul(parallax);

  /** Frame `cell`'s albedo and normal-depth where the pixel's ray meets the object's surface, and
   * how far along the ray (from the quad) that is. */
  const sampleFrame = (cell: Vec2Node) => {
    const dir = decodeOctahedralNode(
      cell
        .div(frames - 1)
        .mul(2)
        .sub(1),
      hemi
    );
    const { right, up } = getOctahedralFrameBasisNode(dir);
    // The ray runs into the frame (against `dir`); clamped short of grazing, where a hemi frame
    // seen from far below the horizon tends to (its texels then leave the frame, which is clear)
    const along = min(pixelRay.dot(dir), -1e-3);
    // Where the ray crosses the frame's image plane (through the centre), then along it to the
    // depth baked there (toward the frame's camera, ±radius), PARALLAX_STEPS times
    const toPlane = pixelOffset.dot(dir).div(along).negate();
    const onPlane = pixelOffset.add(pixelRay.mul(toPlane));
    const planeUV = toAtlasUV(cell, onPlane, right, up);
    // The plane's gradients for every sample: the parallax offset jumps at depth edges, which
    // would pick a far mip in a line along them
    const dx = (planeUV as unknown as Vec2Node).dFdx() as unknown as THREE.Node;
    const dy = (planeUV as unknown as Vec2Node).dFdy() as unknown as THREE.Node;
    let surfaceUV = planeUV;
    for (let step = 0; step < PARALLAX_STEPS; step++) {
      const depthAlpha = (texture(normalDepth, surfaceUV).grad(dx, dy) as unknown as Vec4Node).a;
      const depth = decodeDepth(depthAlpha);
      surfaceUV = toAtlasUV(cell, onPlane.add(pixelRay.mul(depth.div(along))), right, up);
    }
    const normalDepthSample = texture(normalDepth, surfaceUV).grad(dx, dy) as unknown as Vec4Node;
    return {
      albedo: texture(albedo, surfaceUV).grad(dx, dy) as unknown as Vec4Node,
      normalDepth: normalDepthSample,
      // The depth where the steps landed, back onto the ray
      distance: toPlane.add(decodeDepth(normalDepthSample.a).div(along)),
    };
  };

  const samples = cells.map(sampleFrame);
  const colorNode = samples
    .map((sample, i) => sample.albedo.mul(weights[i]))
    .reduce((sum, term) => sum.add(term));
  const normalLocal = samples
    .map((sample, i) => sample.normalDepth.xyz.mul(2).sub(1).mul(weights[i]))
    .reduce((sum, term) => sum.add(term));

  // Object space to view space for normals (the inverse transpose), by columns: varyings can't be
  // matrices
  const normalMatrix = mat3(cameraViewMatrix).mul(worldBasisInverse.transpose());
  const nx = column<'vec3'>(normalMatrix, 0).toVarying('vImpostorNormalX');
  const ny = column<'vec3'>(normalMatrix, 1).toVarying('vImpostorNormalY');
  const nz = column<'vec3'>(normalMatrix, 2).toVarying('vImpostorNormalZ');
  const normalNode = nx
    .mul(normalLocal.x)
    .add(ny.mul(normalLocal.y))
    .add(nz.mul(normalLocal.z))
    .normalize();

  // The surface point: the frames' distances along the ray, weighted by their coverage too, as a
  // frame that misses the object has its depth at the back
  const coverage = samples.map((sample, i) => sample.albedo.a.mul(weights[i]));
  const distance = samples
    .map((sample, i) => sample.distance.mul(coverage[i]))
    .reduce((sum, term) => sum.add(term))
    .div(
      max(
        coverage.reduce((sum, term) => sum.add(term)),
        1e-4
      )
    );
  // `distance` is along the unit local ray; the world ray is the same ray before normalising
  const perRayLength = float(1).div(pixelRayLocal.length());
  const surfaceWorld = pixelCornerWorld.add(pixelRayWorld.mul(distance.mul(perRayLength)));
  // A frame texel in the world, by the instance's scale along the ray
  const texelWorld = pixelRayWorld
    .length()
    .mul(perRayLength)
    .mul((2 * extent) / frameSize);
  const shadowPositionWorld = surfaceWorld.add(
    mat3(cameraWorldMatrix).mul(normalNode).normalize().mul(texelWorld.mul(SHADOW_OFFSET_TEXELS))
  );
  const surfaceViewZ = cameraViewMatrix.mul(vec4(surfaceWorld, 1)).z;
  const depthNode = Fn((builder: THREE.NodeBuilder) => {
    const { renderer } = builder;
    if (renderer.logarithmicDepthBuffer) {
      return select(
        isOrthographic,
        viewZToOrthographicDepth(surfaceViewZ, cameraNear, cameraFar),
        viewZToLogarithmicDepth(surfaceViewZ, cameraNear, cameraFar)
      );
    }
    if (renderer.reversedDepthBuffer) {
      return select(
        isOrthographic,
        viewZToReversedOrthographicDepth(surfaceViewZ, cameraNear, cameraFar),
        viewZToReversedPerspectiveDepth(surfaceViewZ, cameraNear, cameraFar)
      );
    }
    return select(
      isOrthographic,
      viewZToOrthographicDepth(surfaceViewZ, cameraNear, cameraFar),
      viewZToPerspectiveDepth(surfaceViewZ, cameraNear, cameraFar)
    );
  })();

  return {
    positionNode: positionNode as unknown as THREE.Node<'vec3'>,
    colorNode: colorNode as unknown as THREE.Node<'vec4'>,
    normalNode: normalNode as unknown as THREE.Node<'vec3'>,
    depthNode: depthNode as unknown as THREE.Node<'float'>,
    receivedShadowPositionNode: shadowPositionWorld as unknown as THREE.Node<'vec3'>,
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
