import * as THREE from 'three/webgpu';
import { createArrayWriteTarget, FLOATS_PER_SEGMENT, LineWriter } from './LineWriter';

/**
 * Segment builders. Every `write*` appends to a {@link LineWriter} (use them between
 * `beginWrite()`/`endWrite()`), every `*ToSegments` returns a new flat `xyzxyz` array for
 * `setSegments`/`LineProps.segments`.
 *
 * The box and polyline writers are allocation-free and fit a per-frame refill. The
 * geometry ones build a three.js EdgesGeometry/WireframeGeometry each call — build-once
 * use only.
 */

/** Segments in a box outline. */
export const BOX_EDGE_SEGMENT_COUNT = 12;

/** Segments in a polyline of `pointCount` points. */
export const polylineSegmentCount = (pointCount: number, closed = false) =>
  pointCount < 2 ? 0 : closed ? pointCount : pointCount - 1;

// Corner i has bit 0 = +x, bit 1 = +y, bit 2 = +z; each edge joins corners differing in one bit.
const BOX_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const scratchQuat = new THREE.Quaternion();

const writeCorners = (writer: LineWriter) => {
  for (let i = 0; i < BOX_EDGES.length; i += 2) {
    writer.vec(corners[BOX_EDGES[i]], corners[BOX_EDGES[i + 1]]);
  }
  return writer;
};

// ----------------------------------------------------------------------------
// Writers
// ----------------------------------------------------------------------------

/** Appends the 12 edges of an axis-aligned Box3. */
export const writeBox3Edges = (writer: LineWriter, box: THREE.Box3) => {
  if (box.isEmpty()) return writer;
  const { min, max } = box;
  for (let i = 0; i < 8; i++) {
    corners[i].set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
  }
  return writeCorners(writer);
};

/** Appends the 12 edges of a box of `size`, centred on `center`, optionally rotated. */
export const writeBoxEdges = (
  writer: LineWriter,
  center: THREE.Vector3Like,
  size: THREE.Vector3Like,
  quaternion?: THREE.QuaternionLike
) => {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  if (quaternion) scratchQuat.copy(quaternion);
  for (let i = 0; i < 8; i++) {
    const c = corners[i].set(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz);
    if (quaternion) c.applyQuaternion(scratchQuat);
    c.x += center.x;
    c.y += center.y;
    c.z += center.z;
  }
  return writeCorners(writer);
};

/** Appends one segment between each consecutive pair of points, plus last → first when
 * `closed`. */
export const writePolyline = (
  writer: LineWriter,
  points: ArrayLike<THREE.Vector3Like>,
  closed = false
) => {
  const n = points.length;
  if (n < 2) return writer;
  for (let i = 1; i < n; i++) writer.vec(points[i - 1], points[i]);
  if (closed) writer.vec(points[n - 1], points[0]);
  return writer;
};

/** Appends a geometry's feature edges (EdgesGeometry): only edges where adjacent faces
 * meet at more than `thresholdAngle` degrees. The one for flat-faced shapes, where
 * triangle diagonals would be noise. Allocates — build-once use only. */
export const writeGeometryEdges = (
  writer: LineWriter,
  geometry: THREE.BufferGeometry,
  thresholdAngle?: number
) => {
  const edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
  writer.raw(flattenSegmentGeometry(edges));
  edges.dispose();
  return writer;
};

/** Appends every triangle edge (WireframeGeometry). The one for curved/tessellated
 * shapes. Allocates — build-once use only. */
export const writeGeometryWireframe = (writer: LineWriter, geometry: THREE.BufferGeometry) => {
  const wireframe = new THREE.WireframeGeometry(geometry);
  writer.raw(flattenSegmentGeometry(wireframe));
  wireframe.dispose();
  return writer;
};

// ----------------------------------------------------------------------------
// One-shot forms
// ----------------------------------------------------------------------------

const toSegments = (segmentCount: number, write: (writer: LineWriter) => void) => {
  const target = createArrayWriteTarget(segmentCount);
  write(new LineWriter(target));
  return target.positions;
};

export const box3EdgesToSegments = (box: THREE.Box3) =>
  toSegments(box.isEmpty() ? 0 : BOX_EDGE_SEGMENT_COUNT, (w) => writeBox3Edges(w, box));

export const boxEdgesToSegments = (
  center: THREE.Vector3Like,
  size: THREE.Vector3Like,
  quaternion?: THREE.QuaternionLike
) => toSegments(BOX_EDGE_SEGMENT_COUNT, (w) => writeBoxEdges(w, center, size, quaternion));

export const polylineToSegments = (points: ArrayLike<THREE.Vector3Like>, closed = false) =>
  toSegments(polylineSegmentCount(points.length, closed), (w) => writePolyline(w, points, closed));

export const geometryEdgesToSegments = (
  geometry: THREE.BufferGeometry,
  thresholdAngle?: number
) => {
  const edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
  const segments = flattenSegmentGeometry(edges);
  edges.dispose();
  return segments;
};

export const geometryWireframeToSegments = (geometry: THREE.BufferGeometry) => {
  const wireframe = new THREE.WireframeGeometry(geometry);
  const segments = flattenSegmentGeometry(wireframe);
  wireframe.dispose();
  return segments;
};

/** Segment count of a flat `xyzxyz` list. */
export const segmentCountOf = (segments: ArrayLike<number>) =>
  Math.floor(segments.length / FLOATS_PER_SEGMENT);

/**
 * A segment geometry (LineSegments-style: every two vertices are one segment) as a flat
 * `xyzxyz` list. WireframeGeometry/EdgesGeometry already are one; an indexed geometry
 * (eg. a Polyline's) is expanded through its index.
 */
export const flattenSegmentGeometry = (geometry: THREE.BufferGeometry): Float32Array => {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!index) return new Float32Array(position.array);

  const out = new Float32Array(index.count * 3);
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    out[i * 3] = position.getX(v);
    out[i * 3 + 1] = position.getY(v);
    out[i * 3 + 2] = position.getZ(v);
  }
  return out;
};
