import * as THREE from 'three/webgpu';
import type { LineBackend, LineColorNode, LineOpacityNode } from './LineBackend';
import { FLOATS_PER_SEGMENT } from './LineWriter';

/**
 * @internal
 * `THREE.LineSegments` + `LineBasicNodeMaterial`: always 1px (line width is ignored by
 * every modern graphics API), and free — WebGPURenderer already ships this material, it
 * converts every classic LineBasicMaterial through it at render time. Using the node
 * material directly skips that conversion.
 */
class ThinLineBackend implements LineBackend {
  readonly kind = 'THIN' as const;
  readonly object3D: THREE.LineSegments;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicNodeMaterial;
  private attribute: THREE.BufferAttribute;
  /** Reused every commit: addUpdateRange would allocate a new range object per call. Both
   * renderer backends only read it, then clear the list after uploading. That clear still
   * drops the array's backing store, so each commit re-grows it (~80 B, independent of the
   * segment count) — the price of uploading only the written floats instead of the whole
   * capacity. */
  private readonly uploadRange = { start: 0, count: 0 };

  constructor(positions: Float32Array) {
    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(positions, 3);
    this.geometry.setAttribute('position', this.attribute);
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.LineBasicNodeMaterial({ toneMapped: false });
    this.object3D = new THREE.LineSegments(this.geometry, this.material);
    // Lines are not pickable (neither backend is), so scene-wide raycasts skip them
    this.object3D.raycast = () => {};
  }

  setPositions(positions: Float32Array) {
    // A replaced attribute's GPU buffer is only freed by disposing the geometry that still
    // holds it, so dispose first. The geometry re-initialises on its next render.
    this.geometry.dispose();
    this.attribute = new THREE.BufferAttribute(positions, 3);
    this.geometry.setAttribute('position', this.attribute);
  }

  commit(segmentCount: number) {
    const floatCount = segmentCount * FLOATS_PER_SEGMENT;
    if (floatCount > 0) {
      this.attribute.clearUpdateRanges();
      this.uploadRange.count = floatCount;
      this.attribute.updateRanges.push(this.uploadRange);
      this.attribute.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, segmentCount * 2);
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
    this.material.needsUpdate = true;
  }

  setWidth() {}

  setDepthTest(depthTest: boolean) {
    if (this.material.depthTest === depthTest) return;
    this.material.depthTest = depthTest;
    this.material.needsUpdate = true;
  }

  dispose() {
    this.object3D.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** @internal */
export const createThinLineBackend = (positions: Float32Array): LineBackend =>
  new ThinLineBackend(positions);
