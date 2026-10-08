// Impostor bakes (docs/plans/_DONE_p351_impostor-billboard-lod.md §2): the shared parts of rendering an
// object into atlas frames. A bake renders the object with unlit bake materials into a frame
// target, then copies the frame into its atlas cell with a dilation pass. Atlases hold albedo and
// normals, never lighting (§2.3): the impostor material shades with the scene's lights at runtime.
//
// A bake runs synchronously and restores the renderer state it touched, so it can run between
// frames (eg. in a scene's load). Every atlas is cleared before its first cell is written and
// sampled only after its bake, so the r186 destroyed-texture trap (CLAUDE.md, Sky box) can't hit it.
import * as THREE from 'three/webgpu';
import {
  bool,
  clamp,
  Fn,
  If,
  materialColor,
  materialOpacity,
  normalView,
  normalWorld,
  positionView,
  select,
  texture,
  uv,
  vec2,
  vec4,
} from 'three/tsl';
import { getRenderer } from '../../Renderer';
import type { MatProps } from '../../Material';

/**
 * What a bake pass writes:
 * - `ALBEDO`: the source's albedo and alpha.
 * - `NORMAL`: its normal in the bake camera's view space (x right, y up, z toward the camera),
 *   encoded as `n × 0.5 + 0.5`, alpha 1 (cross-quads).
 * - `NORMAL_DEPTH`: its normal in the object's (and the bake scene's world) space, encoded the same
 *   way, and in the alpha its depth toward the camera (see {@link encodeImpostorDepth}), never 0
 *   where the object is (octahedral impostors).
 */
export type ImpostorBakePass = 'ALBEDO' | 'NORMAL' | 'NORMAL_DEPTH';

/** Where a `NORMAL_DEPTH` pass measures depth: the bake camera is `distance` from the object's
 * centre, and depth runs from `-radius` (away from the camera) to `radius` (toward it). */
export type ImpostorDepthRange = { distance: number; radius: number };

/** The smallest encoded depth: 0 is left for texels the object doesn't cover. */
export const IMPOSTOR_DEPTH_MIN = 2 / 255;

/** A `NORMAL_DEPTH` alpha for a signed depth `h` (−radius..radius, toward the camera positive):
 * `IMPOSTOR_DEPTH_MIN` at `-radius` up to 1 at `radius`. */
export const encodeImpostorDepth = (h: number, radius: number) =>
  IMPOSTOR_DEPTH_MIN + (1 - IMPOSTOR_DEPTH_MIN) * Math.min(1, Math.max(0, h / (2 * radius) + 0.5));

/** The signed depth of a `NORMAL_DEPTH` alpha (the inverse of {@link encodeImpostorDepth}). */
export const decodeImpostorDepth = (alpha: number, radius: number) =>
  ((alpha - IMPOSTOR_DEPTH_MIN) / (1 - IMPOSTOR_DEPTH_MIN) - 0.5) * 2 * radius;

/** Texels with at least this alpha are the object; dilation fills the others. */
const DILATE_ALPHA = 0.5;
/** The ring radii (texels) dilation searches, nearest first, in 8 directions each. */
const DILATE_RADII = [1, 2, 3, 4, 6, 8, 12, 16];
const DILATE_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7071, 0.7071],
  [-0.7071, 0.7071],
  [0.7071, -0.7071],
  [-0.7071, -0.7071],
];

/** The renderer, or a throw: a bake needs an initialized one. */
export const getBakeRenderer = (caller: string) => {
  const renderer = getRenderer() as THREE.Renderer | undefined;
  if (!renderer?.hasInitialized()) {
    throw new Error(`${caller}: the renderer isn't initialized (bakes run after InitEngine).`);
  }
  return renderer;
};

/** An impostor's shading model. `AUTO`: the one of the source material drawing the most triangles
 * (Phong, Lambert, unlit), else standard, with that material's shininess or roughness and
 * metalness. Matching it keeps colours from jumping at the switch. */
export type ImpostorShading = 'AUTO' | 'PHONG' | 'LAMBERT' | 'STANDARD';

/** The material drawing the most triangles of `geometry`. */
export const getDominantMaterial = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[]
) => {
  if (!Array.isArray(material)) return material;
  if (geometry.groups.length === 0) return material[0];
  const counts = new Map<number, number>();
  for (const { count, materialIndex = 0 } of geometry.groups) {
    counts.set(materialIndex, (counts.get(materialIndex) ?? 0) + count);
  }
  let best = 0;
  let bestCount = -1;
  for (const [index, count] of counts) {
    if (count > bestCount && material[index]) [best, bestCount] = [index, count];
  }
  return material[best];
};

/** The impostor material's type and shading params, from `shading` and the source. */
export const getShadingProps = (
  source: THREE.Material,
  shading: ImpostorShading
): Pick<MatProps, 'type'> & { params: Record<string, unknown> } => {
  const src = source as THREE.Material & {
    isMeshPhongMaterial?: boolean;
    isMeshLambertMaterial?: boolean;
    isMeshBasicMaterial?: boolean;
    shininess?: number;
    specular?: THREE.Color;
    roughness?: number;
    metalness?: number;
  };
  const type =
    shading !== 'AUTO'
      ? shading
      : src.isMeshPhongMaterial
        ? 'PHONG'
        : src.isMeshLambertMaterial
          ? 'LAMBERT'
          : src.isMeshBasicMaterial
            ? 'BASIC'
            : 'STANDARD';
  switch (type) {
    case 'PHONG':
      return {
        type: 'PHONGNODEMATERIAL',
        params: {
          ...(src.shininess !== undefined ? { shininess: src.shininess } : {}),
          ...(src.specular ? { specular: src.specular.clone() } : {}),
        },
      };
    case 'LAMBERT':
      return { type: 'LAMBERTNODEMATERIAL', params: {} };
    case 'BASIC':
      return { type: 'BASICNODEMATERIAL', params: {} };
    case 'STANDARD':
      return {
        type: 'STANDARDNODEMATERIAL',
        params: {
          ...(src.roughness !== undefined ? { roughness: src.roughness } : {}),
          ...(src.metalness !== undefined ? { metalness: src.metalness } : {}),
        },
      };
  }
};

/** Runs `fn` with the renderer's target, clear colour and auto clear restored afterwards. */
export const withBakeRendererState = <T>(renderer: THREE.Renderer, fn: () => T): T => {
  const prevTarget = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace();
  const prevLevel = renderer.getActiveMipmapLevel();
  const prevAutoClear = renderer.autoClear;
  const prevClearColor = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  try {
    return fn();
  } finally {
    renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClearColor, prevClearAlpha);
  }
};

/**
 * An unlit material that draws `source` for a bake pass: the source's colour, map, alpha map,
 * alpha test, side and vertex colours (a node material's `colorNode` too), so cut-outs and
 * per-group colours bake as they render. The normal passes keep the source's flat shading, so a
 * faceted object bakes faceted normals, and leave its vertex colours out (three multiplies them
 * into `colorNode`, the normal).
 * @param depthRange required by `NORMAL_DEPTH`
 */
export const createBakeMaterial = (
  source: THREE.Material,
  pass: ImpostorBakePass,
  depthRange?: ImpostorDepthRange
) => {
  const src = source as THREE.Material & {
    color?: THREE.Color;
    map?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
    flatShading?: boolean;
    colorNode?: THREE.Node | null;
  };
  const material = new THREE.MeshBasicNodeMaterial({
    color: src.color ? src.color.clone() : 0xffffff,
    map: src.map ?? null,
    alphaMap: src.alphaMap ?? null,
    alphaTest: src.alphaTest,
    opacity: src.opacity,
    side: src.side,
    vertexColors: pass === 'ALBEDO' && src.vertexColors,
  });
  material.name = `ImpostorBake.${pass}.${src.name || src.type}`;
  material.fog = false;
  const srcColorNode = src.colorNode as THREE.Node<'vec4'> | null | undefined;
  if (srcColorNode) material.colorNode = srcColorNode;
  if (pass === 'ALBEDO') return material;

  material.flatShading = Boolean(src.flatShading);
  // The alpha is the albedo pass's: the colour's (with its map) times the opacity (with its alpha
  // map) (materialColor is a vec4 when there's a map, typed vec3)
  const albedoAlpha = vec4(srcColorNode ?? (materialColor as unknown as THREE.Node<'vec4'>)).a.mul(
    materialOpacity
  );
  if (pass === 'NORMAL') {
    material.colorNode = vec4(normalView.mul(0.5).add(0.5), 1);
    material.opacityNode = albedoAlpha;
    return material;
  }

  if (!depthRange) throw new Error('createBakeMaterial: a NORMAL_DEPTH pass needs a depthRange.');
  // The alpha carries the depth, so the alpha test is a mask (any alpha above 0 for a source
  // without one: a superset of what the albedo's alpha cut keeps), and nothing blends it away (an
  // opaque material's alpha is forced to 1, NodeBuilder.isOpaque)
  const { distance, radius } = depthRange;
  material.alphaTest = 0;
  material.opacity = 1;
  material.blending = THREE.NoBlending;
  material.maskNode = albedoAlpha.greaterThanEqual(Math.max(src.alphaTest, 1e-3));
  // The bake camera looks at the centre from `distance`: view z is -(distance - h)
  const h = positionView.z.add(distance);
  const depth = clamp(h.div(2 * radius).add(0.5), 0, 1)
    .mul(1 - IMPOSTOR_DEPTH_MIN)
    .add(IMPOSTOR_DEPTH_MIN);
  // The bake scene's world space is the object's (the mesh has no transform)
  material.colorNode = vec4(normalWorld.mul(0.5).add(0.5), depth);
  return material;
};

/** The bake materials for a mesh's material (or per-group material array). */
export const createBakeMaterials = (
  material: THREE.Material | THREE.Material[],
  pass: ImpostorBakePass,
  depthRange?: ImpostorDepthRange
) =>
  Array.isArray(material)
    ? material.map((m) => createBakeMaterial(m, pass, depthRange))
    : createBakeMaterial(material, pass, depthRange);

export const disposeBakeMaterials = (material: THREE.Material | THREE.Material[]) => {
  for (const m of Array.isArray(material) ? material : [material]) m.dispose();
};

/** The target one frame is rendered into before it's copied to its atlas cell: HalfFloat, so the
 * normals keep their precision until the copy, with a depth buffer for the object's own
 * occlusion. */
export const createFrameTarget = (width: number, height: number) => {
  const target = new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
  });
  target.texture.name = 'ImpostorBake.frame';
  return target;
};

/**
 * An atlas target for `pass`: RGBA8 with mipmaps, sRGB for albedo (hardware-encoded on write) and
 * linear for normals. Disposing its texture (eg. the scene asset release deleting the registered
 * texture) disposes the whole target.
 */
export const createAtlasTarget = (
  width: number,
  height: number,
  pass: ImpostorBakePass,
  name: string
) => {
  const target = new THREE.RenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: pass === 'ALBEDO' ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: true,
    depthBuffer: false,
  });
  target.texture.name = name;
  // three r186 destroys a render target's textures with the target (Textures._destroyRenderTarget),
  // never through texture.dispose(), so this can't recurse
  const onDispose = () => {
    target.texture.removeEventListener('dispose', onDispose);
    target.dispose();
  };
  target.texture.addEventListener('dispose', onDispose);
  return target;
};

/** Clears a target to transparent black (also sets up its GPU texture before anything samples it). */
export const clearBakeTarget = (renderer: THREE.Renderer, target: THREE.RenderTarget) => {
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
};

/**
 * The copy of a frame target into an atlas cell: the frame sits `gutter` texels in from the
 * cell's edges, and every texel the object doesn't cover (the gutter included) takes the colour of
 * the nearest one it does (within the largest search radius), with its own alpha kept. Without it,
 * filtering and mipmaps blend the clear colour into the object's edges (dark fringes at the alpha
 * cut, darker far mips).
 * @param opts.coverage the alpha a texel the object covers has at least (default 0.5)
 * @param opts.dilateAlpha a filled texel takes the alpha of the one it copies too (a `NORMAL_DEPTH`
 * frame's depth), not its own. Default false.
 */
export const createDilateCopy = (
  frame: THREE.RenderTarget,
  gutter: number,
  opts: { coverage?: number; dilateAlpha?: boolean } = {}
) => {
  const { coverage = DILATE_ALPHA, dilateAlpha = false } = opts;
  const { width, height } = frame;
  const material = new THREE.NodeMaterial();
  material.name = 'ImpostorBake.dilate';
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const frameUV = uv()
      .mul(vec2(width + 2 * gutter, height + 2 * gutter))
      .sub(gutter)
      .div(vec2(width, height));
    // Explicit level 0: a sample in non-uniform control flow can't use derivatives
    const sampleAt = (dx: number, dy: number) => {
      const p = frameUV.add(vec2(dx / width, dy / height));
      const isInside = p.x
        .greaterThanEqual(0)
        .and(p.x.lessThanEqual(1))
        .and(p.y.greaterThanEqual(0))
        .and(p.y.lessThanEqual(1));
      return select(isInside, texture(frame.texture, p).level(0), vec4(0));
    };
    const center = sampleAt(0, 0).toVar();
    const color = vec4(center).toVar();
    const isFound = bool(center.a.greaterThanEqual(coverage)).toVar();
    for (const radius of DILATE_RADII) {
      for (const [dx, dy] of DILATE_DIRECTIONS) {
        const candidate = sampleAt(dx * radius, dy * radius);
        If(isFound.not().and(candidate.a.greaterThanEqual(coverage)), () => {
          color.assign(candidate);
          isFound.assign(true);
        });
      }
    }
    return dilateAlpha ? color : vec4(color.rgb, center.a);
  })();
  const quad = new THREE.QuadMesh(material);
  return {
    /** Writes the frame into `atlas`'s cell at (`x`, `y`), `cellWidth` × `cellHeight` texels. */
    copy: (
      renderer: THREE.Renderer,
      atlas: THREE.RenderTarget,
      x: number,
      y: number,
      cellWidth: number,
      cellHeight: number
    ) => {
      renderer.setRenderTarget(atlas);
      renderer.autoClear = false;
      atlas.viewport.set(x, y, cellWidth, cellHeight);
      quad.render(renderer);
      atlas.viewport.set(0, 0, atlas.width, atlas.height);
    },
    dispose: () => material.dispose(),
  };
};
