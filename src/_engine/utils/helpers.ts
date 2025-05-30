import * as THREE from 'three/webgpu';
import { Materials, textureMapKeys } from '../core/Material';

/**
 * Returns the file name extension from a string
 * @param fileName (string) optional file name, if not provided then this will return null
 * @returns (string | null)
 */
export const getFileNameExt = (fileName?: unknown) => {
  if (typeof fileName !== 'string') return null;
  const splitFileName = (fileName || '').split('.');
  return splitFileName[splitFileName.length - 1];
};

/**
 * Determines whether the file name provided has an 'hdr' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isHDR = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'hdr';

/**
 * Determines whether the file name provided has an 'jpg' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isJPG = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'jpg';

/**
 * Determines whether the file name provided has an 'png' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isPNG = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'png';

type RemovalTypes =
  | THREE.Mesh
  | THREE.PerspectiveCamera
  | THREE.OrthographicCamera
  | THREE.CameraHelper
  | THREE.AmbientLight
  | THREE.HemisphereLight
  | THREE.DirectionalLight
  | THREE.DirectionalLightHelper
  | THREE.PointLight
  | THREE.PointLightHelper
  | THREE.SpotLight
  | THREE.SpotLightHelper;

/**
 * Removes a texture from memory
 * @param texture (THREE.Texture) Texture to remove
 */
export const removeTextureFromMemory = (texture: THREE.Texture) => {
  if ('dispose' in texture) texture.dispose();
};

/**
 * Removes a material or materials from memory
 * @param material (THREE.Material | THREE.Material[]) Material or materials to remove
 */
export const removeMaterialFromMemory = (material: Materials | Materials[]) => {
  if (Array.isArray(material)) {
    // Multiple materials
    for (let i = 0; i < material.length; i++) {
      const mat = material[i];
      for (let k = 0; k < textureMapKeys.length; k++) {
        const key = textureMapKeys[k] as keyof Materials;
        if (key in mat && mat[key]) {
          removeTextureFromMemory(mat[key] as THREE.Texture);
        }
      }
    }
    return;
  }
  // Single material
  for (let k = 0; k < textureMapKeys.length; k++) {
    const key = textureMapKeys[k] as keyof Materials;
    if (key in material && material[key]) {
      removeTextureFromMemory(material[key] as THREE.Texture);
    }
  }
};

/**
 * Removes a geometry from memory
 * @param geometry (THREE.BufferGeometry) Geometry to remove
 */
export const removeGeometryFromMemory = (geometry: THREE.BufferGeometry) => {
  if ('dispose' in geometry) geometry.dispose();
};

/**
 * Removes an object from memory and from the scene if present
 * @param obj ({@link RemovalTypes}) object to remove
 */
export const removeObjectFromMemory = (obj: RemovalTypes) => {
  obj.removeFromParent();

  if ('isMesh' in obj && obj.isMesh) {
    const mat = obj.material;
    if (mat) removeMaterialFromMemory(mat);
    const geo = obj.geometry;
    if (geo) removeGeometryFromMemory(geo);
  } else if ('dispose' in obj) {
    obj.dispose();
  }
};

/**
 * Removes the children of an object from memory and from the scene if present
 * @param obj ({@link RemovalTypes}) object with children to remove
 */
export const removeObjectChildrenFromMemory = (obj: RemovalTypes) => {
  const children = obj.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as RemovalTypes;
    removeObjectChildrenFromMemory(child);
    removeObjectFromMemory(child);
  }
};

/**
 * Removes the object and its children from memory and from the scene if present
 * @param obj ({@link RemovalTypes}) object to remove
 */
export const removeObjectAndChildrenFromMemory = (obj: RemovalTypes) => {
  removeObjectChildrenFromMemory(obj);
  removeObjectFromMemory(obj);
};
