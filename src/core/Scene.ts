import * as THREE from 'three/webgpu';
import { deleteMesh } from './Mesh';
import { deleteGeometry } from './Geometry';
import { deleteMaterial } from './Material';
import { deleteGroup } from './Group';
import { lwarn } from '../utils/Logger';
import { deleteLight } from './Light';

type Looper = (delta: number) => void;

const scenes: { [id: string]: THREE.Scene } = {};
let currentScene: THREE.Scene | null = null;
let currentSceneId: string | null = null;
const sceneMainLoopers: { [sceneId: string]: Looper[] } = {};
const sceneAppLoopers: { [sceneId: string]: Looper[] } = {};

export type SceneOptions = {
  isCurrentScene?: boolean;
  background?: THREE.Color | THREE.Texture | THREE.CubeTexture;
  backgroundColor?: THREE.Color;
  backgroundTexture?: THREE.Texture;
  backgroundSkybox?: THREE.CubeTexture;
  mainLoopers?: Looper[];
  appLoopers?: Looper[];
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

  if (opts?.mainLoopers) sceneMainLoopers[id] = opts.mainLoopers;
  if (opts?.appLoopers) sceneAppLoopers[id] = opts.appLoopers;

  return scene;
};

// @TODO: add JSDoc comment
export const getScene = (id: string) => {
  const scene = scenes[id];
  if (!scene) {
    lwarn(`Could not find scene with id "${id}", in getScene(id).`);
  }
  return scene || null;
};

// @TODO: add JSDoc comment
export const deleteScene = (
  id: string,
  opts?: {
    deleteTextures?: boolean;
    deleteMaterials?: boolean;
    deleteGeometries?: boolean;
    deleteMeshes?: boolean;
    deleteLights?: boolean;
    deleteGroups?: boolean;
    deleteAll?: boolean;
  }
) => {
  const scene = scenes[id];
  if (!scene) {
    lwarn(`Could not find scene with id "${id}", in deleteScene(id).`);
    return;
  }

  const currentScene = getCurrentScene();
  if (currentScene.userData.id === scene.userData.id && currentScene.uuid === scene.uuid) {
    lwarn(
      `Cannot delete the current scene. Switch to another scene and then delete this scene (id: ${scene.userData.id || scene.uuid}). No scene was deleted.`
    );
    return;
  }

  scene.traverse((obj) => {
    if ('isMesh' in obj && (opts?.deleteMeshes || opts?.deleteAll) && obj.userData.id) {
      deleteMesh(obj.userData.id, {
        deleteGeometries: opts?.deleteGeometries,
        deleteMaterials: opts?.deleteMaterials,
        deleteTextures: opts?.deleteTextures,
      });
    } else if ('isMesh' in obj && !opts?.deleteMeshes) {
      const mesh = obj as THREE.Mesh;
      if (opts?.deleteGeometries || opts?.deleteAll) {
        const geo = mesh.geometry;
        let allGood = true;
        if (!geo) {
          lwarn(`Could not find mesh geometry in deleteScene (scene id: ${id})`);
          allGood = false;
        }
        const geoId = geo.userData.id;
        if (!geoId) {
          lwarn(`Could not find mesh geometry id in deleteScene (scene id: ${id})`);
          allGood = false;
        }
        if (allGood) deleteGeometry(geoId);
      }
      if (opts?.deleteMaterials || opts?.deleteAll) {
        const mat = mesh.material;
        let allGood = true;
        if (!mat) {
          lwarn(`Could not find mesh material(s) in deleteScene (scene id: ${id})`);
          allGood = false;
        }
        if (allGood) {
          if (Array.isArray(mat)) {
            for (let i = 0; i < mat.length; i++) {
              const matId = mat[i].userData.id;
              if (!matId) {
                lwarn(
                  `Could not find mesh material id in deleteScene (array of materials) (scene id: ${id})`
                );
                allGood = false;
              }
              if (allGood) deleteMaterial(matId, opts?.deleteTextures);
            }
          } else {
            const matId = mat.userData.id;
            if (!matId) {
              lwarn(`Could not find mesh material id in deleteScene (scene id: ${id})`);
              allGood = false;
            }
            if (allGood) deleteMaterial(matId, opts.deleteTextures);
          }
        }
      }
    }

    if ('isLight' in obj && (opts?.deleteLights || opts?.deleteAll)) {
      const lightId = obj.userData.id;
      let allGood = true;
      if (!lightId) {
        lwarn(`Could not find light id in deleteScene (scene id: ${id})`);
        allGood = false;
      }
      if (allGood) deleteLight(lightId);
    }

    if ('isGroup' in obj && (opts?.deleteGroups || opts?.deleteAll)) {
      deleteGroup(obj as THREE.Group, {
        deleteMeshes: opts?.deleteMeshes,
        deleteGeometries: opts?.deleteGeometries,
        deleteMaterials: opts?.deleteMaterials,
        deleteTextures: opts?.deleteTextures,
        deleteAll: opts?.deleteAll,
      });
    }
  });

  deleteSceneMainLoopers(id);
  deleteSceneAppLoopers(id);

  delete scenes[id];
};

// @TODO: add JSDoc comment
export const setCurrentScene = (id: string | null) => {
  if (currentSceneId === id) return currentScene;
  const nextScene = id ? scenes[id] : null;
  if (id && !nextScene) {
    lwarn(`Could not find scene with id "${id}" in setCurrentScene(id).`);
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

// @TODO: add JSDoc comment
export const getSceneMainLoopers = (sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) return sceneMainLoopers[id];
  lwarn(`Could not find scene with id ${id} in getSceneMainLoopers.`);
};

// @TODO: add JSDoc comment
export const addSceneMainLoopers = (looper: Looper, sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id && sceneMainLoopers[id]) {
    sceneMainLoopers[id].push(looper);
    return;
  } else if (id) {
    sceneMainLoopers[id] = [looper];
    return;
  }
  lwarn(`Could not find scene with id ${id} in addSceneMainLoopers.`);
};

// @TODO: add JSDoc comment
export const removeSceneMainLoopers = (index: number | number[], sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) {
    if (!sceneMainLoopers[id]) return;
    if (typeof index === 'number') {
      sceneMainLoopers[id] = sceneMainLoopers[id].filter((_, i) => i !== index);
      return;
    } else {
      for (let i = 0; i < index.length; i++) {
        sceneMainLoopers[id] = sceneMainLoopers[id].filter((_, i) => i !== index[i]);
      }
      return;
    }
  }
  lwarn(`Could not find scene with id ${id} in deleteSceneMainLoopers.`);
};

// @TODO: add JSDoc comment
export const deleteSceneMainLoopers = (sceneId: string) => delete sceneMainLoopers[sceneId];

// @TODO: add JSDoc comment
export const getSceneAppLoopers = (sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) return sceneAppLoopers[id];
  lwarn(`Could not find scene with id ${id} in getSceneAppLoopers.`);
};

// @TODO: add JSDoc comment
export const addSceneAppLoopers = (looper: Looper, sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id && sceneAppLoopers[id]) {
    sceneAppLoopers[id].push(looper);
    return;
  } else if (id) {
    sceneAppLoopers[id] = [looper];
    return;
  }
  lwarn(`Could not find scene with id ${id} in addSceneAppLoopers.`);
};

// @TODO: add JSDoc comment
export const removeSceneAppLoopers = (index: number | number[], sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) {
    if (!sceneAppLoopers[id]) return;
    if (typeof index === 'number') {
      sceneAppLoopers[id] = sceneAppLoopers[id].filter((_, i) => i !== index);
      return;
    } else {
      for (let i = 0; i < index.length; i++) {
        sceneAppLoopers[id] = sceneAppLoopers[id].filter((_, i) => i !== index[i]);
      }
      return;
    }
  }
  lwarn(`Could not find scene with id ${id} in deleteSceneAppLoopers.`);
};

// @TODO: add JSDoc comment
export const deleteSceneAppLoopers = (sceneId: string) => delete sceneMainLoopers[sceneId];
