import * as THREE from 'three';
import { lerror } from '../utils/Logger';

type TexOpts = {
  image?: TexImageSource | OffscreenCanvas;
  mapping?: THREE.Mapping;
  wrapS?: THREE.Wrapping;
  wrapT?: THREE.Wrapping;
  magFilter?: THREE.MagnificationTextureFilter;
  minFilter?: THREE.MinificationTextureFilter;
  format?: THREE.PixelFormat;
  type?: THREE.TextureDataType;
  anisotropy?: number;
  colorSpace?: string;
};

const textures: { [id: string]: THREE.Texture } = {};

const setTextureOpts = (texture: THREE.Texture, texOpts?: TexOpts) => {
  if (texOpts?.mapping) texture.mapping = texOpts.mapping;
  if (texOpts?.wrapS) texture.wrapS = texOpts.wrapS;
  if (texOpts?.wrapT) texture.wrapT = texOpts.wrapT;
  if (texOpts?.magFilter) texture.magFilter = texOpts.magFilter;
  if (texOpts?.minFilter) texture.minFilter = texOpts.minFilter;
  if (texOpts?.format) texture.format = texOpts.format;
  if (texOpts?.type) texture.type = texOpts.type;
  if (texOpts?.anisotropy) texture.anisotropy = texOpts.anisotropy;
  if (texOpts?.colorSpace) texture.colorSpace = texOpts.colorSpace;
  return texture;
};

const loadTexture = (fileName?: string, texOpts?: TexOpts) => {
  if (!fileName) {
    return new THREE.Texture(
      texOpts?.image,
      texOpts?.mapping,
      texOpts?.wrapS,
      texOpts?.wrapT,
      texOpts?.magFilter,
      texOpts?.minFilter,
      texOpts?.format,
      texOpts?.type,
      texOpts?.anisotropy,
      texOpts?.colorSpace
    );
  }
  const loader = new THREE.TextureLoader();
  const texture = setTextureOpts(loader.load(fileName), texOpts);
  return texture;
};

export const batchLoadTextures = (
  texData: { id?: string; fileName?: string; texOpts?: TexOpts }[],
  updateStatusFn?: (
    batchTextures: { [id: string]: THREE.Texture },
    loadedCount: number,
    totalCount: number
  ) => void,
  onErrorAction?: 'noTexture' | 'emptyTexture' | 'throwError'
) => {
  const totalCount = texData.length;
  let loadedCount = 0;
  if (!totalCount) {
    throw new Error('Could not batch load textures, "idsAndFileNames" object was empty.');
  }

  const batchTextures: { [id: string]: THREE.Texture } = {};

  const loadOneBatchTexture = (index: number) => {
    const { id, fileName, texOpts } = texData[index];
    const loader = new THREE.TextureLoader();

    if (id && textures[id]) {
      throw new Error(
        `Texture with id "${id}" already exists. Pick another id or delete the texture first before recreating it (in batch loader).`
      );
    }

    if (fileName) {
      loader.load(
        fileName,
        (texture) => {
          const texId = id || texture.uuid;
          texture.userData.id = texId;
          batchTextures[texId] = texture;
          textures[texId] = texture;
          loadedCount++;
          updateStatusFn && updateStatusFn(batchTextures, loadedCount, totalCount);
        },
        undefined,
        (err) => {
          const errorMsg = `Could not load texture in batch loader (id: ${id}, fileName: ${fileName})`;
          lerror(errorMsg, err);
          if (onErrorAction === 'throwError') {
            throw new Error(errorMsg);
          }
          if (onErrorAction === 'emptyTexture') {
            const texture = loadTexture(undefined, texOpts);
            const texId = id || texture.uuid;
            texture.userData.id = texId;
            batchTextures[texId] = texture;
            textures[texId] = texture;
          }
          loadedCount++;
          updateStatusFn && updateStatusFn(batchTextures, loadedCount, totalCount);
        }
      );
    } else {
      const texture = loadTexture(undefined, texOpts);
      const texId = id || texture.uuid;
      texture.userData.id = texId;
      batchTextures[texId] = texture;
      textures[texId] = texture;
      loadedCount++;
      updateStatusFn && updateStatusFn(batchTextures, loadedCount, totalCount);
    }
  };

  // Call once before loading
  updateStatusFn && updateStatusFn(batchTextures, loadedCount, totalCount);

  for (let i = 0; i < totalCount; i++) {
    loadOneBatchTexture(i);
  }
};

export const createTexture = ({
  id,
  fileName,
  texOpts,
}: {
  id?: string;
  fileName?: string;
  texOpts?: TexOpts;
}) => {
  let texture: THREE.Texture | null = null;

  if (id && textures[id]) {
    throw new Error(
      `Texture with id "${id}" already exists. Pick another id or delete the texture first before recreating it.`
    );
  }

  texture = loadTexture(fileName, texOpts);
  texture.userData.id = id || texture.uuid;
  textures[id || texture.uuid] = texture;

  return texture;
};

export const getTexture = (id: string | string[]) => {
  if (typeof id === 'string') return textures[id];
  return id.map((textureId) => textures[textureId]);
};

// deleteOneTexture
// export deleteTexture

export const getAllTextures = () => textures;
