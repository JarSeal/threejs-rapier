import * as THREE from 'three';
import { lerror, lwarn } from '../utils/Logger';

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

const getNoFileTexture = (texOpts?: TexOpts) =>
  new THREE.Texture(
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

const createTexture = (
  id?: string,
  fileName?: string,
  texOpts?: TexOpts,
  throwOnError?: boolean
) => {
  if (id && textures[id]) {
    throw new Error(
      `Texture with id "${id}" already exists. Pick another id or delete the texture first before recreating it (in loadTexture).`
    );
  }

  if (!fileName) return getNoFileTexture(texOpts);

  const loader = new THREE.TextureLoader();
  const texture = setTextureOpts(
    loader.load(
      fileName,
      (texture) => texture,
      undefined,
      (err) => {
        const errorMsg = `Could not load texture in createTexture (id: "${id}", "fileName: ${fileName}")`;
        lerror(errorMsg, err);
        if (throwOnError) throw new Error(errorMsg);
        return new THREE.Texture();
      }
    ),
    texOpts
  );
  return texture;
};

/**
 * Loads one or more textures in the background.
 * @param texData array of objects: { id?: string; fileName?: string; texOpts?: {@link TexOpts} }[]
 * @param updateStatusFn optional status update function: (loadedTextures: { [id: string]: THREE.Texture }, loadedCount: number, totalCount: number) => void
 * @param onErrorAction optional on error action: 'NO_TEXTURE' | 'EMPTY_TEXTURE' | 'THROW_ERROR'. This determines what happens when a texture load fails. 'NO_TEXTURE' does nothing (default), 'EMPTY_TEXTURE' creates an empty placeholder texture for the failed texture, and 'THROW_ERROR' throws an Error.
 */
export const loadTextures = (
  texData: { id?: string; fileName?: string; texOpts?: TexOpts }[],
  updateStatusFn?: (
    loadedTextures: { [id: string]: THREE.Texture },
    loadedCount: number,
    totalCount: number
  ) => void,
  onErrorAction?: 'NO_TEXTURE' | 'EMPTY_TEXTURE' | 'THROW_ERROR'
) => {
  const totalCount = texData.length;
  let loadedCount = 0;
  if (!totalCount) {
    throw new Error('Could not load textures, "texData" array was empty.');
  }

  const batchTextures: { [id: string]: THREE.Texture } = {};

  const loadOneBatchTexture = (index: number) => {
    const { id, fileName, texOpts } = texData[index];
    const loader = new THREE.TextureLoader();

    if (id && textures[id]) {
      throw new Error(
        `Texture with id "${id}" already exists. Pick another id or delete the texture first before recreating it (in loadTextures).`
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
          const errorMsg = `Could not load texture in loadTextures (id: ${id}, fileName: ${fileName})`;
          lerror(errorMsg, err);
          if (onErrorAction === 'THROW_ERROR') {
            throw new Error(errorMsg);
          }
          if (onErrorAction === 'EMPTY_TEXTURE') {
            const texture = createTexture(id, undefined, texOpts);
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
      const texture = createTexture(id, undefined, texOpts);
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

/**
 * Creates a texture to be used without loading logic. The texture is usable right away.
 * @param id optional id string, defaults to texture.uuid
 * @param fileName optional file path to be loaded. If no fileName is provided, an empty Texture is created.
 * @param texOpts optional {@link TexOpts}
 * @returns THREE.Texture
 */
export const loadTexture = ({
  id,
  fileName,
  texOpts,
  throwOnError,
}: {
  id?: string;
  fileName?: string;
  texOpts?: TexOpts;
  throwOnError?: boolean;
}) => {
  const texture = createTexture(id, fileName, texOpts, throwOnError);
  texture.userData.id = id || texture.uuid;
  textures[id || texture.uuid] = texture;
  return texture;
};

// @TODO: add JSDoc comment
export const loadTextureAsync = async ({
  id,
  fileName,
  texOpts,
  throwOnError,
}: {
  id?: string;
  fileName?: string;
  texOpts?: TexOpts;
  throwOnError?: boolean;
}) => {
  if (id && textures[id]) {
    throw new Error(
      `Texture with id "${id}" already exists. Pick another id or delete the texture first before recreating it (in loadTextureAsync).`
    );
  }

  if (!fileName) return getNoFileTexture(texOpts);

  const loader = new THREE.TextureLoader();
  try {
    const loadedTexture = await loader.loadAsync(fileName);
    const texture = setTextureOpts(loadedTexture, texOpts);
    texture.userData.id = id || texture.uuid;
    textures[id || texture.uuid] = texture;
    return texture;
  } catch (err) {
    const errorMsg = `Could not load texture in loadTextureAsync (id: "${id}", "fileName: ${fileName}")`;
    lerror(errorMsg, err);
    if (throwOnError) throw new Error(errorMsg);
    return getNoFileTexture(texOpts);
  }
};

// @TODO: add JSDoc comment
export const getTexture = (id: string) => textures[id];

// @TODO: add JSDoc comment
export const getTextures = (ids: string[]) => ids.map((id) => textures[id]);

// @TODO: add JSDoc comment
export const deleteTexture = (id: string | string[]) => {
  if (typeof id === 'string') {
    const texture = getTexture(id);
    if (!texture) {
      lwarn(
        `Texture with id "${id}" could not be found and could not be deleted (single texture deletion).`
      );
      return;
    }
    texture.dispose();
    delete textures[id];
    return;
  }

  const textureArr = getTextures(id);
  const idsDeleted: string[] = [];
  for (let i = 0; i < textureArr.length; i++) {
    const texture = textureArr[i];
    if (!texture) continue;
    texture.dispose();
    delete textures[id[i]];
    idsDeleted.push(id[i]);
  }

  if (!textureArr.length) {
    lwarn(
      `None of the textures with ids "${id.join(', ')}" could be found and could not be deleted (multiple texture deletion).`
    );
    return;
  }

  const idsNotDeleted = id.filter((texId) => !idsDeleted.includes(texId));
  if (idsNotDeleted) {
    lwarn(
      `Textures with ids "${idsNotDeleted.join(', ')}" could be found and could not be deleted (multiple texture deletion) or textures did not have an userData.id set.`
    );
  }
};

// @TODO: add JSDoc comment
export const getAllTextures = () => textures;
