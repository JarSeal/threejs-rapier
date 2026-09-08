import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../utils/Logger';
import {
  deleteAllSceneLoopers,
  deleteScene,
  getCurrentScene,
  getGeneratedSceneData,
  getRootScene,
  getScene,
  getSceneOpts,
  runOnAllSceneEnters,
  runOnAllSceneExits,
  runOnSceneEnter,
  runOnSceneExit,
  SceneData,
  setCurrentScene,
} from './Scene';
import { TCMP } from '../utils/CMP';
import { getHUDRootCMP } from './HUD';
import { deleteAllPhysicsObjects } from './PhysicsRapier';
import { DEBUGGER_SCENE_LOADER_ID, disableDebugger } from '../debug/DebuggerGUI';
import { setAllInputsEnabled } from './InputControls';
import { getCanvasParentElem } from './Renderer';
import { getDebugToolsState } from '../debug/DebugToolsManager';
import { IS_DEBUG_ENV, isDebugEnvironment } from './Config';
import { applySkyBoxForScene, clearSkyBox } from './SkyBox';
import { handleDraggableWindowsOnSceneChangeStart } from './UI/DraggableWindow';
import { updateOnScreenTools } from '../debug/OnScreenTools';
import { deleteAllCharacters } from './Character';
import { existsOrThrow } from '../utils/assert';
import { deleteAllRayHelpers, resetRayCastStats } from './Raycast';
import { deleteAllGroups } from './Group';
import { setIsLoadingScene } from './MainLoop';
import { getECSWorld, getEntityIdByAppId } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import { sceneFileObjects } from '../generatedAppFns';
import { getTexture, loadTextureAsync } from './Texture';
import { createMaterial, getMaterial } from './Material';
import { textureMapKeys } from '../utils/constants';
import { createGeometry, getGeometry } from './_Geometry';
import { createLightEntity } from './_LightManager';
import { createCameraEntity, setActiveCamera } from './_CameraManager';
import { createMeshEntity } from './_MeshManager';
import { importModelAsync, type ImportReturnObj } from './_ImportModel';

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
  loadFn?: (
    loader: SceneLoader,
    nextSceneFn: (sceneData: SceneData) => Promise<void>
  ) => Promise<void>;

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
  sceneId: string;
  nextSceneFn?: ({
    sceneData,
    assets,
  }: {
    sceneData: SceneData;
    assets: ScenePrimitiveAssets;
  }) => Promise<void>;
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
let nextSceneId: string | null = null;

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
  const foundLoader = sceneLoaders.find((sl) => sl.id === id);
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

export const createCameras = (sceneData: SceneData) => {
  const cameraProps = sceneData.cameras || [];
  let firstCamId;
  let activeCamFound = false;
  let oneCameraCreated = false;
  if (!cameraProps?.length) {
    const msg = 'Could not find any cameras for the scene in createCameras (SceneLoader).';
    lerror(msg);
    throw new Error(msg);
  }
  for (let i = 0; i < cameraProps.length; i++) {
    const props = cameraProps[i];
    if (typeof props === 'string') {
      if (i === 0) firstCamId = getEntityIdByAppId(props);
      continue;
    }
    createCameraEntity(props.camProps, props.entityOpts);
    oneCameraCreated = true;
    if (props.camProps.active) activeCamFound = true;
  }
  if (!oneCameraCreated) {
    const msg = 'No camera was created in createCameras (SceneLoader).';
    lerror(msg);
    throw new Error(msg);
  }
  if (!activeCamFound && firstCamId) {
    setActiveCamera(firstCamId);
  }
};

export type ScenePrimitiveAssets = {
  textures: { [id: string]: THREE.Texture };
  materials: { [id: string]: THREE.Material };
  geometries: { [id: string]: THREE.BufferGeometry };
};

const loadNextSceneAssets = async (sceneData: SceneData): Promise<ScenePrimitiveAssets> => {
  const textures: ScenePrimitiveAssets['textures'] = {};
  const materials: ScenePrimitiveAssets['materials'] = {};
  const geometries: ScenePrimitiveAssets['geometries'] = {};

  // Load and create textures
  const sceneTextures = sceneData.textures || [];
  const texturePromises: Promise<THREE.Texture>[] = [];
  const textureIds: string[] = [];
  for (let i = 0; i < sceneTextures.length; i++) {
    const tex = sceneTextures[i];
    if (typeof tex === 'string') continue;
    const texId = tex.id;
    if (!texId) continue;
    textureIds.push(texId);
    texturePromises.push(loadTextureAsync(tex));
  }
  const loadedTextures = await Promise.all(texturePromises);
  for (let i = 0; i < loadedTextures.length; i++) {
    textures[textureIds[i]] = loadedTextures[i];
  }

  // Create materials
  const sceneMaterials = sceneData.materials || [];
  for (let i = 0; i < sceneMaterials.length; i++) {
    const material = sceneMaterials[i];
    if (typeof material === 'string') {
      const mat = getMaterial(material);
      if (mat) materials[material] = mat;
      continue;
    }
    for (let j = 0; j < textureMapKeys.length; j++) {
      const params = material.params as Record<string, unknown> | undefined;
      if (params) {
        for (const texKey of textureMapKeys) {
          const texRef = params[texKey];
          if (typeof texRef !== 'string') continue; // not set, or already a Texture
          const texture = textures[texRef] || getTexture(texRef);
          if (!texture) {
            lwarn(`Could not find texture with id "${texRef}" in loadNextSceneAssets.`);
            continue;
          }
          params[texKey] = texture;
        }
      }
    }

    const mat = createMaterial({ ...material, params: { ...material.params } });
    if (mat) materials[material.id || `material-${i}`] = mat;
  }

  // Create geometries
  const sceneGeometries = sceneData.geometries || [];
  for (let i = 0; i < sceneGeometries.length; i++) {
    const geometry = sceneGeometries[i];
    if (typeof geometry === 'string') {
      const geo = getGeometry(geometry);
      if (geo) geometries[geometry] = geo as THREE.BufferGeometry;
      continue;
    }
    const geo = createGeometry({ ...geometry });
    if (geo) geometries[geometry.id || `geometry-${i}`] = geo;
  }

  return { textures, materials, geometries };
};

const createNextSceneObject3Ds = async (sceneData: SceneData): Promise<void> => {
  // Create lights
  const lightProps = sceneData.lights || [];
  for (let i = 0; i < lightProps.length; i++) {
    const props = lightProps[i];
    if (typeof props === 'string') continue;
    createLightEntity(props.lightProps, props.entityOpts);
  }

  // Create meshes
  const meshProps = sceneData.meshes || [];
  for (let i = 0; i < meshProps.length; i++) {
    const props = meshProps[i];
    if (typeof props === 'string') continue;
    if (typeof props.props.geo === 'string') {
      const geo = getGeometry(props.props.geo);
      if (!geo) {
        lerror(
          `Could not find geometry with id "${props.props.geo}" for mesh "${props.props.appId || props.entityOpts?.appId}" in createNextSceneObject3Ds. Mesh not created.`
        );
        continue;
      }
      props.props.geo = geo as THREE.BufferGeometry;
    }
    if (typeof props.props.mat === 'string') {
      const mat = getMaterial(props.props.mat);
      if (!mat) {
        lerror(
          `Could not find material with id "${props.props.mat}" for "${props.props.appId || props.entityOpts?.appId}" mesh in createNextSceneObject3Ds. Mesh not created.`
        );
        continue;
      }
      props.props.mat = mat;
    }
    createMeshEntity(props.props, props.entityOpts);
  }

  // Create imported meshes
  const importedMeshProps = sceneData.importedMeshes || [];
  const promises: Promise<ImportReturnObj>[] = [];
  for (let i = 0; i < importedMeshProps.length; i++) {
    const props = importedMeshProps[i];
    promises.push(importModelAsync(props.props));
  }
  await Promise.all(promises);
};

/**
 * Loads a scene with a scene loader
 * @param loadSceneProps (object) {@link LoadSceneProps}
 */
export const loadScene = async (loadSceneProps: LoadSceneProps) => {
  currentlyLoading = true;

  // Convert variables to mutables so the debugger can intercept them
  let sceneId = loadSceneProps.sceneId;
  let targetLoaderId = loadSceneProps.loaderId;
  let overrideNextSceneFn = loadSceneProps.nextSceneFn;

  // Process Debug Start Scene Interception (First boot only)
  const debugToolsState =
    isDebugEnvironment() && !firstSceneLoaded ? getDebugToolsState(true) : null;

  if (
    debugToolsState?.scenesListing.useDebugStartScene &&
    debugToolsState.scenesListing.debugStartScene
  ) {
    sceneId = debugToolsState.scenesListing.debugStartScene;

    // Clear out any hardcoded start functions passed by index.ts
    // to guarantee the lookup pulls dynamically from sceneFileObjects instead
    overrideNextSceneFn = undefined;

    // Resolve your loader @TODO: Override with the explicit debugger loader
    if (debugToolsState.scenesListing.useDebuggerSceneLoader) {
      targetLoaderId = DEBUGGER_SCENE_LOADER_ID;
    }
  }

  // Resolve Scene Data using the final resolved sceneId
  nextSceneId = sceneId;
  let sceneData = getGeneratedSceneData(sceneId);

  if (!sceneData) {
    const sceneOpts = getSceneOpts(sceneId);
    if (sceneOpts) {
      sceneData = {
        id: sceneId,
        sceneFile: '',
        name: sceneOpts.name,
        description: sceneOpts.description,
      };
    } else {
      const msg = `Could not find sceneData / sceneOpts with scene id "${sceneId}" in loadScene.`;
      lerror(msg);
      throw new Error(msg);
    }
  }

  // Resolve the Stage Execution Function from your autogenerated registry module
  const nextSceneFn = overrideNextSceneFn || sceneFileObjects[sceneId];
  if (!nextSceneFn) {
    const errorMsg = `Could not find nextSceneFn in loadScene for sceneId ${sceneId}`;
    lerror(errorMsg);
    throw new Error(errorMsg);
  }

  const initNextSceneFn = nextSceneFn;

  // Resolve the Scene Loader Component context
  let loader: SceneLoader | undefined = getCurrentSceneLoader();
  if (targetLoaderId) {
    loader = sceneLoaders.find((sl) => sl.id === targetLoaderId);
    if (!loader) {
      const msg = `Could not find scene loader with loader id "${targetLoaderId}" in loadScene.`;
      lerror(msg);
      throw new Error(msg);
    }
  }

  let loadStartFn = loader.loadStartFn;
  if (!loadStartFn) {
    loadStartFn = async () => new Promise((resolve) => resolve(true));
  }
  let loadFn = loader.loadFn;
  if (!loadFn) {
    loadFn = async (_loader, nextSceneFn) => await nextSceneFn(sceneData);
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

  loader.phase = 'START';
  await loadStartFn(loader)
    .then(async () => {
      setIsLoadingScene(true);

      // Delete prev scene characters, physics objects, in scene cameras, and in scene lights
      deleteAllCharacters();
      deleteAllPhysicsObjects();
      deleteAllGroups({ deleteAll: true });

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
      runOnAllSceneExits();
      deleteAllRayHelpers();

      const ecsWorld = existsOrThrow(getECSWorld(), 'Could not find ECS World in loadScene');
      if (IS_DEBUG_ENV) {
        // We Give the Debug Camera a chance to save its final state for the current scene.
        // This triggers the 'end' logic manually if needed, or simply ensures LS is up to date.
        ecsWorld.getEntitiesWith(ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA).next().value;
      }
      ecsWorld.clearNonPersistent();

      loader.phase = 'LOAD';

      createCameras(sceneData);

      // Create / load all next scene assets before the scene file
      const nextSceneAssets = await loadNextSceneAssets(sceneData);

      await loadFn(loader, () => initNextSceneFn({ sceneData, assets: nextSceneAssets })).then(
        async () => {
          // Scene has been loaded and initialized
          existsOrThrow(
            getScene(sceneId),
            `Scene loader could not find scene with scene id '${sceneId}'.`
          );
          setCurrentScene(sceneId);
          await applySkyBoxForScene(sceneId);
          await createNextSceneObject3Ds(sceneData);

          const canvasParentElem = getCanvasParentElem();
          canvasParentElem?.style.setProperty('pointer-events', '');

          // Enable input controls
          setAllInputsEnabled(true);

          firstSceneLoaded = true;

          runOnSceneEnter(sceneId);
          runOnAllSceneEnters();

          if (isDebugEnvironment()) {
            // Enable debuggers
            disableDebugger(false);

            updateOnScreenTools();
            resetRayCastStats();
          }

          loader.phase = 'END';
          await loadEndFn(loader).then(() => {
            if (loaderContainer) loaderContainer.remove();
            if (loader.loaderGroup) rootScene.remove(loader.loaderGroup);

            loader.phase = undefined;
            currentlyLoading = false;
            nextSceneId = null;
            setIsLoadingScene(currentlyLoading);
          });
        }
      );
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

/**
 * This tells whether the scene loader has started/ended the loading animation sequence.
 *
 * This does NOT tell whether the loading has started or ended, but just that loading
 * sequence has started or ended. For more accurate loading phase check, use
 * loopState.isLoading as it tells when the actual loading starts and ends.
 * @returns boolean
 */
export const isCurrentlyLoading = () => currentlyLoading;

export const hasFirstSceneBeenLoaded = () => firstSceneLoaded;

export const getNextSceneId = () => nextSceneId;
