// Moves a BufferGeometry across a thread boundary as plain data plus transferable buffers.
// Used on both sides of the assets worker hop (worker: serialize, main thread: rebuild), so keep
// it free of imports that touch `window`/`document`.
import * as THREE from 'three/webgpu';
import type { Vector3Like } from './ImportTypes';

export type TransferableAttribute = {
  array: THREE.TypedArray;
  itemSize: number;
  normalized: boolean;
  name: string;
};

/** Everything of a BufferGeometry that GLTFLoader sets, as structured-clone-safe data. */
export type TransferableGeometry = {
  name: string;
  attributes: Record<string, TransferableAttribute>;
  morphAttributes: Record<string, TransferableAttribute[]>;
  morphTargetsRelative: boolean;
  index: TransferableAttribute | null;
  groups: { start: number; count: number; materialIndex?: number }[];
  drawRange: { start: number; count: number };
  boundingBox: { min: Vector3Like; max: Vector3Like } | null;
  boundingSphere: { center: Vector3Like; radius: number } | null;
  userData: Record<string, unknown>;
};

const toVector3Like = (v: THREE.Vector3): Vector3Like => ({ x: v.x, y: v.y, z: v.z });

/** An interleaved attribute is copied out of its shared buffer (raw values, no denormalizing). */
const deinterleave = (attr: THREE.InterleavedBufferAttribute) => {
  const { itemSize, count, offset } = attr;
  const source = attr.data.array;
  const stride = attr.data.stride;
  const ArrayType = source.constructor as new (length: number) => THREE.TypedArray;
  const array = new ArrayType(count * itemSize);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) array[i * itemSize + c] = source[i * stride + offset + c];
  }
  return array;
};

const toTransferableAttribute = (
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  transfer: Set<ArrayBuffer>
): TransferableAttribute => {
  const array = (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? deinterleave(attr as THREE.InterleavedBufferAttribute)
    : (attr as THREE.BufferAttribute).array;
  // A Set: several attributes can be views into one buffer (eg. a .glb's binary chunk), and a
  // buffer can only be listed once for transfer
  transfer.add(array.buffer as ArrayBuffer);
  return { array, itemSize: attr.itemSize, normalized: attr.normalized, name: attr.name };
};

/**
 * Describes a geometry as structured-clone-safe data, adding the buffers to transfer to
 * `transfer`. After the transfer, the geometry's buffers are detached: don't touch it again.
 * @param geometry the geometry to describe
 * @param transfer collects the ArrayBuffers to pass as the postMessage transfer list
 */
export const serializeGeometry = (
  geometry: THREE.BufferGeometry,
  transfer: Set<ArrayBuffer>
): TransferableGeometry => {
  const attributes: TransferableGeometry['attributes'] = {};
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    attributes[name] = toTransferableAttribute(attr, transfer);
  }
  const morphAttributes: TransferableGeometry['morphAttributes'] = {};
  for (const [name, list] of Object.entries(geometry.morphAttributes)) {
    morphAttributes[name] = list.map((attr) => toTransferableAttribute(attr, transfer));
  }
  const { boundingBox, boundingSphere } = geometry;
  return {
    name: geometry.name,
    attributes,
    morphAttributes,
    morphTargetsRelative: geometry.morphTargetsRelative,
    index: geometry.index ? toTransferableAttribute(geometry.index, transfer) : null,
    groups: geometry.groups.map(({ start, count, materialIndex }) => ({
      start,
      count,
      materialIndex,
    })),
    drawRange: { start: geometry.drawRange.start, count: geometry.drawRange.count },
    boundingBox: boundingBox
      ? { min: toVector3Like(boundingBox.min), max: toVector3Like(boundingBox.max) }
      : null,
    boundingSphere: boundingSphere
      ? { center: toVector3Like(boundingSphere.center), radius: boundingSphere.radius }
      : null,
    userData: geometry.userData,
  };
};

const toBufferAttribute = ({ array, itemSize, normalized, name }: TransferableAttribute) => {
  const attr = new THREE.BufferAttribute(array, itemSize, normalized);
  attr.name = name;
  return attr;
};

/**
 * Rebuilds a geometry described by {@link serializeGeometry}. Wraps the (transferred) arrays
 * as they are: nothing is copied or computed.
 * @param data {@link TransferableGeometry}
 */
export const deserializeGeometry = (data: TransferableGeometry) => {
  const geometry = new THREE.BufferGeometry();
  geometry.name = data.name;
  for (const [name, attr] of Object.entries(data.attributes)) {
    geometry.setAttribute(name, toBufferAttribute(attr));
  }
  const morphAttributes = geometry.morphAttributes as Record<string, THREE.BufferAttribute[]>;
  for (const [name, list] of Object.entries(data.morphAttributes)) {
    morphAttributes[name] = list.map(toBufferAttribute);
  }
  geometry.morphTargetsRelative = data.morphTargetsRelative;
  if (data.index) geometry.setIndex(toBufferAttribute(data.index));
  for (const { start, count, materialIndex } of data.groups) {
    geometry.addGroup(start, count, materialIndex);
  }
  geometry.setDrawRange(data.drawRange.start, data.drawRange.count);
  if (data.boundingBox) {
    const { min, max } = data.boundingBox;
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(min.x, min.y, min.z),
      new THREE.Vector3(max.x, max.y, max.z)
    );
  }
  if (data.boundingSphere) {
    const { center, radius } = data.boundingSphere;
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(center.x, center.y, center.z),
      radius
    );
  }
  geometry.userData = data.userData;
  return geometry;
};
