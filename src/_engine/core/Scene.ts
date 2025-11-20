import * as THREE from 'three/webgpu';
import { deleteMesh } from './Mesh';
import { deleteGeometry } from './Geometry';
import { deleteMaterial } from './Material';
import { deleteGroup } from './Group';
import { lerror, lwarn } from '../utils/Logger';
import { deleteLight } from './Light';
import { deleteTexture } from './Texture';
import {
  deleteAllScenePhysicsLoopers,
  deletePhysicsObjectsBySceneId,
  deletePhysicsWorld,
  setCurrentScenePhysicsObjects,
} from './PhysicsRapier';
import { isDebugEnvironment } from './Config';
import {
  addSceneToDebugtools,
  getDebugToolsState,
  removeScenesFromSceneListing,
  setDebugEnvBallMaterial,
} from '../debug/DebugTools';
import { initMainLoop } from './MainLoop';
import { updateDebuggerSceneTitle } from '../debug/DebuggerGUI';

export type Looper = (delta: number) => void;

const scenes: { [id: string]: THREE.Group } = {};
const sceneOpts: { [id: string]: SceneOptions } = {};
let rootScene: THREE.Scene | null = null;
let currentScene: THREE.Group | null = null;
let currentSceneId: string | null = null;
let currentSceneOpts: SceneOptions | null = null;
const sceneMainLoopers: { [sceneId: string]: (Looper | null)[] } = {};
const sceneMainLateLoopers: { [sceneId: string]: (Looper | null)[] } = {};
const sceneAppLoopers: { [sceneId: string]: (Looper | null)[] } = {};
let curSceneAppLoopers: Looper[] = [];
let curSceneMainLoopers: Looper[] = [];
let curSceneMainLateLoopers: Looper[] = [];
const sceneResizers: { [sceneId: string]: (() => void)[] } = {};
const onSceneExit: { [sceneId: string]: () => void } = {};
const onSceneEnter: { [sceneId: string]: () => void } = {};

export type SceneOptions = {
  name?: string;
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
    if (opts?.isCurrentScene) setCurrentScene(id);
    return scenes[id];
  }

  const scene = new THREE.Group();

  if (opts) sceneOpts[id] = opts;
  scenes[id] = scene;
  scene.userData.id = id;

  addSceneToDebugtools(id);

  if (opts?.isCurrentScene || !currentSceneId) setCurrentScene(id);

  if (opts?.mainLoopers) sceneMainLoopers[id] = opts.mainLoopers;
  if (opts?.mainLateLoopers) sceneMainLateLoopers[id] = opts.mainLateLoopers;
  if (opts?.appLoopers) sceneAppLoopers[id] = opts.appLoopers;

  return scene;
};

/**
 * Returns a created scene (if it exists) based on the scene id
 * @param id (string) scene id
 * @param silent (boolean) optional flag to not warn if scene is not found
 * @param throwOnError (boolean) optional flag to throw if scene is not found
 * @returns THREE.Group | null
 */
export const getScene = (id: string, silent?: boolean, throwOnError?: boolean) => {
  const scene = scenes[id];
  if (!scene && !silent) {
    const msg = `Could not find scene with id "${id}", in getScene(id).`;
    if (throwOnError) {
      lerror(msg);
      throw new Error(msg);
    }
    lwarn(msg);
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
    deletePhysicsWorld?: boolean;
    deleteSavedScene?: boolean;
    deleteAll?: boolean;
  }
) => {
  const scene = scenes[id];
  if (!scene) {
    lwarn(`Could not find scene with id "${id}", in deleteScene(id).`);
    return;
  }

  const currentScene = getCurrentScene();
  if (currentScene?.userData.id === scene.userData.id && currentScene?.uuid === scene.uuid) {
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
  deleteAllSceneLoopers(id);

  // Delete skybox textures
  if (scene.userData.backgroundNodeTextureId) {
    deleteTexture(scene.userData.backgroundNodeTextureId);
    const rootScene = getRootScene();
    if (isCurrentScene(id) && rootScene) rootScene.backgroundNode = null;
  }

  // Delete physics
  deletePhysicsObjectsBySceneId(id);
  if (opts?.deletePhysicsWorld || opts?.deleteAll) {
    // Delete physics world
    deletePhysicsWorld();
  }

  if (opts?.deleteSavedScene) delete scenes[id];

  const debugToolsState = getDebugToolsState();
  if (debugToolsState.debugCamera[id]) {
    delete debugToolsState.debugCamera[id];
  }
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

  setDebugEnvBallMaterial();

  const rootScene = getRootScene() as THREE.Scene;

  deleteAllScenePhysicsLoopers();

  if (currentScene) rootScene.remove(currentScene);

  currentSceneId = id;
  currentScene = nextScene;
  currentSceneOpts = id && sceneOpts[id] ? sceneOpts[id] : null;

  if (nextScene) {
    rootScene.background = null;
    rootScene.backgroundNode = null;
    if (currentSceneOpts?.background) rootScene.background = currentSceneOpts.background;
    if (currentSceneOpts?.backgroundColor) rootScene.background = currentSceneOpts.backgroundColor;
    if (currentSceneOpts?.backgroundTexture)
      rootScene.background = currentSceneOpts.backgroundTexture;
    rootScene.add(nextScene);
  }

  setCurrentScenePhysicsObjects(id);

  updateDebuggerSceneTitle(
    currentSceneOpts?.name || id || nextScene?.userData.id || '[No scene..]'
  );

  if (rootScene.children.length) initMainLoop();

  return nextScene;
};

/**
 * Returns the current scene or null if not defined
 * @returns THREE.Group
 */
export const getCurrentScene = (throwOnError?: boolean) => {
  if (!currentScene && throwOnError) {
    const msg = 'The current scene is not defined in getCurrentScene.';
    lerror(msg);
    throw new Error(msg);
  }
  return currentScene || null;
};

/**
 * Return the current scene id
 * @returns string
 */
export const getCurrentSceneId = (throwOnError?: boolean) => {
  if (!currentSceneId && throwOnError) {
    const msg = 'The currentSceneId is not defined in getCurrentSceneId.';
    lerror(msg);
    throw new Error(msg);
  }
  return currentSceneId;
};

/**
 * Return all existing scenes as an object
 * @returns (object) { [sceneId: string]: THREE.Group }
 */
export const getAllScenes = () => scenes;

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
export const isCurrentScene = (id?: string) => id === currentSceneId;

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
 * Creates a scene main looper
 * @param looper ({@link Looper}) the looper function to be executed
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 * @param isLateLooper (boolean) whether the looper is a scene main late looper or not (default is false).
 */
export const createSceneMainLooper = (looper: Looper, sceneId?: string, isLateLooper?: boolean) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (isLateLooper) {
    if (id && sceneMainLateLoopers[id]) {
      sceneMainLateLoopers[id].push(looper);
      const index = sceneMainLateLoopers[id].length - 1;
      curSceneMainLateLoopers = sceneMainLateLoopers[id].filter(Boolean) as Looper[];
      return index;
    } else if (id) {
      sceneMainLateLoopers[id] = [looper];
      const index = sceneMainLateLoopers[id].length - 1;
      curSceneMainLateLoopers = sceneMainLateLoopers[id].filter(Boolean) as Looper[];
      return index;
    }
  } else {
    if (id && sceneMainLoopers[id]) {
      sceneMainLoopers[id].push(looper);
      const index = sceneMainLoopers[id].length - 1;
      curSceneMainLoopers = sceneMainLoopers[id].filter(Boolean) as Looper[];
      return index;
    } else if (id) {
      sceneMainLoopers[id] = [looper];
      const index = sceneMainLoopers[id].length - 1;
      curSceneMainLoopers = sceneMainLoopers[id].filter(Boolean) as Looper[];
      return index;
    }
  }
  lwarn(`Could not find scene with id ${id} in createSceneMainLoopers.`);
  return -1;
};

/**
 * Deletes a scene main looper by index
 * @param index (number | number[]) a number or array of numbers of the indexes to be removed from the main looper.
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 * @param isLateLooper (boolean) whether the looper is a scene main late looper or not (default is false).
 */
export const deleteSceneMainLooper = (
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
        sceneMainLateLoopers[id][index] = null;
        curSceneMainLateLoopers = sceneMainLateLoopers[id].filter(Boolean) as Looper[];
        return;
      } else {
        for (let i = 0; i < index.length; i++) {
          sceneMainLateLoopers[id][index[i]] = null;
        }
        curSceneMainLateLoopers = sceneMainLateLoopers[id].filter(Boolean) as Looper[];
        return;
      }
    } else {
      if (!sceneMainLoopers[id]) return;
      if (typeof index === 'number') {
        sceneMainLoopers[id][index] = null;
        curSceneMainLoopers = sceneMainLoopers[id].filter(Boolean) as Looper[];
        return;
      } else {
        for (let i = 0; i < index.length; i++) {
          sceneMainLoopers[id][index[i]] = null;
        }
        curSceneMainLoopers = sceneMainLoopers[id].filter(Boolean) as Looper[];
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
export const deleteSceneMainLoopers = (sceneId: string) => {
  sceneMainLoopers[sceneId] = [];
  if (sceneId === currentSceneId) curSceneMainLoopers = [];
};

/**
 * Deletes all scene's main late loopers
 * @param sceneId (string) scene id
 */
export const deleteSceneMainLateLoopers = (sceneId: string) => {
  sceneMainLateLoopers[sceneId] = [];
  if (sceneId === currentSceneId) curSceneMainLateLoopers = [];
};

/**
 * Deletes all scene's main loopers, main late loopers, and app loopers
 * @param sceneId (string) scene id
 */
export const deleteAllSceneLoopers = (sceneId: string) => {
  deleteSceneMainLoopers(sceneId);
  deleteSceneMainLateLoopers(sceneId);
  deleteSceneAppLoopers(sceneId);
};

export const runSceneMainLoopers = (delta: number, skipFrame: boolean) => {
  if (skipFrame) return;
  for (let i = 0; i < curSceneMainLoopers.length; i++) {
    curSceneMainLoopers[i](delta);
  }
};

export const runSceneMainLateLoopers = (delta: number) => {
  for (let i = 0; i < curSceneMainLateLoopers.length; i++) {
    curSceneMainLateLoopers[i](delta);
  }
};

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
 * Creates a scene app looper
 * @param looper ({@link Looper}) the looper function to be executed
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const createSceneAppLooper = (looper: Looper, sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id && sceneAppLoopers[id]) {
    sceneAppLoopers[id].push(looper);
    const index = sceneAppLoopers[id].length - 1;
    curSceneAppLoopers = sceneAppLoopers[id].filter(Boolean) as Looper[];
    return index;
  } else if (id) {
    sceneAppLoopers[id] = [looper];
    const index = sceneAppLoopers[id].length - 1;
    curSceneAppLoopers = sceneAppLoopers[id].filter(Boolean) as Looper[];
    return index;
  }
  lwarn(`Could not find scene with id ${id} in createSceneAppLoopers.`);
  return -1;
};

/**
 * Deletes a scene app looper by index
 * @param index (number | number[]) a number or array of numbers of the indexes to be removed from the app looper.
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const deleteSceneAppLooper = (index: number | number[], sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id) {
    if (!sceneAppLoopers[id]) return;
    if (typeof index === 'number') {
      sceneAppLoopers[id][index] = null;
      if (!sceneId || sceneId === currentSceneId) {
        curSceneAppLoopers = sceneAppLoopers[id].filter(Boolean) as Looper[];
      }
      return;
    } else {
      for (let i = 0; i < index.length; i++) {
        sceneAppLoopers[id][index[i]] = null;
      }
      if (!sceneId || sceneId === currentSceneId) {
        curSceneAppLoopers = sceneAppLoopers[id].filter(Boolean) as Looper[];
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
export const deleteSceneAppLoopers = (sceneId: string) => {
  sceneAppLoopers[sceneId] = [];
  if (sceneId === currentSceneId) curSceneAppLoopers = [];
};

export const runSceneAppLoopers = (delta: number) => {
  for (let i = 0; i < curSceneAppLoopers.length; i++) {
    curSceneAppLoopers[i](delta);
  }
};

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
 * Creates a scene resizer
 * @param resizer (() => void) scene resizer function to be added
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const createSceneResizer = (resizer: () => void, sceneId?: string) => {
  let id = currentSceneId;
  if (sceneId) id = sceneId;
  if (id && sceneResizers[id]) {
    sceneResizers[id].push(resizer);
    return;
  } else if (id) {
    sceneResizers[id] = [resizer];
    return;
  }
  lwarn(`Could not find scene with id ${id} in createSceneResizer.`);
};

/**
 * Deletes a scene resizers by index
 * @param index (number | number[]) a number or array of numbers of the indexes to be removed from the resizers.
 * @param sceneId (string) optional scene id. If no scene id is provided then the current scene is selected.
 */
export const deleteSceneResizer = (index: number | number[], sceneId?: string) => {
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
export const deleteSceneResizers = (sceneId: string) => delete sceneResizers[sceneId];

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

export const registerOnSceneEnter = (sceneId: string, fn: () => void) =>
  (onSceneEnter[sceneId] = fn);

export const registerOnSceneExit = (sceneId: string, fn: () => void) => (onSceneExit[sceneId] = fn);

// @CONSIDER: maybe add general 'registerOnAllSceneEnterings' and 'registerOnAllSceneExits' that run on all scene enterings / exits (not just specific ones)

export const runOnSceneEnter = (sceneId: string) => {
  if (onSceneEnter[sceneId]) onSceneEnter[sceneId]();
};

export const runOnSceneExit = (sceneId?: string) => {
  if (sceneId && onSceneExit[sceneId]) onSceneExit[sceneId]();
};
