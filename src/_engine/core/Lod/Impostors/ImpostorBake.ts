// Impostor bakes (docs/plans/p351_impostor-billboard-lod.md §2): the shared parts of rendering an
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
  Fn,
  If,
  materialColor,
  materialOpacity,
  normalView,
  select,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { getRenderer } from '../../Renderer';

/** What a bake pass writes: the source's albedo and alpha, or its normal in the bake camera's
 * view space (x right, y up, z toward the camera) encoded as `n × 0.5 + 0.5`. */
export type ImpostorBakePass = 'ALBEDO' | 'NORMAL';

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
 * per-group colours bake as they render. The normal pass keeps the source's flat shading, so a
 * faceted object bakes faceted normals.
 */
export const createBakeMaterial = (source: THREE.Material, pass: ImpostorBakePass) => {
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
    vertexColors: src.vertexColors,
  });
  material.name = `ImpostorBake.${pass}.${src.name || src.type}`;
  material.fog = false;
  const srcColorNode = src.colorNode as THREE.Node<'vec4'> | null | undefined;
  if (srcColorNode) material.colorNode = srcColorNode;
  if (pass === 'NORMAL') {
    material.flatShading = Boolean(src.flatShading);
    // The alpha (and so the alpha test) is the albedo pass's: the colour's (with its map) times
    // the opacity (with its alpha map)
    // (materialColor is a vec4 when there's a map, typed vec3)
    const albedo = vec4(srcColorNode ?? (materialColor as unknown as THREE.Node<'vec4'>));
    material.colorNode = vec4(normalView.mul(0.5).add(0.5), 1);
    material.opacityNode = albedo.a.mul(materialOpacity);
  }
  return material;
};

/** The bake materials for a mesh's material (or per-group material array). */
export const createBakeMaterials = (
  material: THREE.Material | THREE.Material[],
  pass: ImpostorBakePass
) =>
  Array.isArray(material)
    ? material.map((m) => createBakeMaterial(m, pass))
    : createBakeMaterial(material, pass);

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
 */
export const createDilateCopy = (frame: THREE.RenderTarget, gutter: number) => {
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
    const color = vec3(center.rgb).toVar();
    const isFound = bool(center.a.greaterThanEqual(DILATE_ALPHA)).toVar();
    for (const radius of DILATE_RADII) {
      for (const [dx, dy] of DILATE_DIRECTIONS) {
        const candidate = sampleAt(dx * radius, dy * radius);
        If(isFound.not().and(candidate.a.greaterThanEqual(DILATE_ALPHA)), () => {
          color.assign(candidate.rgb);
          isFound.assign(true);
        });
      }
    }
    return vec4(color, center.a);
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
