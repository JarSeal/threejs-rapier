import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../utils/Logger';
import { RGBELoader } from 'three/examples/jsm/Addons.js';
import { isHDR } from '../utils/helpers';

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

const setTextureOpts = (
  texture: THREE.Texture | THREE.DataTexture | THREE.CubeTexture,
  texOpts?: TexOpts
) => {
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

const getNoFileTexture = (texOpts?: TexOpts, isCubeTexture?: boolean) =>
  isCubeTexture
    ? new THREE.CubeTexture(
        undefined,
        undefined,
        texOpts?.wrapS,
        texOpts?.wrapT,
        texOpts?.magFilter,
        texOpts?.minFilter,
        texOpts?.format,
        texOpts?.type,
        texOpts?.anisotropy,
        texOpts?.colorSpace
      )
    : new THREE.Texture(
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
  if (id && textures[id]) return textures[id];

  if (!fileName) return getNoFileTexture(texOpts);

  if (isHDR(fileName)) {
    const loader = new RGBELoader();
    const texture = setTextureOpts(
      loader.setDataType(THREE.HalfFloatType).load(
        fileName,
        (texture) => texture,
        undefined,
        (err) => {
          const errorMsg = `Could not load HDR texture in createTexture (id: "${id}", "fileName: ${fileName}")`;
          lerror(errorMsg, err);
          if (throwOnError) throw new Error(errorMsg);
          return new THREE.Texture();
        }
      ),
      texOpts
    );
    return texture;
  }

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

    if (id && textures[id]) return;

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
 * @param throwOnError optional value whether loadTexture should throw on an error
 * @returns THREE.Texture | THREE.DataTexture
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
  if (id) {
    const texture = getTexture(id);
    if (texture) return texture;
  }
  if (fileName) {
    const texture = getTexture(fileName);
    if (texture) return texture;
  }
  const texture = createTexture(id, fileName, texOpts, throwOnError);
  texture.userData.id = id || fileName || texture.uuid;
  textures[id || fileName || texture.uuid] = texture;
  return texture;
};

/**
 * Creates a texture to be used without loading logic. The texture is usable right away.
 * @param id optional id string, defaults to texture.uuid
 * @param fileName (string or array of strings) optional file name to be loaded. If no fileName is provided, an empty Texture is created. If the fileName is an array, the CubeTextureLoader will be used.
 * @param path optional file path, default is './'.
 * @param texOpts optional {@link TexOpts}
 * @param throwOnError optional value whether loadTextureAsync should throw on an error
 * @returns Promise<THREE.Texture | THREE.DataTexture | THREE.CubeTexture>
 */
export const loadTextureAsync = async ({
  id,
  fileName,
  path,
  useRGBELoader,
  texOpts,
  throwOnError,
}: {
  id?: string;
  fileName?: string | string[];
  path?: string;
  useRGBELoader?: boolean;
  texOpts?: TexOpts;
  throwOnError?: boolean;
}) => {
  if (id && textures[id]) return textures[id];

  if (!fileName) return getNoFileTexture(texOpts);

  let loaderType = '';

  try {
    if (typeof fileName === 'string') {
      if (useRGBELoader) {
        // Data texture
        loaderType = 'RGBELoader';
        const loader = new RGBELoader();
        const loadedTexture = setTextureOpts(
          await loader.setPath(path || './').loadAsync(fileName),
          texOpts
        );
        loadedTexture.userData.id = id || loadedTexture.uuid;
        textures[id || loadedTexture.uuid] = loadedTexture;
        return loadedTexture as THREE.DataTexture;
      } else {
        // Texture
        loaderType = 'TextureLoader';
        const loader = new THREE.TextureLoader();
        const loadedTexture = setTextureOpts(
          await loader.setPath(path || './').loadAsync(fileName),
          texOpts
        );
        loadedTexture.userData.id = id || loadedTexture.uuid;
        textures[id || loadedTexture.uuid] = loadedTexture;
        return loadedTexture as THREE.Texture;
      }
    } else {
      // Cube texture
      if (fileName.length < 6 || fileName.length > 6) {
        throw new Error(
          `Cube texture has to have exactly 6 images in an array (found ${fileName.length} images).`
        );
      }
      loaderType = 'CubeTextureLoader';
      const loader = new THREE.CubeTextureLoader();
      const loadedTexture = setTextureOpts(
        await loader.setPath(path || './').loadAsync(fileName),
        texOpts
      );
      loadedTexture.userData.id = id || loadedTexture.uuid;
      textures[id || loadedTexture.uuid] = loadedTexture;
      return loadedTexture as THREE.CubeTexture;
    }
  } catch (err) {
    const errorMsg = `Could not load texture in loadTextureAsync (id: "${id}", fileName: "${typeof fileName === 'string' ? fileName : fileName.join(', ')}", ${path ? `path: "${path}", ` : ''}loaderType: "${loaderType}")`;
    lerror(errorMsg, err);
    if (throwOnError) throw new Error(errorMsg);
    if (Array.isArray(fileName)) return getNoFileTexture(texOpts, true) as THREE.CubeTexture;
    return getNoFileTexture(texOpts) as THREE.Texture;
  }
};

/**
 * Returns a texture or undefined based on the id
 * @param id (string) texture id
 * @returns Three.js texture | undefined
 */
export const getTexture = (id: string) => textures[id];

/**
 * Returns one or multiple textures based on the ids
 * @param id (array of strings) one or multiple texture ids
 * @returns Array of Three.js textures
 */
export const getTextures = (ids: string[]) => ids.map((id) => textures[id]);

/**
 * Returns all created textures that exist
 * @returns array of Three.js textures
 */
export const getAllTextures = () => textures;

/**
 * Checks, with a texture id, whether a texture exists or not
 * @param id (string) texture id
 * @returns boolean
 */
export const doesTextureExist = (id: string) => Boolean(textures[id]);

/**
 * Deletes a texture based on an id
 * @param id (string | string[]) texture id or array of texture ids
 */
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
