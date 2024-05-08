import * as THREE from 'three';

const scenes: { [id: string]: THREE.Scene } = {};
let currentScene: THREE.Scene | null = null;
let currentSceneId: string | null = null;

export const createScene = (id: string, isCurrentScene?: boolean) => {
  if (scenes[id]) {
    throw new Error(
      `Scene with id "${id}" already exists. Pick another id or delete the scene first before recreating it.`
    );
  }

  const scene = new THREE.Scene();

  scenes[id] = scene;

  if (isCurrentScene) setCurrentScene(id);

  return scene;
};

export const getScene = (id: string) => {
  const scene = scenes[id];
  if (!scene) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find scene with id "${id}" in getScene(id).`);
  }
  return scene || null;
};

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
    console.warn(`Could not find scene with id "${id}" in deleteScene(id).`);
    return;
  }

  // @TODO:
  // Traverse all children objects:
  // - Remove all textures (if keepTextures !== true)
  // - Remove all materials (if keepMaterials !== true)
  // - Remove all geometries (if keepGeometries !== true)
  // - Remove all objects (respect keepMeshes and keepLights)
  opts?.keepTextures;
  opts?.keepMaterials;
  opts?.keepGeometries;
  opts?.keepMeshes;
  opts?.keepLights;

  delete scenes[id];
};

export const setCurrentScene = (id: string | null) => {
  if (currentSceneId === id) return currentScene;
  const nextScene = id ? scenes[id] : null;
  if (id && !nextScene) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find scene with id "${id}" in useScene(id).`);
    return currentScene;
  }
  currentSceneId = id;
  currentScene = nextScene;
  return nextScene;
};

export const getCurrentScene = () => currentScene;
