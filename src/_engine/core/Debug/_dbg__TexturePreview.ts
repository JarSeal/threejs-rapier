import * as THREE from 'three/webgpu';
import { int, texture, uniform, uv, vec2 } from 'three/tsl';
import {
  clearBakeTarget,
  getBakeRenderer,
  withBakeRendererState,
} from '../Lod/Impostors/ImpostorBake';
import { getTextureDepth, getTextureSize } from './_dbg__AssetStats';

/**
 * The debugger's GPU texture previews (p299 D6). A KTX2 texture can't be drawn into a 2D canvas
 * (its data is in a GPU format), so a preview samples the texture on the GPU at one mip level, one
 * tile per layer side by side in a render target, and reads the target back
 * (`readRenderTargetPixelsAsync`) into an `ImageData` per tile. Any texture kind works: compressed
 * or not, 2D or array.
 *
 * The target has the texture's colour space (sRGB is encoded on write, data is written as it is),
 * so the bytes are the texture's own, ready for a canvas. Rendering to a target has no tone mapping.
 */

export type TexturePreviewOpts = {
  /** The mip level to sample. Default 0. */
  level?: number;
  /** An array texture's layers to render, one tile each. Default every layer. A 2D texture has
   * one tile, whatever this says. */
  layers?: number[];
  /** A tile's largest side in px. A bigger level is sampled down to it (bilinear at that level, so
   * fine detail aliases). Default 256. */
  maxSize?: number;
};

export type TexturePreviewTile = {
  /** The layer (0 for a 2D texture) */
  layer: number;
  /** The tile's pixels, top row first */
  image: ImageData;
};

export type TexturePreview = {
  level: number;
  /** The level's own size */
  levelWidth: number;
  levelHeight: number;
  /** The tiles' size: the level's, or less when it's over `maxSize` */
  width: number;
  height: number;
  tiles: TexturePreviewTile[];
};

type TextureUV = Parameters<typeof texture>[1];

const MIPMAP_FILTERS: number[] = [
  THREE.NearestMipmapNearestFilter,
  THREE.NearestMipmapLinearFilter,
  THREE.LinearMipmapNearestFilter,
  THREE.LinearMipmapLinearFilter,
];

/** A strip's width limit: WebGL2 only promises 2048 px, but every GPU this runs on has 4096. */
const MAX_STRIP_WIDTH = 4096;

/** The mip levels a texture has on the GPU: its provided chain (a KTX2 file's, an atlas slot's
 * shortened one), a generated full chain, or 1. */
export const getTextureLevelCount = (texture: THREE.Texture) => {
  const provided = texture.mipmaps?.length ?? 0;
  if (provided) return provided;
  const size = getTextureSize(texture);
  if (size && texture.generateMipmaps && MIPMAP_FILTERS.includes(texture.minFilter)) {
    return Math.floor(Math.log2(Math.max(size.width, size.height))) + 1;
  }
  return 1;
};

/** A level's size: each level halves, down to 1 px. */
export const getTextureLevelSize = (texture: THREE.Texture, level: number) => {
  const size = getTextureSize(texture);
  if (!size) return null;
  return { width: Math.max(1, size.width >> level), height: Math.max(1, size.height >> level) };
};

const isArrayTexture = (texture: THREE.Texture) =>
  Boolean(
    (texture as THREE.CompressedArrayTexture).isCompressedArrayTexture ||
      (texture as THREE.DataArrayTexture).isDataArrayTexture
  );

/** The material sampling `source` at a level and layer, both uniforms: one shader for every tile
 * and level. */
const createPreviewMaterial = (source: THREE.Texture) => {
  const levelUniform = uniform(0);
  const layerUniform = uniform(0, 'int');
  // The quad's v is 0 at the top (three's QuadMesh), a texture's v is up
  const sampleUv = uv().mul(vec2(1, -1)).add(vec2(0, 1)) as unknown as TextureUV;
  let node = texture(source, sampleUv).level(levelUniform);
  if (isArrayTexture(source)) node = node.depth(int(layerUniform));
  const material = new THREE.NodeMaterial();
  material.name = 'TexturePreview';
  // Keeps the alpha (an opaque material's is forced to 1)
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = node;
  return { material, levelUniform, layerUniform };
};

/** One tile's rows out of the strip's readback: WebGPU's rows start at the top and are padded to
 * 256 bytes, WebGL's start at the bottom. */
const readTile = (
  data: ArrayLike<number>,
  stripWidth: number,
  tile: number,
  width: number,
  height: number,
  isBottomUp: boolean
) => {
  const rowBytes = stripWidth * 4;
  const stride = height > 1 ? (data.length - rowBytes) / (height - 1) : rowBytes;
  const out = new Uint8ClampedArray(width * height * 4);
  const tileOffset = tile * width * 4;
  for (let row = 0; row < height; row++) {
    const srcRow = isBottomUp ? height - 1 - row : row;
    const start = srcRow * stride + tileOffset;
    out.set((data as Uint8Array).subarray(start, start + width * 4), row * width * 4);
  }
  return new ImageData(out, width, height);
};

/**
 * Renders `source` at one mip level on the GPU and reads it back, one tile per layer.
 * @param source any registered or loaded texture (it is uploaded if it isn't yet)
 * @param opts {@link TexturePreviewOpts}
 */
export const renderTexturePreviewAsync = async (
  source: THREE.Texture,
  { level = 0, layers, maxSize = 256 }: TexturePreviewOpts = {}
): Promise<TexturePreview> => {
  const renderer = getBakeRenderer('renderTexturePreviewAsync');
  const levelCount = getTextureLevelCount(source);
  if (level < 0 || level >= levelCount) {
    throw new Error(
      `renderTexturePreviewAsync: level ${level} is out of range (the texture has ${levelCount}).`
    );
  }
  const levelSize = getTextureLevelSize(source, level);
  if (!levelSize) throw new Error('renderTexturePreviewAsync: the texture has no size yet.');
  const depth = getTextureDepth(source);
  const tileLayers = isArrayTexture(source) ? layers ?? [...Array(depth).keys()] : [0];
  for (const layer of tileLayers) {
    if (layer < 0 || layer >= depth) {
      throw new Error(
        `renderTexturePreviewAsync: layer ${layer} is out of range (the texture has ${depth}).`
      );
    }
  }

  const scale = Math.min(1, maxSize / Math.max(levelSize.width, levelSize.height));
  const width = Math.max(1, Math.round(levelSize.width * scale));
  const height = Math.max(1, Math.round(levelSize.height * scale));
  const perStrip = Math.max(1, Math.floor(MAX_STRIP_WIDTH / width));
  const isBottomUp = Boolean((renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend);

  const { material, levelUniform, layerUniform } = createPreviewMaterial(source);
  const quad = new THREE.QuadMesh(material);
  levelUniform.value = level;
  const tiles: TexturePreviewTile[] = [];
  try {
    for (let first = 0; first < tileLayers.length; first += perStrip) {
      const stripLayers = tileLayers.slice(first, first + perStrip);
      const stripWidth = stripLayers.length * width;
      const target = new THREE.RenderTarget(stripWidth, height, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace:
          source.colorSpace === THREE.SRGBColorSpace ? THREE.SRGBColorSpace : THREE.NoColorSpace,
        generateMipmaps: false,
        depthBuffer: false,
      });
      target.texture.name = 'TexturePreview.strip';
      try {
        withBakeRendererState(renderer, () => {
          clearBakeTarget(renderer, target);
          renderer.autoClear = false;
          stripLayers.forEach((layer, i) => {
            layerUniform.value = layer;
            target.viewport.set(i * width, 0, width, height);
            quad.render(renderer);
          });
          target.viewport.set(0, 0, stripWidth, height);
        });
        const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, stripWidth, height);
        stripLayers.forEach((layer, i) =>
          tiles.push({
            layer,
            image: readTile(data as ArrayLike<number>, stripWidth, i, width, height, isBottomUp),
          })
        );
      } finally {
        target.dispose();
      }
    }
  } finally {
    material.dispose();
  }
  return {
    level,
    levelWidth: levelSize.width,
    levelHeight: levelSize.height,
    width,
    height,
    tiles,
  };
};
