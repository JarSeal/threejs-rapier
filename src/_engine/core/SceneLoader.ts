// import { lsGetItem } from '../utils/LocalAndSessionStorage';
// import { isDebugEnvironment } from './Config';

import * as THREE from 'three/webgpu';
import { lwarn } from '../utils/Logger';
import { deleteScene, getCurrentScene, getScene, setCurrentScene } from './Scene';
import { TCMP } from '../utils/CMP';
import { getHUDRootCMP } from './HUD';

// export type SceneLoaderParams = {
//   loaderId: string;
//   scenes: {
//     [id: string]: {
//       assets: string[] | { [id: string]: { type: '' } };
//       sceneFn: () => void;
//     };
//   };
//   currentSceneId: string;
// };

// const LS_KEY_PREFIX = 'sceneLoaderParams';

// export class SceneLoader {
//   loaderId: string;
//   scenes: SceneLoaderParams['scenes'];
//   currentSceneId: string;

//   constructor(initParams: SceneLoaderParams) {
//     let params = initParams;
//     this.scenes = params.scenes;
//     this.loaderId = params.loaderId;

//     // Get current scene to load
//     if (isDebugEnvironment()) {
//       const savedParams = lsGetItem(`${LS_KEY_PREFIX}-${this.loaderId}`, params);
//       params = { ...params, ...savedParams };
//       this.currentSceneId = params.currentSceneId;
//     } else {
//       this.currentSceneId = params.currentSceneId;
//     }
//   }
// }

// const loadedScenes: {
//   [loaderId: string]: {
//     [sceneId: string]: {
//       assets: {
//         id?: string;
//         type: 'texture' | 'equiRectTexture' | 'model';
//         url: string | string[];
//       }[];
//       sceneFn: () => boolean | void;
//       loaderFn: {};
//       loadOnLoaderInit?: boolean;
//     };
//   };
// } = {};

// export const loadScene = async ({
//   loaderId,
//   currentScene,
// }: {
//   loaderId: string;
//   currentScene: string;
// }) => {
//   let loaderData = loadedScenes[loaderId];
//   if (!loaderData) {
//     // Need to initialize the loader
//   }
//   const sceneData = loadedScenes[loaderId][currentScene];
//   if (sceneData) {
//     sceneData.sceneFn();
//   }
// };

export type UpdateLoaderStatusFn = () => Promise<boolean>;

export type SceneLoader = {
  id: string;
  loaderGroup?: THREE.Group;
  loaderContainer?: TCMP;
  loadFn: (loader: SceneLoader, updateLoaderStatusFn?: UpdateLoaderStatusFn) => Promise<boolean>;
  loadStartFn?: (loader: SceneLoader) => Promise<void>;
  loadEndFn?: (loader: SceneLoader) => Promise<void>;
  phase?: 'START' | 'LOAD' | 'END';
};

const sceneLoaders: SceneLoader[] = [];
let currentSceneLoader: SceneLoader | null = null;
let currentSceneLoaderId: string | null = null;

export const createSceneLoader = async (
  sceneLoader: SceneLoader,
  createLoaderFn?: (sceneLoader: SceneLoader) => Promise<void>,
  isNotCurrent?: boolean
) => {
  const foundSameId = sceneLoaders.find((sl) => sl.id);
  if (foundSameId) {
    const msg = `Could not add scene loader because the scene loader has already been created (loader id: ${sceneLoader.id}).`;
    lwarn(msg);
    return;
  }

  if (createLoaderFn) await createLoaderFn(sceneLoader);

  sceneLoaders.push(sceneLoader);

  if (!isNotCurrent) {
    currentSceneLoader;
  }
};

// @TODO
// export const deleteSceneLoader = (id: string) => {};

export const setCurrentSceneLoader = (id: string) => {
  const foundLoader = sceneLoaders.find((sl) => sl.id);
  if (!foundLoader) {
    const msg = `Could not set current scene loader with loader id "${id}", because the loader was not found.`;
    lwarn(msg);
    return;
  }

  currentSceneLoader = foundLoader;
  currentSceneLoaderId = foundLoader.id;
};

export const getCurrentSceneLoader = () => {
  if (!currentSceneLoader) {
    const msg =
      'Could not find current scene loader, create a loader first before trying to access the current loader.';
    throw new Error(msg);
  }

  return currentSceneLoader;
};

export const getCurrentSceneLoaderId = () => {
  if (!currentSceneLoaderId) {
    const msg =
      'Could not find current scene loader id, create a loader first before trying to access the current loader id.';
    throw new Error(msg);
  }

  return currentSceneLoaderId;
};

export const loadScene = async (loadSceneProps: {
  nextSceneId: string;
  updateLoaderStatusFn?: UpdateLoaderStatusFn;
  loaderId?: string;
  deletePrevScene?: boolean;
}) => {
  let loader: SceneLoader | undefined = getCurrentSceneLoader();
  if (loadSceneProps.loaderId) {
    loader = sceneLoaders.find((sl) => sl.id === loadSceneProps.loaderId);
    if (!loader) {
      const msg = `Could not find scene loader with loader id "${loadSceneProps.loaderId}" in loadScene. Next scene was not loaded.`;
      lwarn(msg);
      return;
    }
  }

  let prevScene = getCurrentScene();
  if (prevScene) {
    // Add possible loader group to current scene
    if (loader.loaderGroup) prevScene.add(loader.loaderGroup);
  } else if (loader.loaderGroup) {
    // @TODO: create temp scene
  }
  // Add possible CMP container to HUD
  if (loader.loaderContainer) getHUDRootCMP().add(loader.loaderContainer);

  const nextScene = getScene(loadSceneProps.nextSceneId);
  if (!nextScene) {
    const msg = `Could not find next scene next scene id "${loadSceneProps.nextSceneId}" in loadScene. Next scene was not loaded.`;
    lwarn(msg);
    return;
  }

  loader.phase = 'START';
  if (loader.loadStartFn) await loader.loadStartFn(loader);

  // Add loader group to next scene
  if (loader.loaderGroup) nextScene.add(loader.loaderGroup);

  loader.phase = 'LOAD';
  setCurrentScene(loadSceneProps.nextSceneId);
  if (loader.loaderGroup) {
    // Remove loader group from prev scene
    const groupUUID = loader.loaderGroup.uuid;
    for (let i = 0; i < prevScene.children.length; i++) {
      const child = prevScene.children[i];
      if (child.uuid === groupUUID) {
        child.removeFromParent();
        break;
      }
    }
  }
  if (prevScene && loadSceneProps.deletePrevScene) {
    deleteScene(prevScene.userData.id, { deleteAll: true });
  }

  await loader.loadFn(loader, loadSceneProps.updateLoaderStatusFn);

  loader.phase = 'END';
  if (loader.loadEndFn) await loader.loadEndFn(loader);

  if (loader.loaderGroup) {
    // Remove loader group from prev scene
    const groupUUID = loader.loaderGroup.uuid;
    for (let i = 0; i < nextScene.children.length; i++) {
      const child = nextScene.children[i];
      if (child.uuid === groupUUID) {
        child.removeFromParent();
        break;
      }
    }
  }

  loader.phase = undefined;
};
