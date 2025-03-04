// import { lsGetItem } from '../utils/LocalAndSessionStorage';
// import { isDebugEnvironment } from './Config';

import * as THREE from 'three/webgpu';
import { lwarn } from '../utils/Logger';
import { deleteScene, getCurrentScene, getScene, setCurrentScene } from './Scene';
import { getCmpById, TCMP } from '../utils/CMP';
import { getHUDRootCMP } from './HUD';

export type UpdateLoaderStatusFn = (loader: SceneLoader) => Promise<boolean>;

export type SceneLoader = {
  id: string;
  loaderGroup?: THREE.Group;
  loaderContainer?: TCMP;
  loadFn: (loader: SceneLoader, updateLoaderStatusFn?: UpdateLoaderStatusFn) => Promise<boolean>;
  loadStartFn?: (loader: SceneLoader, updateLoaderStatusFn?: UpdateLoaderStatusFn) => Promise<void>;
  loadEndFn?: (loader: SceneLoader, updateLoaderStatusFn?: UpdateLoaderStatusFn) => Promise<void>;
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
  loaderId?: string; // loaderId to use, if not provided then the currentSceneLoader will be used
  deletePrevScene?: boolean;
  // @TODO: add possibility to disable inputControls for prevScene while loading
  // @TODO: add possibility to add nextSceneCamera (maybe)
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

  // Add possible CMP container to HUD
  let loaderContainerId: string | null = null;
  if (loader.loaderContainer) {
    loaderContainerId = loader.loaderContainer.id;
    getHUDRootCMP().add(loader.loaderContainer);
  }

  const prevScene = getCurrentScene();
  if (prevScene) {
    // Add possible loader group to current scene
    if (loader.loaderGroup) prevScene.add(loader.loaderGroup);
  }

  const nextScene = getScene(loadSceneProps.nextSceneId);
  if (!nextScene) {
    const msg = `Could not find next scene next scene id "${loadSceneProps.nextSceneId}" in loadScene. Next scene was not loaded.`;
    lwarn(msg);
    return;
  }

  if (prevScene) {
    // Run loadStartFn if prevScene found
    loader.phase = 'START';
    if (loader.loadStartFn) await loader.loadStartFn(loader);
  }

  // Add loader group to next scene
  if (loader.loaderGroup) nextScene.add(loader.loaderGroup);

  if (prevScene && loader.loaderGroup) {
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

  loader.phase = 'LOAD';
  setCurrentScene(loadSceneProps.nextSceneId);
  await loader.loadFn(loader, loadSceneProps.updateLoaderStatusFn);

  if (loader.loadEndFn) {
    loader.phase = 'END';
    await loader.loadEndFn(loader, loadSceneProps.updateLoaderStatusFn);
  }

  if (loaderContainerId) {
    const loaderContainer = getCmpById(loaderContainerId);
    if (loaderContainer) loaderContainer.remove();
  }

  if (loader.loaderGroup) {
    // Remove loader group from next scene
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
