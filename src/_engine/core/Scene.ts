import * as THREE from 'three/webgpu';
import { deleteMesh } from './Mesh';
import { deleteGeometry } from './Geometry';
import { deleteMaterial } from './Material';
import { deleteGroup } from './Group';
import { lwarn } from '../utils/Logger';
import { deleteLight } from './Light';
import { deleteTexture } from './Texture';
import {
  deletePhysicsObjectsBySceneId,
  deletePhysicsWorld,
  setCurrentScenePhysicsObjects,
} from './PhysicsRapier';
import { isDebugEnvironment } from './Config';
import { addScenesToSceneListing, removeScenesFromSceneListing } from '../debug/DebugTools';
import { getCurrentSceneLoader } from './SceneLoader';

type Looper = (delta: number) => void;

const scenes: { [id: string]: THREE.Group } = {};
const sceneOpts: { [id: string]: SceneOptions } = {};
let rootScene: THREE.Scene | null = null;
let currentScene: THREE.Group | null = null;
let currentSceneId: string | null = null;
let currentSceneOpts: SceneOptions | null = null;
const sceneMainLoopers: { [sceneId: string]: Looper[] } = {};
const sceneMainLateLoopers: { [sceneId: string]: Looper[] } = {};
const sceneAppLoopers: { [sceneId: string]: Looper[] } = {};
const sceneResizers: { [sceneId: string]: (() => void)[] } = {};

export type SceneOptions = {
  isCurrentScene?: boolean;
  background?: THREE.Color | THREE.Texture | THREE.CubeTexture;
  backgroundColor?: THREE.Color;
  backgroundTexture?: THREE.Texture;
  mainLoopers?: Looper[];
  mainLateLoopers?: Looper[];
  appLoopers?: Looper[];
};

/**
 * Creates a Three.js scene
 * @param id (string) scene id
 * @param opts ({@link SceneOptions})
 * @returns THREE.Group
 */
export const createScene = (id: string, opts?: SceneOptions) => {
  if (scenes[id]) {
    throw new Error(
      `Scene with id "${id}" already exists. Pick another id or delete the scene first before recreating it.`
    );
  }

  const scene = new THREE.Group();
  // @TODO: Remove these
  // if (opts?.background) scene.background = opts.background;
  // if (opts?.backgroundColor) scene.background = opts.backgroundColor;
  // if (opts?.backgroundTexture) scene.background = opts.backgroundTexture;

  if (opts) sceneOpts[id] = opts;
  scenes[id] = scene;

  if (opts?.isCurrentScene || !currentSceneId) setCurrentScene(id);

  if (opts?.mainLoopers) sceneMainLoopers[id] = opts.mainLoopers;
  if (opts?.mainLateLoopers) sceneMainLateLoopers[id] = opts.mainLateLoopers;
  if (opts?.appLoopers) sceneAppLoopers[id] = opts.appLoopers;

  if (isDebugEnvironment()) addScenesToSceneListing({ value: id, text: `[App] ${id}` });

  return scene;
};

/**
 * Returns a created scene (if it exists) based on the scene id
 * @param id (string) scene id
 * @returns THREE.Group | null
 */
export const getScene = (id: string, silent?: boolean) => {
  const scene = scenes[id];
  if (!scene && !silent) {
    lwarn(`Could not find scene with id "${id}", in getScene(id).`);
  }
  return scene || null;
};

/**
 * Deletes a scene based on the scene id. Options to delete the scene's objects can also be given.
 * @param id (string) scene id
 * @param opts (object) optional delete options
 */
export const deleteScene = (
  id: string,
  opts?: {
    deleteTextures?: boolean;
    deleteMaterials?: boolean;
    deleteGeometries?: boolean;
    deleteMeshes?: boolean;
    deleteLights?: boolean;
    deleteGroups?: boolean;
    deletePhysicsObjects?: boolean;
    deletePhysicsWorld?: boolean;
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

  if (isDebugEnvironment()) removeScenesFromSceneListing(id);

  // Delete loopers
  deleteSceneMainLoopers(id);
  deleteSceneMainLateLoopers(id);
  deleteSceneAppLoopers(id);

  // Delete skybox textures
  if (scene.userData.backgroundNodeTextureId) deleteTexture(scene.userData.backgroundNodeTextureId);

  if (opts?.deletePhysicsWorld || opts?.deleteAll) {
    // Delete physics world
    deletePhysicsWorld();
  } else if (opts?.deletePhysicsObjects) {
    deletePhysicsObjectsBySceneId(id);
  }

  delete scenes[id];
};

/**
 * Sets the current scene to be rendered
 * @param id (string) scene id
 * @returns THREE.Group | null
 */
export const setCurrentScene = (id: string | null) => {
  if (currentSceneId === id) return currentScene;
  const nextScene = id ? scenes[id] : null;
  if (id && !nextScene) {
    lwarn(`Could not find scene with id "${id}" in setCurrentScene(id).`);
    return currentScene;
  }
  currentSceneId = id;
  currentScene = nextScene;
  currentSceneOpts = id && sceneOpts[id] ? sceneOpts[id] : null;

  if (nextScene) {
    createRootScene();
    const rootScene = getRootScene() as THREE.Scene;
    rootScene.add(nextScene);
  }

  // Check scene loader status, if loading, add loaderGroup to current scene
  const sceneLoader = getCurrentSceneLoader();
  if (sceneLoader?.loaderGroup && sceneLoader.phase === 'LOAD' && currentScene) {
    currentScene.add(sceneLoader.loaderGroup);
  }

  setCurrentScenePhysicsObjects(id);

  return nextScene;
};

/**
 * Returns the current scene or creates one if not found
 * @returns THREE.Group
 */
export const getCurrentScene = () =>
  currentScene || createScene('__place_holder_scene', { isCurrentScene: true });

/**
 * Return the current scene id
 * @returns string
 */
export const getCurrentSceneId = () => currentSceneId;

/**
 * Return the current scene's scene options if found
 * @returns SceneOptions ({@link SceneOptions}) or undefined
 */
export const getCurrentSceneOpts = () => currentSceneOpts;

/**
 * Return the current scene's scene options if found
 * @param id (string) scene id
 * @returns SceneOptions ({@link SceneOptions}) or undefined
 */
export const getSceneOpts = (id: string) => sceneOpts[id];

/**
 * Sets the scene options for a specific scene
 * @param id (string) scene id
 * @param opts (partial {@link SceneOptions}) scene options
 */
export const setSceneOpts = (id: string, opts: Partial<SceneOptions>) => {
  const sOpts = sceneOpts[id];
  if (!sOpts) {
    const msg = `Could not find scene opts with id '${id}'. No scene opts were set.`;
    lwarn(msg);
    return;
  }
  sceneOpts[id] = { ...sOpts, ...opts };
};

/**
 * Checks if the scene id provided is the current scene id
 * @param id (string) scene id
 * @returns boolean
 */
export const isCurrentScene = (id: string) => id === currentSceneId;

/**
 * Return all existing scenes as an object
 * @returns (object) { [sceneId: string]: THREE.Group }
 */
export const getAllScenes = () => scenes;

/**
 * Returns all scene's main loopers
 * @param sceneId (string) scene id
 * @returns ({@link Looper}[])
 */
export const getSceneMainLoopers = (sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) return sceneMainLoopers[id] || [];
  lwarn(`Could not find scene with id ${id} in getSceneMainLoopers.`);
  return [];
};

/**
 * Returns all scene's main late loopers (they are executed after the loop rendering)
 * @param sceneId (string) scene id
 * @returns ({@link Looper}[])
 */
export const getSceneMainLateLoopers = (sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) return sceneMainLateLoopers[id] || [];
  lwarn(`Could not find scene with id ${id} in getSceneMainLateLoopers.`);
  return [];
};

/**
 * Adds a scene main looper
 * @param looper ({@link Looper}) the looper function to be executed
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 * @param isLateLooper (boolean) whether the looper is a scene main late looper or not (default is false).
 */
export const addSceneMainLooper = (looper: Looper, sceneId?: string, isLateLooper?: boolean) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (isLateLooper) {
    if (id && sceneMainLateLoopers[id]) {
      sceneMainLateLoopers[id].push(looper);
      return;
    } else if (id) {
      sceneMainLateLoopers[id] = [looper];
      return;
    }
  } else {
    if (id && sceneMainLoopers[id]) {
      sceneMainLoopers[id].push(looper);
      return;
    } else if (id) {
      sceneMainLoopers[id] = [looper];
      return;
    }
  }
  lwarn(`Could not find scene with id ${id} in addSceneMainLoopers.`);
};

/**
 * Removes a scene main looper by index
 * @param index (number | number[]) a number or array of numbers of the indexes to be removed from the main looper.
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 * @param isLateLooper (boolean) whether the looper is a scene main late looper or not (default is false).
 */
export const removeSceneMainLooper = (
  index: number | number[],
  sceneId?: string,
  isLateLooper?: boolean
) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) {
    if (isLateLooper) {
      if (!sceneMainLateLoopers[id]) return;
      if (typeof index === 'number') {
        sceneMainLateLoopers[id] = sceneMainLateLoopers[id].filter((_, i) => i !== index);
        return;
      } else {
        for (let i = 0; i < index.length; i++) {
          sceneMainLateLoopers[id] = sceneMainLateLoopers[id].filter((_, i) => i !== index[i]);
        }
        return;
      }
    } else {
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
  }
  lwarn(`Could not find scene with id ${id} in deleteSceneMainLoopers.`);
};

/**
 * Deletes all scene's main loopers
 * @param sceneId (string) scene id
 */
export const deleteSceneMainLoopers = (sceneId: string) => delete sceneMainLoopers[sceneId];

/**
 * Deletes all scene's main late loopers
 * @param sceneId (string) scene id
 */
export const deleteSceneMainLateLoopers = (sceneId: string) => delete sceneMainLateLoopers[sceneId];

/**
 * Returns all scene's app loopers
 * @param sceneId (string) scene id
 * @returns ({@link Looper}[])
 */
export const getSceneAppLoopers = (sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) return sceneAppLoopers[id] || [];
  lwarn(`Could not find scene with id ${id} in getSceneAppLoopers.`);
  return [];
};

/**
 * Adds a scene app looper
 * @param looper ({@link Looper}) the looper function to be executed
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const addSceneAppLooper = (looper: Looper, sceneId?: string) => {
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

/**
 * Removes a scene app looper by index
 * @param index (number | number[]) a number or array of numbers of the indexes to be removed from the app looper.
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const removeSceneAppLooper = (index: number | number[], sceneId?: string) => {
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

/**
 * Deletes all scene's app loopers
 * @param sceneId (string) scene id
 */
export const deleteSceneAppLoopers = (sceneId: string) => delete sceneAppLoopers[sceneId];

/**
 * Returns all scene's resizers
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 * @returns (array of functions) (() => void)[]
 */
export const getSceneResizers = (sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) return sceneResizers[id];
  lwarn(`Could not find scene with id ${id} in getSceneResizers.`);
};

/**
 * Adds a scene resizer
 * @param resizer (() => void) scene resizer function to be added
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const addSceneResizer = (resizer: () => void, sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id && sceneResizers[id]) {
    sceneResizers[id].push(resizer);
    return;
  } else if (id) {
    sceneResizers[id] = [resizer];
    return;
  }
  lwarn(`Could not find scene with id ${id} in addSceneResizer.`);
};

/**
 * Removes a scene resizers by index
 * @param index (number | number[]) a number or array of numbers of the indexes to be removed from the resizers.
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const removeSceneResizer = (index: number | number[], sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) {
    if (!sceneResizers[id]) return;
    if (typeof index === 'number') {
      sceneResizers[id] = sceneResizers[id].filter((_, i) => i !== index);
      return;
    } else {
      for (let i = 0; i < index.length; i++) {
        sceneResizers[id] = sceneResizers[id].filter((_, i) => i !== index[i]);
      }
      return;
    }
  }
  lwarn(`Could not find scene with id ${id} in deleteSceneResizer.`);
};

/** Deletes all scene's resizers depending on the sceneId
 * @param sceneId (string) scene id
 */
export const deleteSceneResizer = (sceneId: string) => delete sceneResizers[sceneId];

/**
 * Checks, with a scene id, whether a scene exists or not
 * @param id (string) scene id
 * @returns boolean
 */
export const doesSceneExist = (id: string) => Boolean(scenes[id]);

/**
 * Creates a root scene of the app. If it already exists, this does nothing.
 */
export const createRootScene = () => {
  if (rootScene) return;
  rootScene = new THREE.Scene();
};

/**
 * Returns the root scene of the app.
 * @returns THREE.Scene (rootScene)
 */
export const getRootScene = () => rootScene;
