// Simplifies a geometry into a LOD chain with meshoptimizer (docs/plans/p347_lod-chain-generation.md
// §2.2): each level's index, its triangle count and error, and with compactVertices its own vertex
// arrays. Runs in the assets worker and, on MAIN_THREAD or a fallback, on the main thread, so keep it
// free of imports that touch `window`/`document`. meshoptimizer is imported on the first call: apps
// that never generate a chain never download it.
import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Flags, MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { MeshoptEncoder } from 'meshoptimizer/encoder';
import {
  deserializeGeometry,
  type TransferableAttribute,
  type TransferableGeometry,
} from '../Import/GeometryTransfer';
import type { ResolvedLodChainOptions } from './LodChainOptions';

export {
  DEFAULT_LOD_CHAIN_OPTIONS,
  resolveLodChainOptions,
  type LodChainOptions,
  type ResolvedLodChainOptions,
} from './LodChainOptions';

export type SimplifiedLevel = {
  /** Uint16 when the vertices it indexes fit. */
  index: Uint16Array | Uint32Array;
  /** Rebuilt over the new index, one per base group (empty when the base has none). */
  groups: { start: number; count: number; materialIndex?: number }[];
  triangles: number;
  /** meshoptimizer's error, relative to the chain's `extent`; includes the attribute deviation. */
  error: number;
  /** compactVertices only: the level's own vertex arrays. */
  attributes?: Record<string, TransferableAttribute>;
};

export type SimplifiedLodChain = {
  baseTriangles: number;
  /** The base's largest bounding box side: the scale the levels' `error` is relative to. */
  extent: number;
  /** Only for a base without an index, and without compactVertices: the welded vertex arrays the
   * levels index (and share). */
  welded?: Record<string, TransferableAttribute>;
  /** Simplified levels only (LOD1 onwards), possibly fewer than the ratios or none. */
  levels: SimplifiedLevel[];
};

/** A non-indexed base is welded (all attributes) with this tolerance. */
const WELD_TOLERANCE = 1e-4;
/** A level must have at least this much fewer triangles than the previous one, or it's dropped. */
const MIN_LEVEL_DROP = 0.1;
/** A group simplified below this keeps its last kept level's triangles. */
const MIN_GROUP_TRIANGLES = 4;
/** meshopt's remap value for an unreferenced vertex. */
const NO_VERTEX = 0xffffffff;

type Meshopt = { simplifier: typeof MeshoptSimplifier; encoder: typeof MeshoptEncoder };
let meshoptPromise: Promise<Meshopt> | null = null;

const loadMeshopt = () => {
  if (!meshoptPromise) {
    meshoptPromise = Promise.all([
      import('meshoptimizer/simplifier'),
      import('meshoptimizer/encoder'),
    ]).then(async ([{ MeshoptSimplifier }, { MeshoptEncoder }]) => {
      await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready]);
      return { simplifier: MeshoptSimplifier, encoder: MeshoptEncoder };
    });
    // A failed download is retried by the next call
    meshoptPromise.catch(() => (meshoptPromise = null));
  }
  return meshoptPromise;
};

/** An attribute's first `components` components as Float32 (denormalized), as meshopt needs them. */
const toFloat32 = (attr: THREE.BufferAttribute, components: number) => {
  if (attr.array instanceof Float32Array && attr.itemSize === components && !attr.normalized) {
    return attr.array;
  }
  const out = new Float32Array(attr.count * components);
  const size = Math.min(components, attr.itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < size; c++) out[i * components + c] = attr.getComponent(i, c);
  }
  return out;
};

/** The weighted attributes (normal, uv) interleaved for simplifyWithAttributes, or null. */
const buildAttributeBlock = (
  geometry: THREE.BufferGeometry,
  weights: ResolvedLodChainOptions['attributeWeights']
) => {
  const parts: { attr: THREE.BufferAttribute; size: number; weight: number }[] = [];
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (normal && weights.normal > 0) parts.push({ attr: normal, size: 3, weight: weights.normal });
  if (uv && weights.uv > 0) parts.push({ attr: uv, size: 2, weight: weights.uv });
  if (!parts.length) return null;

  const stride = parts.reduce((sum, part) => sum + part.size, 0);
  const count = geometry.getAttribute('position').count;
  const data = new Float32Array(count * stride);
  let offset = 0;
  for (const { attr, size } of parts) {
    const values = toFloat32(attr, size);
    for (let v = 0; v < count; v++) {
      for (let c = 0; c < size; c++) data[v * stride + offset + c] = values[v * size + c];
    }
    offset += size;
  }
  return { data, stride, weights: parts.flatMap(({ size, weight }) => Array(size).fill(weight)) };
};

/**
 * Vertex-cache optimizes a triangle list in place, keeping its vertex ids. The meshopt JS only
 * exposes the cache optimization inside `reorderMesh`, which also renumbers the vertices for fetch
 * order: its remap is inverted, so the triangle order stays and the ids go back.
 */
const optimizeVertexCache = (encoder: typeof MeshoptEncoder, indices: Uint32Array) => {
  if (indices.length < 6) return;
  const reordered = indices.slice();
  const [remap, unique] = encoder.reorderMesh(reordered, true, false);
  const inverse = new Uint32Array(unique);
  for (let v = 0; v < remap.length; v++) if (remap[v] !== NO_VERTEX) inverse[remap[v]] = v;
  for (let i = 0; i < indices.length; i++) indices[i] = inverse[reordered[i]];
};

const toTransferable = (
  attributes: Record<string, THREE.BufferAttribute>,
  transfer: Set<ArrayBuffer>
) => {
  const out: Record<string, TransferableAttribute> = {};
  for (const [name, attr] of Object.entries(attributes)) {
    transfer.add(attr.array.buffer as ArrayBuffer);
    out[name] = { array: attr.array, itemSize: attr.itemSize, normalized: attr.normalized, name };
  }
  return out;
};

/** A level's own vertex arrays: the vertices its index uses, renumbered in first-use order. */
const compactLevel = (
  simplifier: typeof MeshoptSimplifier,
  geometry: THREE.BufferGeometry,
  index: Uint32Array
) => {
  const [remap, unique] = simplifier.compactMesh(index);
  const attributes: Record<string, THREE.BufferAttribute> = {};
  for (const [name, source] of Object.entries(geometry.attributes)) {
    const attr = source as THREE.BufferAttribute;
    const { itemSize } = attr;
    const ArrayType = attr.array.constructor as new (length: number) => THREE.TypedArray;
    const array = new ArrayType(unique * itemSize);
    for (let v = 0; v < remap.length; v++) {
      const to = remap[v];
      if (to === NO_VERTEX) continue;
      for (let c = 0; c < itemSize; c++) array[to * itemSize + c] = attr.array[v * itemSize + c];
    }
    attributes[name] = new THREE.BufferAttribute(array, itemSize, attr.normalized);
  }
  return { attributes, vertexCount: unique };
};

/**
 * Simplifies a geometry into LOD levels (docs/plans/p347_lod-chain-generation.md §2.2). Each level
 * is simplified from the base, per group range, to its ratio of the base's triangles within
 * `maxError`. A level that drops less than 10 % from the previous one is left out, and the chain
 * stops once no group can go further. A base without an index is welded first.
 * @param data the base geometry (GeometryTransfer.ts's serializeGeometry()), without morph targets
 * @param options {@link resolveLodChainOptions}
 * @param transfer collects the result's ArrayBuffers (for the postMessage transfer list)
 */
export const simplifyLodChain = async (
  data: TransferableGeometry,
  options: ResolvedLodChainOptions,
  transfer: Set<ArrayBuffer>
): Promise<SimplifiedLodChain> => {
  const { simplifier, encoder } = await loadMeshopt();
  let geometry = deserializeGeometry(data);
  const isWelded = !geometry.index;
  if (isWelded) geometry = mergeVertices(geometry, WELD_TOLERANCE);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position || !geometry.index) throw new Error('The geometry has no position attribute.');

  const vertexCount = position.count;
  const positions = toFloat32(position, 3);
  const extent = simplifier.getScale(positions, 3);
  const attributeBlock = buildAttributeBlock(geometry, options.attributeWeights);
  const flags: Flags[] = [];
  if (options.lockBorder) flags.push('LockBorder');
  if (options.permissive) flags.push('Permissive');

  const baseIndex = Uint32Array.from(geometry.index.array);
  const hasGroups = geometry.groups.length > 0;
  const ranges = hasGroups
    ? geometry.groups.map(({ start, count, materialIndex }) => ({
        start,
        count: Math.min(count, baseIndex.length - start),
        materialIndex,
      }))
    : [{ start: 0, count: baseIndex.length, materialIndex: undefined }];
  // Per range: its base triangles, and the last kept level's (a group that collapses keeps them)
  const states = ranges.map(({ start, count }) => {
    const source = baseIndex.subarray(start, start + count - (count % 3));
    return { source, kept: source, keptError: 0, isLimited: false };
  });
  const baseTriangles = states.reduce((sum, s) => sum + s.source.length / 3, 0);

  const levels: SimplifiedLevel[] = [];
  let previousTriangles = baseTriangles;
  for (const ratio of options.ratios) {
    if (states.every((s) => s.isLimited)) break;
    const results = states.map((state) => {
      if (state.isLimited) return { indices: state.kept, error: state.keptError, isLimited: true };
      const target = Math.floor((state.source.length / 3) * ratio) * 3;
      const [indices, error] = attributeBlock
        ? simplifier.simplifyWithAttributes(
            state.source,
            positions,
            3,
            attributeBlock.data,
            attributeBlock.stride,
            attributeBlock.weights,
            null,
            target,
            options.maxError,
            flags
          )
        : simplifier.simplify(state.source, positions, 3, target, options.maxError, flags);
      if (indices.length / 3 < MIN_GROUP_TRIANGLES && indices.length < state.source.length) {
        return { indices: state.kept, error: state.keptError, isLimited: true };
      }
      // Stopped above its target: the error cap (or the topology) stopped it, and a lower target
      // gives the same result
      return { indices, error, isLimited: indices.length > target };
    });
    results.forEach((result, i) => (states[i].isLimited = result.isLimited));

    const triangles = results.reduce((sum, r) => sum + r.indices.length / 3, 0);
    if (1 - triangles / previousTriangles < MIN_LEVEL_DROP) continue;
    previousTriangles = triangles;

    const index = new Uint32Array(triangles * 3);
    const groups: SimplifiedLevel['groups'] = [];
    let offset = 0;
    results.forEach((result, i) => {
      states[i].kept = result.indices;
      states[i].keptError = result.error;
      const part = result.indices.slice();
      optimizeVertexCache(encoder, part);
      index.set(part, offset);
      if (hasGroups) {
        const { materialIndex } = ranges[i];
        groups.push({ start: offset, count: part.length, materialIndex });
      }
      offset += part.length;
    });

    let levelVertexCount = vertexCount;
    let attributes: SimplifiedLevel['attributes'];
    if (options.compactVertices) {
      const compacted = compactLevel(simplifier, geometry, index);
      attributes = toTransferable(compacted.attributes, transfer);
      levelVertexCount = compacted.vertexCount;
    }
    const levelIndex = levelVertexCount <= 65536 ? new Uint16Array(index) : index;
    transfer.add(levelIndex.buffer as ArrayBuffer);
    levels.push({
      index: levelIndex,
      groups,
      triangles,
      error: Math.max(...results.map((r) => r.error)),
      ...(attributes ? { attributes } : {}),
    });
  }

  const welded =
    isWelded && !options.compactVertices && levels.length
      ? toTransferable(geometry.attributes as Record<string, THREE.BufferAttribute>, transfer)
      : undefined;
  return { baseTriangles, extent, ...(welded ? { welded } : {}), levels };
};
