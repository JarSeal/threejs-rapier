import * as THREE from 'three';
import { deleteMesh } from './Mesh';
import { deleteGeometry } from './Geometry';
import { deleteMaterial } from './Material';

const scenes: { [id: string]: THREE.Scene } = {};
let currentScene: THREE.Scene | null = null;
let currentSceneId: string | null = null;

export type SceneOptions = {
  isCurrentScene?: boolean;
  background?: THREE.Color | THREE.Texture | THREE.CubeTexture;
  backgroundColor?: THREE.Color;
  backgroundTexture?: THREE.Texture;
  backgroundSkybox?: THREE.CubeTexture;
};

// @TODO: add JSDoc comment
export const createScene = (id: string, opts?: SceneOptions) => {
  if (scenes[id]) {
    throw new Error(
      `Scene with id "${id}" already exists. Pick another id or delete the scene first before recreating it.`
    );
  }

  const scene = new THREE.Scene();
  if (opts?.background) scene.background = opts.background;
  if (opts?.backgroundColor) scene.background = opts.backgroundColor;
  if (opts?.backgroundTexture) scene.background = opts.backgroundTexture;
  if (opts?.backgroundSkybox) scene.background = opts.backgroundSkybox;

  scenes[id] = scene;

  if (opts?.isCurrentScene) setCurrentScene(id);

  return scene;
};

// @TODO: add JSDoc comment
export const getScene = (id: string) => {
  const scene = scenes[id];
  if (!scene) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find scene with id "${id}", in getScene(id).`);
  }
  return scene || null;
};

// @TODO: add JSDoc comment
export const deleteScene = (
  id: string,
  opts?: {
    keepTextures: boolean;
    keepMaterials: boolean;
    keepGeometries: boolean;
    keepMeshes: boolean;
    keepLights: boolean;
  }
) => {
  const scene = scenes[id];
  if (!scene) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find scene with id "${id}", in deleteScene(id).`);
    return;
  }

  scene.traverse((obj) => {
    if ('isMesh' in obj && !opts?.keepMeshes && obj.userData.id) {
      deleteMesh(obj.userData.id, {
        deleteGeometries: !opts?.keepGeometries,
        deleteMaterials: !opts?.keepMaterials,
        deleteTextures: !opts?.keepTextures,
      });
    } else if ('isMesh' in obj && opts?.keepMeshes) {
      const mesh = obj as THREE.Mesh;
      if (!opts?.keepGeometries) {
        const geo = mesh.geometry;
        deleteGeometry(geo.userData.id);
      }
      if (!opts?.keepMaterials) {
        const mat = mesh.material;
        if (Array.isArray(mat)) {
          for (let i = 0; i < mat.length; i++) {
            deleteMaterial(mat[i].userData.id, !opts.keepTextures);
          }
        } else {
          deleteMaterial(mat.userData.id, !opts.keepTextures);
        }
      }
    }

    // @TODO: keepLights
    // @TODO: keepGroups
    opts?.keepLights;
  });

  delete scenes[id];
};

// @TODO: add JSDoc comment
export const setCurrentScene = (id: string | null) => {
  if (currentSceneId === id) return currentScene;
  const nextScene = id ? scenes[id] : null;
  if (id && !nextScene) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find scene with id "${id}", in setCurrentScene(id).`);
    return currentScene;
  }
  currentSceneId = id;
  currentScene = nextScene;
  return nextScene;
};

// @TODO: add JSDoc comment
export const getCurrentScene = () => currentScene as THREE.Scene;

// @TODO: add JSDoc comment
export const getAllScenes = () => scenes;
