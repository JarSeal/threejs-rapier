// Dithered LOD cross-fades (docs/plans/p351_impostor-billboard-lod.md §2.4, Phase 2): while an entity
// changes level, both levels are drawn and dissolve into each other through a screen-space dither,
// so nothing pops and everything stays opaque (no sorting, shadows and post effects unchanged).
//
// A fade is one signed value per drawn copy: v ≥ 0 shows the pixels whose noise is ≤ v, v < 0 the
// pixels whose noise is ≥ 1 - |v|. The incoming copy at `t` and the outgoing one at `-(1 - t)`
// split the pixels between them, never both and never neither; 1 (and -1) shows every pixel.
//
// Level materials are shared (between a pool's level meshes, and with other meshes), so the fade
// can't be a fixed input of the material. Every dither-enabled material uses one mask node that
// resolves the fade of the object being drawn when its shader is built: an InstancedMesh's
// per-instance `lodFade` attribute (createLodFadeAttribute), else a per-object value
// (setLodObjectFade). three r186 builds every InstancedMesh on its own (its uuid is in the render
// object's cache key), while plain meshes share their builds, so all of them take the per-object
// path. The shadow pass reads `maskNode` too: shadows dither with the same split.
import * as THREE from 'three/webgpu';
import {
  bool,
  dot,
  float,
  Fn,
  fract,
  instancedBufferAttribute,
  screenCoordinate,
  select,
  uniform,
  vec2,
} from 'three/tsl';

type MaskableMaterial = THREE.Material & { maskNode?: THREE.Node | null };

/** The fade value that shows every pixel: what a copy that isn't fading draws with. */
export const LOD_FADE_OPAQUE = 1;

/** Interleaved gradient noise (Jimenez 2014) on the pixel position, in [0, 1). */
const interleavedGradientNoise = Fn(() => {
  const p = screenCoordinate as unknown as THREE.Node<'vec2'>;
  return fract(float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715)))));
});

/**
 * Whether a pixel of a copy drawn with the signed fade `fade` shows (a `bool` node), for a
 * material's `maskNode`. See the top of `LodFade.ts` for the encoding. Custom node materials that
 * build their own mask can combine it; `enableLodDither` does it for any material.
 * @param fade a float node: `t` for the incoming copy, `-(1 - t)` for the outgoing one
 */
export const lodDither = (fade: THREE.Node) => {
  const f = float(fade as THREE.Node<'float'>);
  const noise = interleavedGradientNoise();
  return select(f.greaterThanEqual(0), noise, noise.oneMinus()).lessThanEqual(f.abs());
};

// --- WHERE A DRAWN OBJECT'S FADE COMES FROM ---

const fadeAttributes = new WeakMap<THREE.Object3D, THREE.InstancedBufferAttribute>();
const fadeAttributeNodes = new WeakMap<THREE.InstancedBufferAttribute, THREE.Node>();
const objectFades = new WeakMap<THREE.Object3D, number>();

/** The per-object fade, written before each draw of an object (three's object uniform group). */
const objectFade = uniform(LOD_FADE_OPAQUE).onObjectUpdate(
  ({ object }) => (object && objectFades.get(object)) ?? LOD_FADE_OPAQUE
);

/**
 * Gives `mesh` a per-instance fade (`lodFade`), every instance at {@link LOD_FADE_OPAQUE}: its
 * dither-enabled materials then read each instance's own fade. Call it before the mesh is first
 * drawn (the attribute is bound when its shader is built). The attribute isn't on the geometry,
 * which is shared, and three frees its GPU buffer with the geometry's, like the instance matrix.
 * Moving an instance between slots moves its fade too; set `needsUpdate` after writing.
 * @param mesh the instanced mesh
 * @returns the attribute, `maxInstances` (the mesh's capacity) long
 */
export const createLodFadeAttribute = (mesh: THREE.InstancedMesh) => {
  const existing = fadeAttributes.get(mesh);
  if (existing) return existing;
  const capacity = mesh.instanceMatrix.count;
  const attribute = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity).fill(LOD_FADE_OPAQUE),
    1
  );
  attribute.name = 'lodFade';
  attribute.setUsage(THREE.DynamicDrawUsage);
  fadeAttributes.set(mesh, attribute);
  return attribute;
};

/** The mesh's per-instance fade attribute, undefined without one. */
export const getLodFadeAttribute = (mesh: THREE.Object3D) => fadeAttributes.get(mesh);

/**
 * Sets the fade an object without a per-instance fade is drawn with (eg. a plain LOD mesh or its
 * outgoing clone). {@link LOD_FADE_OPAQUE} (or `clearLodObjectFade`) shows it whole.
 * @param object the drawn mesh
 * @param fade the signed fade (see the top of `LodFade.ts`)
 */
export const setLodObjectFade = (object: THREE.Object3D, fade: number) => {
  objectFades.set(object, fade);
};

/** Forgets an object's fade: it's drawn whole again. */
export const clearLodObjectFade = (object: THREE.Object3D) => {
  objectFades.delete(object);
};

/** The mask every dither-enabled material shares: the drawn object's fade through lodDither. */
class LodFadeMaskNode extends THREE.Node {
  static get type() {
    return 'LodFadeMaskNode';
  }

  constructor() {
    super('bool');
  }

  setup(builder: THREE.NodeBuilder) {
    const attribute = builder.object && fadeAttributes.get(builder.object);
    if (!attribute) return lodDither(objectFade);
    let fade = fadeAttributeNodes.get(attribute);
    if (!fade) {
      fade = instancedBufferAttribute(attribute) as unknown as THREE.Node;
      fadeAttributeNodes.set(attribute, fade);
    }
    return lodDither(fade);
  }
}

const lodFadeMask = new LodFadeMaskNode() as unknown as THREE.Node<'bool'>;

// --- MATERIALS ---

const ditherMaterials = new WeakSet<THREE.Material>();

/**
 * Lets `material` take part in LOD cross-fades: every object drawn with it is dithered by its own
 * fade (a pool instance's, or the object's), and drawn whole while it isn't fading. Idempotent; an
 * existing `maskNode` is kept (both must pass). Works on classic materials too (three converts
 * them with their `maskNode`). Instanced LOD pools call it on their level materials.
 *
 * The cost while nothing fades: one discard test per pixel, plus, for plain meshes, one float
 * uniform written per draw.
 * @param material one material, or a per-group array
 * @returns whether a material changed (its shaders are rebuilt at its next draw or compile)
 */
export const enableLodDither = (material: THREE.Material | THREE.Material[]) => {
  let isChanged = false;
  for (const m of Array.isArray(material) ? material : [material]) {
    if (ditherMaterials.has(m)) continue;
    ditherMaterials.add(m);
    const maskable = m as MaskableMaterial;
    maskable.maskNode = maskable.maskNode
      ? bool(maskable.maskNode as THREE.Node<'bool'>).and(lodFadeMask)
      : lodFadeMask;
    m.needsUpdate = true;
    isChanged = true;
  }
  return isChanged;
};

/** Whether {@link enableLodDither} was called on `material`. */
export const isLodDitherEnabled = (material: THREE.Material) => ditherMaterials.has(material);
