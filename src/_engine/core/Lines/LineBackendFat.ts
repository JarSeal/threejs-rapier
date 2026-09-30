import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  diffuseColor,
  float,
  Fn,
  fwidth,
  If,
  mix,
  modelViewMatrix,
  modelWorldMatrixInverse,
  positionGeometry,
  positionLocal,
  positionPrevious,
  screenDPR,
  smoothstep,
  uniform,
  varyingProperty,
  vec2,
  vec4,
  viewport,
} from 'three/tsl';
import type { LineBackend, LineColorNode, LineOpacityNode } from './LineBackend';
import { FLOATS_PER_SEGMENT } from './LineWriter';

/**
 * The FAT line backend: screen-space thick lines as instanced quads, one instance per
 * segment. Only ever loaded through a dynamic import (see LineBackend.ts), so an app that
 * never draws a line wider than 1px ships none of it.
 *
 * The material is a trimmed-down port of three's Line2NodeMaterial (screen-space width and
 * round caps only: no world-unit widths, no raycasting), with four behavioural
 * differences:
 * - Normal blending, so `opacity` works (Line2NodeMaterial hard-sets NoBlending).
 * - Smooth round caps whenever something can smooth them: alpha-to-coverage with MSAA,
 *   blending when transparent (Line2NodeMaterial only smooths them with MSAA). Opaque
 *   without MSAA they are cut out hard, as every other mesh edge in that scene is — a
 *   partial alpha there would write through to the (alpha: true) canvas instead. The
 *   quad's sides are real triangle edges, which MSAA smooths like any mesh edge.
 * - Width is a uniform (the physics wireframe thickness slider drags live) and colour is
 *   the LineObject's uniform-driven graph: changing either never rebuilds the pipeline.
 * - Dashes are opt-in per material (a dashable line compiles the dash branch, every other
 *   line the exact shader it had before), measured in screen pixels and restarting at each
 *   segment's start, so they need no cumulative distance attribute. Dash and gap are
 *   uniforms; a gap of 0 draws solid.
 */

// ----------------------------------------------------------------------------
// Shader
// ----------------------------------------------------------------------------

// Projection matrix columns 2 and 3 (`element()` on a mat4 is missing from the typings)
const projectionColumn2 = () => cameraProjectionMatrix.mul(vec4(0, 0, 1, 0));
const projectionColumn3 = () => cameraProjectionMatrix.mul(vec4(0, 0, 0, 1));

/** Fraction along start → end (view space) where the segment crosses the near plane. */
const nearPlaneCrossing = Fn(([start, end]: [THREE.Node<'vec4'>, THREE.Node<'vec4'>]) => {
  const a = projectionColumn2().z;
  const b = projectionColumn3().z;
  // a is positive with a reversed depth buffer, which needs a different near estimate
  const nearEstimate = a.greaterThan(0).select(b.negate().div(a.add(1)), b.mul(-0.5).div(a));
  return nearEstimate.sub(start.z).div(end.z.sub(start.z));
});

// A dashable line's distance along its segment, in CSS pixels from the (near-plane trimmed)
// start. It has to interpolate linearly in screen space, but WebGL2's GLSL has no
// `noperspective`, so it is passed as d·w and w (both perspective-corrected) and divided
// per fragment, which leaves d screen-linear on both backends.
const dashDistanceW = varyingProperty('float', 'vLineDashDistanceW');
const dashW = varyingProperty('float', 'vLineDashW');

/** Clip-space position of a template-quad vertex, expanded to `lineWidth` screen pixels
 * around its segment. Template x is the side (-1/+1); template y is 0 at the start, 1 at
 * the end, and beyond those in the cap regions. `dashed` adds the dash distance varyings. */
const buildSegmentQuadClipPosition = (dashed: boolean) =>
  Fn(([lineWidth]: [THREE.Node<'float'>]) => {
    const start = modelViewMatrix.mul(vec4(attribute('instanceStart', 'vec3'), 1)).toVar();
    const end = modelViewMatrix.mul(vec4(attribute('instanceEnd', 'vec3'), 1)).toVar();

    // Perspective only: a segment ending behind the camera has to be trimmed at the near
    // plane before projecting, or its NDC direction flips.
    const isPerspective = projectionColumn2().w.equal(-1);
    If(isPerspective, () => {
      If(start.z.lessThan(0).and(end.z.greaterThan(0)), () => {
        end.assign(vec4(mix(start.xyz, end.xyz, nearPlaneCrossing(start, end)), end.w));
      }).ElseIf(end.z.lessThan(0).and(start.z.greaterThanEqual(0)), () => {
        start.assign(vec4(mix(end.xyz, start.xyz, nearPlaneCrossing(end, start)), start.w));
      });
    });

    const clipStart = cameraProjectionMatrix.mul(start);
    const clipEnd = cameraProjectionMatrix.mul(end);
    const ndcStart = clipStart.xyz.div(clipStart.w);
    const ndcEnd = clipEnd.xyz.div(clipEnd.w);

    // Screen-space direction, aspect-corrected. A zero-length segment gets an arbitrary one
    // (it draws as a dot) instead of normalising to NaN.
    const aspect = viewport.z.div(viewport.w);
    const dir = ndcEnd.xy.sub(ndcStart.xy).toVar();
    dir.x.assign(dir.x.mul(aspect));
    dir.assign(dir.length().greaterThan(0).select(dir.normalize(), vec2(1, 0)));

    const offset = vec2(dir.y, dir.x.negate()).toVar();
    dir.x.assign(dir.x.div(aspect));
    offset.x.assign(offset.x.div(aspect));
    offset.assign(positionGeometry.x.lessThan(0).select(offset.negate(), offset));

    // Caps extend half a width past each end
    If(positionGeometry.y.lessThan(0), () => {
      offset.assign(offset.sub(dir));
    }).ElseIf(positionGeometry.y.greaterThan(1), () => {
      offset.assign(offset.add(dir));
    });

    // Pixels → NDC (viewport is in physical pixels, width is in CSS pixels)
    offset.assign(offset.mul(lineWidth).div(viewport.w.div(screenDPR)));

    const clip = positionGeometry.y.lessThan(0.5).select(clipStart, clipEnd).toVar();
    clip.assign(clip.add(vec4(offset.mul(clip.w), 0, 0)));

    if (dashed) {
      // Caps clamp to the ends, so they carry the pattern's first and last value
      const halfViewportCss = viewport.zw.div(screenDPR.mul(2));
      const lengthPx = ndcEnd.xy.sub(ndcStart.xy).mul(halfViewportCss).length();
      const w = clip.w;
      dashDistanceW.assign(positionGeometry.y.clamp(0, 1).mul(lengthPx).mul(w));
      dashW.assign(w);
    }

    return clip;
  });

const segmentQuadClipPosition = buildSegmentQuadClipPosition(false);
const dashedSegmentQuadClipPosition = buildSegmentQuadClipPosition(true);

// Template uv: x is -1/+1 across the width; y runs -1..1 along the body, and past ±1 into
// the caps, which are round within a unit radius of the segment ends.
const capDistanceSq = () => {
  const vUv = attribute('uv', 'vec2');
  const past = vUv.y.abs().sub(1).max(0);
  return { inCap: vUv.y.abs().greaterThan(1), len2: vUv.x.mul(vUv.x).add(past.mul(past)) };
};

/** Cap coverage for alpha-to-coverage/blending (1 along the body). Only the fully-outside
 * fragments are discarded; the one-pixel rim fades. The derivative is taken outside any
 * branch — WGSL only allows it in uniform control flow. */
const smoothRoundCapCoverage = Fn(() => {
  const { inCap, len2 } = capDistanceSq();
  const dlen = fwidth(len2).toVar();
  inCap.and(len2.greaterThan(dlen.add(1))).discard();
  return inCap.select(smoothstep(dlen.oneMinus(), dlen.add(1), len2).oneMinus(), float(1));
});

/** Hard-edged caps: everything outside them discarded, alpha left alone. */
const hardRoundCapCoverage = Fn(() => {
  const { inCap, len2 } = capDistanceSq();
  inCap.and(len2.greaterThan(1)).discard();
  return float(1);
});

/** @internal Screen-space thick-line material. Width (and a dashable material's dash and
 * gap) are uniforms; colour and opacity come from the owning LineObject's colour graph
 * (colorNode/opacityNode). */
export class LineNodeMaterial extends THREE.NodeMaterial {
  readonly isLineNodeMaterial = true;
  readonly lineWidth = uniform(1);
  /** Fixed at construction: only a dashable material compiles the dash branch. */
  readonly dashable: boolean;
  /** CSS pixels. A gap of 0 draws solid. Only read by a dashable material. */
  readonly dashPx = uniform(0);
  readonly gapPx = uniform(0);

  static get type() {
    return 'LineNodeMaterial';
  }

  constructor(dashable = false) {
    super();
    this.dashable = dashable;
    this.alphaToCoverage = true;
  }

  setupPosition(builder: THREE.NodeBuilder) {
    const clip = this.dashable
      ? dashedSegmentQuadClipPosition(this.lineWidth)
      : segmentQuadClipPosition(this.lineWidth);
    const local = modelWorldMatrixInverse
      .mul(cameraWorldMatrix)
      .mul(cameraProjectionMatrixInverse)
      .mul(clip);
    positionLocal.assign(local.xyz.div(local.w));
    // needsPreviousData (motion vectors) is missing from the NodeBuilder typings
    if ((builder as unknown as { needsPreviousData(): boolean }).needsPreviousData()) {
      positionPrevious.assign(positionLocal);
    }
    return super.setupPosition(builder);
  }

  setupDiffuseColor(builder: THREE.NodeBuilder) {
    super.setupDiffuseColor(builder);
    if (this.dashable) {
      const distance = dashDistanceW.div(dashW);
      this.gapPx
        .greaterThan(0)
        .and(distance.mod(this.dashPx.add(this.gapPx)).greaterThan(this.dashPx))
        .discard();
    }
    // Decided per pipeline, like three's own clipping: `transparent` rebuilds the material,
    // and the sample count is part of the render context.
    const smoothCaps = this.transparent || builder.renderer.currentSamples > 0;
    diffuseColor.a.mulAssign(smoothCaps ? smoothRoundCapCoverage() : hardRoundCapCoverage());
  }
}

// ----------------------------------------------------------------------------
// Geometry + object
// ----------------------------------------------------------------------------

// The instanced template: a quad per segment plus a cap quad at each end (y < 0, y > 1).
const QUAD_POSITIONS = [
  -1, 2, 0, 1, 2, 0, -1, 1, 0, 1, 1, 0, -1, 0, 0, 1, 0, 0, -1, -1, 0, 1, -1, 0,
];
const QUAD_UVS = [-1, 2, 1, 2, -1, 1, 1, 1, -1, -1, 1, -1, -1, -2, 1, -2];
const QUAD_INDEX = [0, 2, 1, 2, 3, 1, 2, 4, 3, 4, 5, 3, 4, 6, 5, 6, 7, 5];

/** @internal A thick line is a Mesh, so it is marked for anything that must tell it apart
 * from a real mesh (eg. the ECS object tagging). Not `isLine`: the renderer reads that as
 * "draw as a line strip". */
export class FatLineSegments extends THREE.Mesh<THREE.InstancedBufferGeometry, LineNodeMaterial> {
  readonly isFatLineSegments = true;

  /** Lines are not pickable (neither backend is), so scene-wide raycasts skip them. */
  raycast() {}
}

class FatLineBackend implements LineBackend {
  readonly kind = 'FAT' as const;
  readonly object3D: FatLineSegments;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: LineNodeMaterial;
  private instanceBuffer!: THREE.InstancedInterleavedBuffer;
  /** Reused every commit (see LineBackendThin). Note that the renderer tracks versions
   * per attribute, so instanceStart and instanceEnd each upload the shared buffer: the
   * first uploads this range, the second the whole buffer. Two buffers would halve the
   * upload but double the GPU memory; FAT lines are mostly build-once. */
  private readonly uploadRange = { start: 0, count: 0 };

  constructor(positions: Float32Array, dashable: boolean) {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setIndex(QUAD_INDEX);
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POSITIONS, 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UVS, 2));
    this.bindPositions(positions);
    this.geometry.instanceCount = 0;
    this.material = new LineNodeMaterial(dashable);
    this.object3D = new FatLineSegments(this.geometry, this.material);
  }

  private bindPositions(positions: Float32Array) {
    this.instanceBuffer = new THREE.InstancedInterleavedBuffer(positions, FLOATS_PER_SEGMENT, 1);
    const start = new THREE.InterleavedBufferAttribute(this.instanceBuffer, 3, 0);
    const end = new THREE.InterleavedBufferAttribute(this.instanceBuffer, 3, 3);
    this.geometry.setAttribute('instanceStart', start);
    this.geometry.setAttribute('instanceEnd', end);
  }

  setPositions(positions: Float32Array) {
    // As in LineBackendThin: only disposing the geometry frees the old GPU buffers.
    this.geometry.dispose();
    this.bindPositions(positions);
  }

  commit(segmentCount: number) {
    if (segmentCount > 0) {
      this.instanceBuffer.clearUpdateRanges();
      this.uploadRange.count = segmentCount * FLOATS_PER_SEGMENT;
      this.instanceBuffer.updateRanges.push(this.uploadRange);
      this.instanceBuffer.needsUpdate = true;
    }
    this.geometry.instanceCount = segmentCount;
  }

  setBounds(box: THREE.Box3, sphere: THREE.Sphere) {
    (this.geometry.boundingBox ??= new THREE.Box3()).copy(box);
    (this.geometry.boundingSphere ??= new THREE.Sphere()).copy(sphere);
  }

  setColorNodes(colorNode: LineColorNode, opacityNode: LineOpacityNode) {
    this.material.colorNode = colorNode;
    this.material.opacityNode = opacityNode;
    this.material.needsUpdate = true;
  }

  setTransparent(transparent: boolean) {
    if (this.material.transparent === transparent) return;
    this.material.transparent = transparent;
    // Blending already smooths the caps; alpha-to-coverage on top would thin them twice.
    this.material.alphaToCoverage = !transparent;
    this.material.needsUpdate = true;
  }

  setWidth(width: number) {
    this.material.lineWidth.value = width;
  }

  setDepthTest(depthTest: boolean) {
    if (this.material.depthTest === depthTest) return;
    this.material.depthTest = depthTest;
    this.material.needsUpdate = true;
  }

  setDash(dashPx: number, gapPx: number) {
    this.material.dashPx.value = dashPx;
    this.material.gapPx.value = gapPx;
  }

  dispose() {
    this.object3D.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** @internal `dashable` builds the dash variant of the material (LineProps.dash). */
export const createFatLineBackend = (positions: Float32Array, dashable: boolean): LineBackend =>
  new FatLineBackend(positions, dashable);
