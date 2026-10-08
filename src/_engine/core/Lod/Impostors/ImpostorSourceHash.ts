// An exported impostor's source fingerprint (docs/plans/_DONE_p351_impostor-billboard-lod.md Phase 4,
// decision 4): written into the `*.impostor.json` by the export, and compared in the debug env when
// a generator uses the export, so a source that changed since (eg. a procedural rock's seed) warns
// "stale, re-export" instead of keeping its old impostor. Synchronous (a generator is) and not
// cryptographic: it only has to notice a change.
import type * as THREE from 'three/webgpu';

// MurmurHash3 (x86, 32-bit) over 32-bit words, in two lanes with their own seeds: 64 bits
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const SEEDS = [0x3c6ef372, 0xa54ff53a];

const mixWord = (h: number, word: number) => {
  let k = Math.imul(word, C1);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, C2);
  let next = h ^ k;
  next = (next << 13) | (next >>> 19);
  return (Math.imul(next, 5) + 0xe6546b64) | 0;
};

const finalize = (h: number, length: number) => {
  let f = h ^ length;
  f ^= f >>> 16;
  f = Math.imul(f, 0x85ebca6b);
  f ^= f >>> 13;
  f = Math.imul(f, 0xc2b2ae35);
  f ^= f >>> 16;
  return (f >>> 0).toString(16).padStart(8, '0');
};

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

const createHasher = () => {
  const lanes = [...SEEDS];
  let words = 0;
  const word = (w: number) => {
    lanes[0] = mixWord(lanes[0], w);
    lanes[1] = mixWord(lanes[1], w);
    words++;
  };
  return {
    word,
    float: (value: number) => {
      _f32[0] = value;
      word(_u32[0]);
    },
    string: (str: string) => {
      word(str.length);
      for (let i = 0; i < str.length; i++) word(str.charCodeAt(i));
    },
    /** A typed array's bytes, as words where it's aligned */
    bytes: (array: ArrayLike<number> & ArrayBufferView) => {
      const { buffer, byteOffset, byteLength } = array;
      word(byteLength);
      const wordCount = byteOffset % 4 === 0 ? byteLength >>> 2 : 0;
      const asWords = new Uint32Array(buffer, byteOffset, wordCount);
      for (let i = 0; i < wordCount; i++) word(asWords[i]);
      const tail = new Uint8Array(buffer, byteOffset + wordCount * 4, byteLength - wordCount * 4);
      for (let i = 0; i < tail.length; i++) word(tail[i]);
    },
    digest: () => lanes.map((h) => finalize(h, words)).join(''),
  };
};

/**
 * An attribute's or index's array as three r186's WebGPU backend uploads it: an 8 or 16-bit
 * integer array that isn't normalized is widened to 32 bits (and an index's 0xffff to 0xffffffff),
 * and the attribute's `array` is replaced with it in place on the first upload
 * (`WebGPUAttributeUtils.createAttribute`). So a source's bytes change once it's drawn: hashed this
 * way, the same geometry fingerprints alike before and after. A 32-bit or float array is itself.
 */
const asUploaded = (
  array: ArrayLike<number> & ArrayBufferView,
  normalized: boolean,
  isIndex: boolean
): ArrayLike<number> & ArrayBufferView => {
  if (normalized) return array;
  if (array instanceof Int16Array || array instanceof Int8Array) return new Int32Array(array);
  if (!(array instanceof Uint16Array || array instanceof Uint8Array)) return array;
  const widened = new Uint32Array(array);
  if (isIndex) {
    for (let i = 0; i < widened.length; i++) if (widened[i] === 0xffff) widened[i] = 0xffffffff;
  }
  return widened;
};

/** JSON with sorted keys and colours as hex, so equal settings always stringify alike. */
const stableStringify = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if ((value as THREE.Color).isColor) return JSON.stringify((value as THREE.Color).getHex());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
};

/** A texture as the bake sees it: by its registered id (its uuid changes every session). */
const getTextureKey = (texture: THREE.Texture | null | undefined) =>
  texture ? (texture.userData.id as string | undefined) ?? (texture.name || 'unnamed') : null;

/**
 * What a bake pass reads of a material (`createBakeMaterial`, ImpostorBake.ts). Not its type:
 * the resolved shading has it, and a material id can resolve to another class per backend. A
 * `colorNode` counts only as there or not (a node graph has no stable identity across sessions).
 */
const getMaterialBakeInputs = (material: THREE.Material) => {
  const src = material as THREE.Material & {
    color?: THREE.Color;
    map?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
    flatShading?: boolean;
    colorNode?: unknown;
  };
  return {
    color: src.color ? src.color.getHex() : null,
    map: getTextureKey(src.map),
    alphaMap: getTextureKey(src.alphaMap),
    alphaTest: src.alphaTest,
    opacity: src.opacity,
    side: src.side,
    vertexColors: src.vertexColors,
    flatShading: Boolean(src.flatShading),
    colorNode: Boolean(src.colorNode),
  };
};

/**
 * The fingerprint of what an impostor was baked from: `geometry`'s attributes (every one, by name),
 * index, groups and draw range, what the bake reads of `material` (per group material too), and
 * `settings`: the kind, its options with their defaults and the resolved shading, everything the
 * export writes besides the layout (`resolveOctahedralImpostorOptions`, `resolveCrossQuadsOptions`).
 * 16 hex digits; the same inputs give the same fingerprint in every session and on every backend.
 */
export const getImpostorSourceHash = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  settings: Record<string, unknown>
) => {
  const hasher = createHasher();
  const names = Object.keys(geometry.attributes).sort();
  for (const name of names) {
    const attribute = geometry.attributes[name] as
      | THREE.BufferAttribute
      | THREE.InterleavedBufferAttribute;
    hasher.string(name);
    hasher.word(attribute.itemSize);
    hasher.word(attribute.normalized ? 1 : 0);
    if ('isInterleavedBufferAttribute' in attribute && attribute.isInterleavedBufferAttribute) {
      // Its values only, not the other attributes sharing the buffer
      hasher.word(attribute.count);
      for (let i = 0; i < attribute.count; i++) {
        for (let c = 0; c < attribute.itemSize; c++) hasher.float(attribute.getComponent(i, c));
      }
    } else {
      const array = asUploaded(
        (attribute as THREE.BufferAttribute).array,
        attribute.normalized,
        false
      );
      hasher.string(array.constructor.name);
      hasher.bytes(array);
    }
  }
  const index = geometry.getIndex();
  if (index) {
    hasher.string('index');
    hasher.bytes(asUploaded(index.array, false, true));
  }
  const materials = Array.isArray(material) ? material : [material];
  hasher.string(
    stableStringify({
      groups: geometry.groups,
      drawRange: geometry.drawRange,
      materials: materials.map(getMaterialBakeInputs),
      settings,
    })
  );
  return hasher.digest();
};
