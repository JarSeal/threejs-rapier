import * as THREE from 'three/webgpu';
import { context, normalWorldGeometry, pmremTexture, uniform, vec3 } from 'three/tsl';
import type { SkyBoxBaseDef, SkyBoxEnvDef } from '../SkyBoxTypes';
import { getPMREMTexture } from '../SkyEnvironment';
import { getTexture, loadTextureAsync } from '../../Texture';
import { isDebugEnvironment } from '../../Config';
import { isHDR } from '../../../utils/helpers';
import { lerror } from '../../../utils/Logger';

/** Base keys that change the texture or the node graph: changing one re-runs the activation.
 * Any other base key is a uniform or scene property write. */
export const BASE_STRUCTURAL_KEYS = [
  'type',
  'file',
  'fileNames',
  'path',
  'textureId',
  'texture',
  'colorSpace',
  'flipY',
] as const;

export const BASE_DEFAULTS = { rotate: 0, intensity: 1, flipY: false };
export const ENV_DEFAULTS = {
  backgroundRoughness: 0,
  backgroundIntensity: 1,
  environmentIntensity: 1,
};

export type BaseLayer = {
  /** The source texture (its PMREM is what's sampled), null for a COLOR base. */
  texture: THREE.Texture | null;
  /** The PMREM both nodes sample (the source texture itself until it's ready), null for a COLOR base. */
  environmentTexture: THREE.Texture | null;
  backgroundNode: THREE.Node;
  /** Null for a COLOR base (p112 adds an optional solid-colour bake). */
  environmentNode: THREE.Node | null;
  uniforms: {
    intensity: THREE.UniformNode<'float', number>;
    backgroundRoughness: THREE.UniformNode<'float', number>;
    /** The COLOR base's colour (unused by texture bases). */
    color: THREE.UniformNode<'color', THREE.Color>;
  };
};

/** A ColorJSON value ('#rrggbb', or { r, g, b } in 0-255) as a THREE.Color. */
const toColor = (color: string | { r: number; g: number; b: number }) =>
  typeof color === 'string'
    ? new THREE.Color(color)
    : new THREE.Color(color.r / 255, color.g / 255, color.b / 255);

/** Default sRGB, or linear sRGB for .hdr files. An empty string is unset (the legacy save data
 * has one). */
const resolveColorSpace = (colorSpace: string | undefined, fileName?: string): THREE.ColorSpace =>
  (colorSpace as THREE.ColorSpace) ||
  (isHDR(fileName) ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);

/** Sets a texture's colour space, and marks its upload and PMREM stale when that changed it. */
const setColorSpace = (texture: THREE.Texture, colorSpace: THREE.ColorSpace) => {
  if (texture.colorSpace === colorSpace) return;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  texture.needsPMREMUpdate = true;
};

const loadEquirectTexture = async (
  base: Extract<SkyBoxBaseDef, { type: 'EQUIRECTANGULAR' }>
): Promise<THREE.Texture | null> => {
  let texture: THREE.Texture | null = base.texture || null;
  if (!texture && base.file) {
    texture = await loadTextureAsync({
      id: base.textureId,
      fileName: base.file,
      path: base.path,
      useHDRLoader: isHDR(base.file),
      throwOnError: isDebugEnvironment(),
    });
  } else if (!texture && base.textureId) {
    texture = getTexture(base.textureId) || null;
  }
  if (!texture) {
    lerror(`Could not find or load the equirectangular sky box texture (${JSON.stringify(base)}).`);
    return null;
  }
  texture.mapping = THREE.EquirectangularReflectionMapping;
  setColorSpace(texture, resolveColorSpace(base.colorSpace, base.file));
  return texture;
};

const loadCubeTexture = async (
  base: Extract<SkyBoxBaseDef, { type: 'CUBE_TEXTURE' }>
): Promise<THREE.Texture> => {
  const texture =
    base.texture ||
    ((await loadTextureAsync({
      id: base.textureId,
      fileName: base.fileNames,
      path: base.path,
      throwOnError: isDebugEnvironment(),
    })) as THREE.CubeTexture);
  texture.userData.id = base.textureId || texture.userData.id || texture.uuid;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  setColorSpace(texture, resolveColorSpace(base.colorSpace, base.fileNames[0]));
  return texture;
};

/**
 * Loads (or gets, by texture id) a texture base's texture. Returns null for a COLOR base, or
 * when the texture can't be found or loaded (the error is logged).
 */
export const loadBaseTexture = (base: SkyBoxBaseDef): Promise<THREE.Texture | null> => {
  if (base.type === 'EQUIRECTANGULAR') return loadEquirectTexture(base);
  if (base.type === 'CUBE_TEXTURE') return loadCubeTexture(base);
  return Promise.resolve(null);
};

/** A cube's flipY: turns a world direction a half turn about the X axis (upside down). */
const turnUpsideDown = (dir: THREE.Node) => {
  const d = dir as THREE.Node<'vec3'>;
  return vec3(d.x, d.y.negate(), d.z.negate());
};

/**
 * An environment node whose lookup direction, given by the lighting context (the reflection
 * vector for radiance, the normal for irradiance), goes through `remap` first. EnvironmentNode
 * isolates each use of the environment, so setup() runs once per use and captures that use's
 * own getUV.
 */
class RemappedEnvironmentNode extends THREE.Node {
  constructor(
    private envNode: THREE.Node,
    private remap: (dir: THREE.Node) => THREE.Node
  ) {
    super();
  }

  getNodeType(builder: THREE.NodeBuilder) {
    return this.envNode.getNodeType(builder);
  }

  setup(builder: THREE.NodeBuilder) {
    const parentGetUV = (
      builder.context as {
        getUV?: (node: THREE.Node, builder: THREE.NodeBuilder) => THREE.Node;
      }
    ).getUV;
    if (!parentGetUV) return this.envNode;
    return context(this.envNode, {
      getUV: (node: THREE.Node, b: THREE.NodeBuilder) => this.remap(parentGetUV(node, b)),
    });
  }
}

/**
 * Builds the base layer's nodes from one PMREM: the background (blurred by
 * env.backgroundRoughness), and the environment (a bare PMREM, so the lighting context drives
 * its direction and level). Both look up the same world direction (the background's is its
 * view direction, normalWorldGeometry of the back-side background box; not normalWorld, which
 * is negated on back sides), so what materials reflect matches the background. Rotation is
 * scene.environmentRotation, which PMREMNode applies to both while the scene has an
 * environment node.
 */
export const buildBaseLayer = (
  base: SkyBoxBaseDef,
  env: SkyBoxEnvDef | undefined,
  texture: THREE.Texture | null
): BaseLayer => {
  const uniforms = {
    intensity: uniform(base.type === 'COLOR' ? 1 : base.intensity ?? BASE_DEFAULTS.intensity),
    backgroundRoughness: uniform(env?.backgroundRoughness ?? ENV_DEFAULTS.backgroundRoughness),
    color: uniform(base.type === 'COLOR' ? toColor(base.color) : new THREE.Color(0x000000)),
  };

  // A texture base whose texture failed to load shows black, like a black COLOR base
  if (base.type === 'COLOR' || !texture) {
    return {
      texture: null,
      environmentTexture: null,
      backgroundNode: uniforms.color.mul(uniforms.intensity),
      environmentNode: null,
      uniforms,
    };
  }

  const pmrem = getPMREMTexture(texture);
  const flipY = base.type === 'CUBE_TEXTURE' && Boolean(base.flipY);
  const lookupDir = flipY ? turnUpsideDown(normalWorldGeometry) : normalWorldGeometry;
  const backgroundNode = pmremTexture(pmrem, lookupDir, uniforms.backgroundRoughness).mul(
    uniforms.intensity
  );
  const environmentNode = flipY
    ? new RemappedEnvironmentNode(pmremTexture(pmrem), turnUpsideDown)
    : pmremTexture(pmrem);

  return { texture, environmentTexture: pmrem, backgroundNode, environmentNode, uniforms };
};

/** Writes the base layer's non-structural values to its uniforms. */
export const updateBaseLayerUniforms = (
  layer: Pick<BaseLayer, 'uniforms'>,
  base: SkyBoxBaseDef,
  env: SkyBoxEnvDef | undefined
) => {
  layer.uniforms.intensity.value =
    base.type === 'COLOR' ? 1 : base.intensity ?? BASE_DEFAULTS.intensity;
  layer.uniforms.backgroundRoughness.value =
    env?.backgroundRoughness ?? ENV_DEFAULTS.backgroundRoughness;
  if (base.type === 'COLOR') layer.uniforms.color.value.copy(toColor(base.color));
};
