import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../utils/Logger';
import {
  deleteAllSceneLoopers,
  deleteScene,
  getCurrentScene,
  getRootScene,
  getScene,
  runOnSceneEnter,
  runOnSceneExit,
  setCurrentScene,
} from './Scene';
import { TCMP } from '../utils/CMP';
import { getHUDRootCMP } from './HUD';
import { deleteAllPhysicsObjects } from './PhysicsRapier';
import { disableDebugger } from '../debug/DebuggerGUI';
import { setAllInputsEnabled } from './InputControls';
import { getCanvasParentElem } from './Renderer';
import { DEBUG_CAMERA_ID, getDebugToolsState, setDebugToolsVisibility } from '../debug/DebugTools';
import { isDebugEnvironment } from './Config';
import { clearSkyBox } from './SkyBox';
import { debuggerSceneListing } from '../debug/debugScenes/debuggerSceneListing';
import { handleDraggableWindowsOnSceneChangeStart } from './UI/DraggableWindow';
import { updateOnScreenTools } from '../debug/OnScreenTools';
import { deleteAllInSceneLights, updateLightsDebuggerGUI } from './Light';
import {
  deleteAllInSceneCameras,
  deleteOnCameraSetsAndUnsets,
  setCurrentCamera,
  updateCamerasDebuggerGUI,
} from './Camera';
import { deleteAllCharacters } from './Character';
import { existsOrThrow } from '../utils/helpers';
import { deregisterAllLightAndCameraHelpers } from './Helpers';

export type UpdateLoaderStatusFn = (
  loader: SceneLoader,
  params?: { [key: string]: unknown }
) => void;

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
  loadFn?: (loader: SceneLoader, nextSceneFn: () => Promise<string>) => Promise<string>;

  /**
   * Load start function, returns true when done
   * @param loader SceneLoader ({@link SceneLoader})
   * @param updateLoaderStatusFn UpdateLoaderStatusFn ({@link UpdateLoaderStatusFn})
   * @returns Promise<boolean>
   */
  loadStartFn?: (loader: SceneLoader) => Promise<boolean>;

  /**
   * Load end function, returns true when done
   * @param loader SceneLoader ({@link SceneLoader})
   * @param updateLoaderStatusFn UpdateLoaderStatusFn ({@link UpdateLoaderStatusFn})
   * @returns Promise<boolean>
   */
  loadEndFn?: (loader: SceneLoader) => Promise<boolean>;

  /**
   * Update loader status function, returns true when loading is done. {@link UpdateLoaderStatusFn}
   */
  updateLoaderStatusFn?: UpdateLoaderStatusFn;

  /**
   * The optional three.js group to be used in the loader
   */
  loaderGroup?: THREE.Group;

  /**
   * The optional function to create a loader container
   * @returns function (() => TCMP)
   */
  loaderContainerFn?: () => TCMP;

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
  nextSceneFn: () => Promise<string>;
  updateLoaderStatusFn?: UpdateLoaderStatusFn;
  loaderId?: string; // loaderId to use, if not provided then the currentSceneLoader will be used
  deletePrevScene?: boolean;
  // @TODO: add possibility to disable inputControls for prevScene while loading
  // @TODO: add possibility to add nextSceneCamera (maybe)
};

const sceneLoaders: SceneLoader[] = [];
let currentSceneLoader: SceneLoader | null = null;
let currentSceneLoaderId: string | null = null;
let currentlyLoading = false;
let firstSceneLoaded = false;

export const createSceneLoader = async (
  sceneLoader: Omit<SceneLoader, 'phase' | 'loaderContainer'>,
  isCurrent?: boolean // default is true
  // createLoaderFn?: (sceneLoader: SceneLoader) => Promise<void>
) => {
  const foundSameId = sceneLoaders.find((sl) => sl.id === sceneLoader.id);
  if (foundSameId) {
    const msg = `Could not add scene loader because the scene loader has already been created (loader id: ${sceneLoader.id}).`;
    lwarn(msg);
    return;
  }

  sceneLoaders.push(sceneLoader);

  // default value of isCurrent is true (even if undefined)
  if (isCurrent !== false) {
    setCurrentSceneLoader(sceneLoader.id);
  }
};

// @TODO: delete a scene loader (deleteSceneLoader)
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

/**
 * Loads a scene with a scene loader
 * @param loadSceneProps (object) {@link LoadSceneProps}
 */
export const loadScene = async (loadSceneProps: LoadSceneProps) => {
  currentlyLoading = true;
  let loader: SceneLoader | undefined = getCurrentSceneLoader();
  let initNextSceneFn: () => Promise<string> = loadSceneProps.nextSceneFn;

  if (loadSceneProps.loaderId) {
    loader = sceneLoaders.find((sl) => sl.id === loadSceneProps.loaderId);
    if (!loader) {
      const msg = `Could not find scene loader with loader id "${loadSceneProps.loaderId}" in loadScene. Next scene was not loaded.`;
      lerror(msg);
      throw new Error(msg);
    }
  }

  // Debug start scene check
  const debugToolsState =
    isDebugEnvironment() && !firstSceneLoaded ? getDebugToolsState(true) : null;
  if (debugToolsState?.scenesListing.useDebugStartScene) {
    if (debugToolsState.scenesListing.useDebuggerSceneLoader) {
      // @TODO: Use debugger sceneLoader
    }

    if (debugToolsState?.scenesListing.debugStartScene) {
      const debugScene = debuggerSceneListing.find(
        (scene) => scene.id === debugToolsState.scenesListing.debugStartScene
      );
      if (debugScene) initNextSceneFn = debugScene.fn;
    }
  }

  let loadStartFn = loader.loadStartFn;
  if (!loadStartFn) {
    loadStartFn = async () => new Promise((resolve) => resolve(true));
  }
  let loadFn = loader.loadFn;
  if (!loadFn) {
    loadFn = async (_loader, nextSceneFn) => await nextSceneFn();
  }
  let loadEndFn = loader.loadEndFn;
  if (!loadEndFn) {
    loadEndFn = async () => new Promise((resolve) => resolve(true));
  }

  // Add possible CMP container to HUD
  let loaderContainer: TCMP | null = null;
  if (loader.loaderContainerFn) {
    loaderContainer = loader.loaderContainerFn();
    loader.loaderContainer = loaderContainer;
    getHUDRootCMP().add(loaderContainer);
  }

  const prevScene = getCurrentScene();
  const prevSceneId = prevScene?.userData.id;
  const rootScene = getRootScene() as THREE.Scene;
  // Add possible loader group to current scene
  if (loader.loaderGroup) rootScene.add(loader.loaderGroup);

  // Disable debuggers and input controls
  disableDebugger(true);
  setAllInputsEnabled(false);
  const canvasParentElem = getCanvasParentElem();
  canvasParentElem?.style.setProperty('pointer-events', 'none');

  // Delete prev scene characters, physics objects, in scene cameras, and in scene lights
  deleteAllCharacters();
  deleteAllPhysicsObjects();
  deleteAllInSceneCameras();
  deleteAllInSceneLights();
  if (isDebugEnvironment()) {
    deregisterAllLightAndCameraHelpers();
  }

  loader.phase = 'START';
  await loadStartFn(loader)
    .then(async () => {
      if (loadSceneProps.deletePrevScene && prevScene) {
        // Delete the whole previous scene and assets
        // @CONSIDER: maybe add more sophisticated prev scene delete params to the loadSceneProps (like deleteMeshes, deleteTextures, etc.)
        deleteScene(prevSceneId, { deleteAll: true });
      } else if (prevScene) {
        deleteAllSceneLoopers(prevSceneId);
      }

      clearSkyBox();
      handleDraggableWindowsOnSceneChangeStart();

      runOnSceneExit(prevSceneId);
      deleteOnCameraSetsAndUnsets();

      loader.phase = 'LOAD';
      await loadFn(loader, initNextSceneFn).then(async (newSceneId) => {
        // Scene has been loaded and initialized
        existsOrThrow(
          getScene(newSceneId),
          `Scene loader could not find scene with scene id '${newSceneId}'.`
        );
        setCurrentScene(newSceneId);

        const canvasParentElem = getCanvasParentElem();
        canvasParentElem?.style.setProperty('pointer-events', '');

        if (isDebugEnvironment()) {
          // Enable debuggers and input controls
          disableDebugger(false);
          setAllInputsEnabled(true);
          const debugCamEnabled = Boolean(
            getDebugToolsState(true).debugCamera[newSceneId]?.enabled
          );
          setDebugToolsVisibility(debugCamEnabled, true);
          updateCamerasDebuggerGUI();
          updateLightsDebuggerGUI();

          // Set possible debug camera
          if (debugCamEnabled) setCurrentCamera(DEBUG_CAMERA_ID);

          updateOnScreenTools();
        }

        firstSceneLoaded = true;

        runOnSceneEnter(newSceneId);

        loader.phase = 'END';
        await loadEndFn(loader).then(() => {
          if (loaderContainer) loaderContainer.remove();
          if (loader.loaderGroup) rootScene.remove(loader.loaderGroup);

          loader.phase = undefined;
          currentlyLoading = false;
        });
      });
    })
    .catch((reason) => {
      const msg = `Could not load scene (phase '${loader.phase}')`;
      lerror(msg, reason);
      // @CONSIDER: should this throw an error?
    });
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

export const isCurrentlyLoading = () => currentlyLoading;

export const hasFirstSceneBeenLoaded = () => firstSceneLoaded;
