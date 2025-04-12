import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../utils/Logger';
import { deleteScene, getCurrentScene } from './Scene';
import { getCmpById, TCMP } from '../utils/CMP';
import { getHUDRootCMP } from './HUD';

export type UpdateLoaderStatusFn = (
  loader: SceneLoader,
  params?: { [key: string]: unknown }
) => Promise<boolean>;

export type SceneLoader = {
  /**
   * Scene Loader ID
   */
  id: string;

  /**
   * Next scene loader function, returns true when loading is done.
   * @param loader SceneLoader ({@link SceneLoader})
   * @param updateLoaderStatusFn UpdateLoaderStatusFn ({@link UpdateLoaderStatusFn})
   * @returns Promise<boolean>
   */
  loadFn: (loader: SceneLoader, nextSceneFn: () => Promise<unknown>) => Promise<unknown>;

  /**
   * Load start function, returns true when done
   * @param loader SceneLoader ({@link SceneLoader})
   * @param updateLoaderStatusFn UpdateLoaderStatusFn ({@link UpdateLoaderStatusFn})
   * @returns Promise<boolean>
   */
  loadStartFn?: (
    loader: SceneLoader,
    updateLoaderStatusFn?: UpdateLoaderStatusFn
  ) => Promise<boolean>;

  /**
   * Load end function, returns true when done
   * @param loader SceneLoader ({@link SceneLoader})
   * @param updateLoaderStatusFn UpdateLoaderStatusFn ({@link UpdateLoaderStatusFn})
   * @returns Promise<boolean>
   */
  loadEndFn?: (
    loader: SceneLoader,
    updateLoaderStatusFn?: UpdateLoaderStatusFn
  ) => Promise<boolean>;

  /**
   * Update loader status function, returns true when loading is done. {@link UpdateLoaderStatusFn}
   */
  updateLoaderStatusFn?: UpdateLoaderStatusFn;

  /**
   * The optional three.js group to be used in the loader
   */
  loaderGroup?: THREE.Group;

  /**
   * The optional HTML overlay component of the loader view that is attached to the
   */
  loaderContainer?: TCMP;

  /**
   * Loading phase (no loading phase = undefined)
   */
  phase?: 'START' | 'LOAD' | 'END';
};

type LoadSceneProps = {
  nextSceneFn: () => Promise<unknown>;
  updateLoaderStatusFn?: UpdateLoaderStatusFn;
  loaderId?: string; // loaderId to use, if not provided then the currentSceneLoader will be used
  deletePrevScene?: boolean;
  // @TODO: add possibility to disable inputControls for prevScene while loading
  // @TODO: add possibility to add nextSceneCamera (maybe)
};

const sceneLoaders: SceneLoader[] = [];
let currentSceneLoader: SceneLoader | null = null;
let currentSceneLoaderId: string | null = null;

export const createSceneLoader = async (
  sceneLoader: Omit<SceneLoader, 'phase'>,
  isCurrent?: boolean // default is true
  // createLoaderFn?: (sceneLoader: SceneLoader) => Promise<void>
) => {
  const foundSameId = sceneLoaders.find((sl) => sl.id);
  if (foundSameId) {
    const msg = `Could not add scene loader because the scene loader has already been created (loader id: ${sceneLoader.id}).`;
    lwarn(msg);
    return;
  }

  sceneLoaders.push(sceneLoader);

  // default value is true (even if undefined)
  if (isCurrent !== false) {
    setCurrentSceneLoader(sceneLoader.id);
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

const loadSceneCleanup = (loader: SceneLoader, loaderContainerId: string | null) => {
  if (loaderContainerId) {
    const loaderContainer = getCmpById(loaderContainerId);
    if (loaderContainer) loaderContainer.remove();
  }

  const newScene = getCurrentScene();
  if (loader.loaderGroup && newScene) {
    // Remove loader group from the new scene
    const groupUUID = loader.loaderGroup.uuid;
    for (let i = 0; i < newScene.children.length; i++) {
      const child = newScene.children[i];
      if (child.uuid === groupUUID) {
        child.removeFromParent();
        break;
      }
    }
  }

  loader.phase = undefined;
};

const loadSceneEndPhase = async (
  loadSceneProps: LoadSceneProps,
  loader: SceneLoader,
  loaderContainerId: string | null
) => {
  loader.phase = 'END';
  if (loader.loadEndFn) {
    await loader
      .loadEndFn(loader, loadSceneProps.updateLoaderStatusFn)
      .then(() => loadSceneCleanup(loader, loaderContainerId));
    return;
  }

  loadSceneCleanup(loader, loaderContainerId);
};

const loadSceneLoadPhase = async (
  loadSceneProps: LoadSceneProps,
  loader: SceneLoader,
  prevScene: THREE.Scene,
  loaderContainerId: string | null
) => {
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
    // Delete the whole previous scene and assets
    // @CONSIDER: maybe add more sophisticated prev scene delete params to the loadSceneProps (like deleteMeshes, deleteTextures, etc.)
    deleteScene(prevScene.userData.id, { deleteAll: true });
  }

  loader.phase = 'LOAD';
  await loader
    .loadFn(loader, loadSceneProps.nextSceneFn)
    .then(() => loadSceneEndPhase(loadSceneProps, loader, loaderContainerId));
};

export const loadScene = async (loadSceneProps: LoadSceneProps) => {
  let loader: SceneLoader | undefined = getCurrentSceneLoader();
  if (loadSceneProps.loaderId) {
    loader = sceneLoaders.find((sl) => sl.id === loadSceneProps.loaderId);
    if (!loader) {
      const msg = `Could not find scene loader with loader id "${loadSceneProps.loaderId}" in loadScene. Next scene was not loaded.`;
      lerror(msg);
      throw new Error(msg);
    }
  }

  // Add possible CMP container to HUD
  let loaderContainerId: string | null = null;
  console.log('TADAA', loader);
  if (loader.loaderContainer) {
    loaderContainerId = loader.loaderContainer.id;
    getHUDRootCMP().add(loader.loaderContainer);
  }

  const prevScene = getCurrentScene();
  // Add possible loader group to current scene
  if (loader.loaderGroup) prevScene.add(loader.loaderGroup);

  // Add a listener loop to continue with main loop (awoid await).
  // Listen to the phase changes. Add checks to the main loop.
  loader.phase = 'START';

  if (prevScene && loader.loadStartFn) {
    // Run loadStartFn if prevScene found
    await loader
      .loadStartFn(loader)
      .then(() => loadSceneLoadPhase(loadSceneProps, loader, prevScene, loaderContainerId));
    return;
  }

  await loadSceneLoadPhase(loadSceneProps, loader, prevScene, loaderContainerId);
};

/**
 * Returns a updateLoaderStatusFn wrapper. If the loaderId is not provided, the current sceneloader's updateLoaderStatusFn is returned.
 * @param loaderId SceneLoader id (optional)
 * @returns (params?: { [key: string]: unknown }) => SceneLoader.updateLoaderStatusFn(sceneLoader, params) ({@link UpdateLoaderStatusFn})
 */
export const getLoaderStatusUpdater = (loaderId?: string) => {
  let updateLoaderStatusFn: UpdateLoaderStatusFn | undefined = undefined;
  let loader: SceneLoader;

  if (!loaderId) {
    if (!currentSceneLoader) {
      const msg =
        'Could not find current scene loader. Create the loader first (createSceneLoader) before trying to get the loader status updater.';
      lerror(msg);
      throw new Error(msg);
    }

    updateLoaderStatusFn = currentSceneLoader.updateLoaderStatusFn;
    loader = currentSceneLoader;
  } else {
    const sceneLoader = sceneLoaders.find((loader) => loader.id === loaderId);
    if (!sceneLoader) {
      const msg = `Could not find a scene loader with id '${loaderId}'. Create the loader first (createSceneLoader) before trying to get the loader status updater.`;
      lerror(msg);
      throw new Error(msg);
    }

    updateLoaderStatusFn = sceneLoader.updateLoaderStatusFn;
    loader = sceneLoader;
  }

  if (!updateLoaderStatusFn) {
    const msg =
      'The scene loader does not have an updateLoaderStatusFn. Provide it when creating the scene loader (in createSceneLoader).';
    lerror(msg);
    throw new Error(msg);
  }

  return (params?: { [key: string]: unknown }) => updateLoaderStatusFn(loader, params);
};
