import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../utils/Logger';
import { HDRLoader } from 'three/examples/jsm/Addons.js';
import { isHDR } from '../utils/helpers';

export type TexOpts = {
  image?: TexImageSource | OffscreenCanvas;
  mapping?: THREE.Mapping;
  wrapS?: THREE.Wrapping;
  wrapT?: THREE.Wrapping;
  magFilter?: THREE.MagnificationTextureFilter;
  minFilter?: THREE.MinificationTextureFilter;
  format?: THREE.PixelFormat;
  type?: THREE.TextureDataType;
  anisotropy?: number;
  colorSpace?: THREE.ColorSpace;
};

export type TextureProps = {
  id?: string;
  fileName?: string | string[];
  path?: string;
  useHDRLoader?: boolean;
  texOpts?: TexOpts;
  throwOnError?: boolean;
  isPersistent?: boolean;
  userData?: Record<string, unknown>;
  debugData?: { name?: string; description?: string };
};

const textures: {
  [id: string]: {
    resource: THREE.Texture;
    count: number;
    persistent?: boolean;
  };
} = {};

export const incTextureRef = (id: string) => {
  if (textures[id]) {
    textures[id].count++;
  }
};

export const decTextureRef = (id: string) => {
  const entry = textures[id];
  if (!entry) return;

  entry.count--;

  if (entry.count <= 0 && !entry.persistent) {
    entry.resource.dispose();
    delete textures[id];
  }
};

export const setTexturePersistence = (id: string, state: boolean) => {
  const entry = textures[id];
  if (!entry) return;
  entry.persistent = state;

  if (!state && entry.count === 0) {
    entry.resource.dispose();
    delete textures[id];
  }
};

const setTextureOpts = (
  texture: THREE.Texture | THREE.DataTexture | THREE.CubeTexture,
  texOpts?: TexOpts,
  userData?: Record<string, unknown>,
  debugData?: { name?: string; description?: string }
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
  texture.userData = userData || {};
  if (debugData) {
    texture.name = debugData.name || texture.name;
    texture.userData.name = debugData.name;
    texture.userData.description = debugData.description;
  }
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
  throwOnError?: boolean,
  userData?: Record<string, unknown>,
  debugData?: { name?: string; description?: string },
  isPersistent?: boolean
) => {
  if (id && textures[id]) return textures[id].resource;

  if (!fileName) return getNoFileTexture(texOpts);

  if (isHDR(fileName)) {
    const loader = new HDRLoader();
    const texture = setTextureOpts(
      loader.setDataType(THREE.HalfFloatType).load(
        fileName,
        (texture) => texture,
        undefined,
        (err) => {
          const errorMsg = `Could not load HDR texture in createTexture (id: "${id}", fileName: "${fileName}")`;
          lerror(errorMsg, err);
          if (throwOnError) throw new Error(errorMsg);
          return new THREE.Texture();
        }
      ),
      texOpts
    );
    saveTexture(texture, id, isPersistent);
    return texture;
  }

  const loader = new THREE.TextureLoader();
  const texture = setTextureOpts(
    loader.load(
      fileName,
      (texture) => texture,
      undefined,
      (err) => {
        const errorMsg = `Could not load texture in createTexture (id: "${id}", fileName: "${fileName}")`;
        lerror(errorMsg, err);
        if (throwOnError) throw new Error(errorMsg);
        return new THREE.Texture();
      }
    ),
    texOpts
  );
  texture.userData = userData || {};
  if (debugData) {
    texture.name = debugData.name || texture.name;
    texture.userData.name = debugData.name;
    texture.userData.description = debugData.description;
  }
  saveTexture(texture, id, isPersistent);
  return texture;
};

/**
 * Loads one or more textures in the background.
 * @param texData - array of objects: { id?: string; fileName?: string; texOpts?: {@link TexOpts} }[]
 * @param updateStatusFn - optional status update function
 * @param onErrorAction - optional on error action
 */
export const loadTextures = (
  texData: {
    id?: string;
    fileName?: string;
    texOpts?: TexOpts;
    isPersistent?: boolean;
    userData?: Record<string, unknown>;
    debugData?: { name?: string; description?: string };
  }[],
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
    const { id, fileName, texOpts, isPersistent, userData, debugData } = texData[index];
    const loader = new THREE.TextureLoader();

    if (id && textures[id]) {
      batchTextures[id] = textures[id].resource;
      loadedCount++;
      if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
      return;
    }

    if (fileName) {
      loader.load(
        fileName,
        (texture) => {
          const texId = id || texture.uuid;
          setTextureOpts(texture, texOpts, userData, debugData);
          saveTexture(texture, texId, isPersistent);
          batchTextures[texId] = texture;
          loadedCount++;
          if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
        },
        undefined,
        (err) => {
          const errorMsg = `Could not load texture in loadTextures (id: ${id}, fileName: ${fileName})`;
          lerror(errorMsg, err);
          if (onErrorAction === 'THROW_ERROR') {
            throw new Error(errorMsg);
          }
          if (onErrorAction === 'EMPTY_TEXTURE') {
            const texture = createTexture(
              id,
              undefined,
              texOpts,
              false,
              userData,
              debugData,
              isPersistent
            );
            const texId = id || texture.uuid;
            batchTextures[texId] = texture;
          }
          loadedCount++;
          if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
        }
      );
    } else {
      const texture = createTexture(
        id,
        undefined,
        texOpts,
        false,
        userData,
        debugData,
        isPersistent
      );
      const texId = id || texture.uuid;
      batchTextures[texId] = texture;
      loadedCount++;
      if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
    }
  };

  // Call once before loading
  if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);

  for (let i = 0; i < totalCount; i++) {
    loadOneBatchTexture(i);
  }
};

/**
 * Creates or retrieves a texture to be used without async loading logic.
 */
export const loadTexture = ({
  id,
  fileName,
  texOpts,
  throwOnError,
  isPersistent,
  userData,
  debugData,
}: {
  id?: string;
  fileName?: string;
  texOpts?: TexOpts;
  throwOnError?: boolean;
  isPersistent?: boolean;
  userData?: Record<string, unknown>;
  debugData?: { name?: string; description?: string };
}) => {
  if (id) {
    const texture = getTexture(id);
    if (texture) return texture;
  }
  if (fileName) {
    const texture = getTexture(fileName);
    if (texture) return texture;
  }
  const texture = createTexture(
    id,
    fileName,
    texOpts,
    throwOnError,
    userData,
    debugData,
    isPersistent
  );
  saveTexture(texture, id || fileName || texture.uuid, isPersistent);
  return texture;
};

/**
 * Loads a texture asynchronously supporting standard textures, HDR data textures, and CubeTextures.
 */
export const loadTextureAsync = async ({
  id,
  fileName,
  path,
  useHDRLoader,
  texOpts,
  throwOnError,
  isPersistent,
  userData,
  debugData,
}: TextureProps) => {
  if (id && textures[id]) return textures[id].resource;

  if (!fileName) return getNoFileTexture(texOpts);

  let loaderType = '';

  try {
    if (typeof fileName === 'string') {
      if (useHDRLoader && isHDR(fileName)) {
        // Data texture
        loaderType = 'HDRLoader';
        const loader = new HDRLoader();
        const loadedTexture = setTextureOpts(
          await loader.setPath(path || './').loadAsync(fileName),
          texOpts,
          userData,
          debugData
        );
        saveTexture(loadedTexture, id || loadedTexture.uuid, isPersistent);
        return loadedTexture as THREE.DataTexture;
      } else {
        if (useHDRLoader && !isHDR(fileName)) {
          lwarn(
            `[Aekasha Texture Pipeline] useHDRLoader override ignored for non-HDR file extension: ${fileName}`
          );
        }

        // Texture
        loaderType = 'TextureLoader';
        const loader = new THREE.TextureLoader();
        const loadedTexture = setTextureOpts(
          await loader.setPath(path || './').loadAsync(fileName),
          texOpts,
          userData,
          debugData
        );
        saveTexture(loadedTexture, id || loadedTexture.uuid, isPersistent);
        return loadedTexture as THREE.Texture;
      }
    } else {
      // Cube texture
      if (fileName.length !== 6) {
        throw new Error(
          `Cube texture has to have exactly 6 images in an array (found ${fileName.length} images).`
        );
      }
      loaderType = 'CubeTextureLoader';
      const loader = new THREE.CubeTextureLoader();
      const loadedTexture = setTextureOpts(
        await loader.setPath(path || './').loadAsync(fileName),
        texOpts,
        userData,
        debugData
      );
      saveTexture(loadedTexture, id || loadedTexture.uuid, isPersistent);
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
 * Returns a texture or undefined based on the id.
 */
export const getTexture = (id: string) => textures[id]?.resource;

/**
 * Returns multiple textures based on an array of ids.
 */
export const getTextures = (ids: string[]) =>
  ids.map((id) => textures[id]?.resource).filter(Boolean) as THREE.Texture[];

/**
 * Returns a flat map object of all existing texture resources.
 */
export const getAllTextures = () => {
  const flatMap: { [id: string]: THREE.Texture } = {};
  Object.keys(textures).forEach((key) => {
    flatMap[key] = textures[key].resource;
  });
  return flatMap;
};

export const getTextureRegistry = () => textures;

/**
 * Checks whether a texture with a specific id exists in memory cache.
 */
export const doesTextureExist = (id: string) => Boolean(textures[id]);

/**
 * Forcefully disposes and removes one or multiple textures from memory cache.
 */
export const deleteTexture = (id: string | string[]) => {
  const targetIds = Array.isArray(id) ? id : [id];
  const idsDeleted: string[] = [];

  for (const texId of targetIds) {
    const entry = textures[texId];
    if (!entry) continue;

    entry.resource.dispose();
    delete textures[texId];
    idsDeleted.push(texId);
  }

  if (!idsDeleted.length) {
    lwarn(
      `None of the textures with ids "${targetIds.join(', ')}" could be found and could not be deleted.`
    );
    return;
  }

  const idsNotDeleted = targetIds.filter((texId) => !idsDeleted.includes(texId));
  if (idsNotDeleted.length) {
    lwarn(`Textures with ids "${idsNotDeleted.join(', ')}" could not be found or deleted.`);
  }
};

/**
 * Saves a texture instance inside the engine tracking registry.
 */
export const saveTexture = <T extends THREE.Texture = THREE.Texture>(
  texture: T,
  givenId?: string,
  isPersistent?: boolean
): T => {
  const id = givenId || texture.uuid;
  if (textures[id]) return textures[id].resource as T;

  texture.userData.id = id;
  textures[id] = {
    resource: texture,
    count: 0,
    ...(isPersistent ? { persistent: true } : {}),
  };
  return texture;
};
