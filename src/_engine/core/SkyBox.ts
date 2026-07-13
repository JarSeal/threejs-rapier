import * as THREE from 'three/webgpu';
import { normalWorld, uniform, pmremTexture, vec3 } from 'three/tsl';
import { lerror, lwarn } from '../utils/Logger';
import {
  getCurrentScene,
  getCurrentSceneId,
  getRootScene,
  getScene,
  isCurrentScene,
} from './Scene';
import { getTexture, loadTextureAsync } from './Texture';
import { isDebugEnvironment } from './Config';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import { DebugModuleRef, isHDR, loadDebugModuleAsync, useDebug } from '../utils/helpers';
import { getNextSceneId, hasFirstSceneBeenLoaded } from './SceneLoader';

export type SkyBoxProps = {
  id: string;
  isCurrent?: boolean; // Default is true
  sceneId?: string;
  debugData?: { name?: string; description?: string };
} & (
  | {
      type: '';
      params: null;
    }
  | {
      type: 'EQUIRECTANGULAR';
      params: {
        file?: string | THREE.Texture | THREE.DataTexture;
        path?: string;
        textureId?: string;
        /** Default is THREE.SRGBColorSpace */
        colorSpace?: THREE.ColorSpace;
        roughness?: number;
        // @TODO: check if equiTextRotate can be added (just use prop name rotate)
      };
    }
  | {
      type: 'CUBETEXTURE';
      params: {
        fileNames: string[];
        path?: string;
        textureId?: string;
        /** Default is THREE.SRGBColorSpace */
        colorSpace?: THREE.ColorSpace;
        roughness?: number;
        cubeTextRotate?: number; // @TODO: change this to just prop name rotate
        flipY?: boolean;
      };
    }
  | {
      type: 'SKYANDSUN';
      params: null;
    }
);

export type SkyBoxState = {
  id: string;
  name?: string;
  isCurrent?: boolean;
  isDefaultForScene?: boolean;
  type: '' | 'EQUIRECTANGULAR' | 'CUBETEXTURE' | 'SKYANDSUN';
  equiRectFile: string;
  equiRectTextureId: string;
  equiRectColorSpace: THREE.ColorSpace;
  equiRectRoughness: number;
  cubeTextFile: string[];
  cubeTextPath: string;
  cubeTextTextureId: string;
  cubeTextColorSpace: THREE.ColorSpace;
  cubeTextRoughness: number;
  cubeTextRotate: number;
  cubeTextFlipY: boolean;
  envBallRoughness: number;
  sceneSkyBoxesFolderExpanded: boolean;
};

export const LS_KEY_ALL_STATES = 'AEK_debugSkyBoxStates';
export const NO_SKYBOX_ID = '__no_skybox';
export let defaultRoughness = 0;
const pmremRoughnessBg = uniform(defaultRoughness);

export const defaultSkyBoxState: SkyBoxState = {
  id: NO_SKYBOX_ID,
  type: '',
  equiRectFile: '',
  equiRectTextureId: '',
  equiRectColorSpace: THREE.SRGBColorSpace,
  equiRectRoughness: defaultRoughness,
  cubeTextFile: [],
  cubeTextPath: '',
  cubeTextTextureId: '',
  cubeTextColorSpace: THREE.SRGBColorSpace,
  cubeTextRoughness: defaultRoughness,
  cubeTextRotate: 0,
  cubeTextFlipY: false,
  envBallRoughness: defaultRoughness,
  sceneSkyBoxesFolderExpanded: false,
};
let skyBoxState = { ...defaultSkyBoxState };
let allSkyBoxStates: {
  [sceneId: string]: {
    [id: string]: SkyBoxState;
  };
} = {};
let cubeTexture: THREE.CubeTexture | null = null;

/**
 * Creates either a sky box (equirectangular, cube texture, or sky and sun). The sky and sun type ("SKYANDSUN") includes a dynamic sun element in the sky.
 * @param skyBoxProps (object) object that has different property's based on the type property, {@link SkyBoxProps}
 * @param doNotUpdateDebuggerSceneDefault (boolean) optional flag to be used only within the sky box debugger
 */
export const createSkyBox = async (
  { id, sceneId, isCurrent, type, params, debugData }: SkyBoxProps,
  doNotUpdateDebuggerSceneDefault?: boolean // This is to keep the [*default] indicator in the debugger listings when the debugger changes the sky box
) => {
  let scene = getCurrentScene();
  if (sceneId) scene = getScene(sceneId);
  const isCurScene = isCurrentScene(scene?.userData.id);
  if (!scene && hasFirstSceneBeenLoaded()) {
    const msg = `Could not find ${sceneId ? `scene with id "${sceneId}"` : 'current scene'} in createSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  const givenOrCurrentSceneId = scene?.userData.id || getNextSceneId();
  if (!givenOrCurrentSceneId) {
    const msg = 'Could not find current scene id in createSkyBox.';
    lerror(msg);
    throw new Error(msg);
  }

  let skyBoxStateToBeAdded = {
    ...defaultSkyBoxState,
    isCurrent: isCurrent !== false,
  };
  if (!allSkyBoxStates[givenOrCurrentSceneId]) allSkyBoxStates[givenOrCurrentSceneId] = {};
  if (!allSkyBoxStates[givenOrCurrentSceneId][id]) {
    allSkyBoxStates[givenOrCurrentSceneId][id] = { ...defaultSkyBoxState };
  }

  if (params && 'roughness' in params) {
    // @TODO: refactor this to save the original input value as default value (the value to reset to)
    defaultRoughness = params.roughness !== undefined ? params.roughness : defaultRoughness;
    skyBoxStateToBeAdded.equiRectRoughness = defaultRoughness;
    skyBoxStateToBeAdded.cubeTextRoughness = defaultRoughness;
  }

  if (isDebugEnvironment()) {
    const savedAllSkyBoxStates = lsGetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    allSkyBoxStates = { ...allSkyBoxStates, ...savedAllSkyBoxStates };
    const curSceneState = allSkyBoxStates[givenOrCurrentSceneId][id];
    skyBoxStateToBeAdded = {
      ...skyBoxStateToBeAdded,
      ...(curSceneState || {}),
      isCurrent: isCurrent !== false,
    };

    if (!doNotUpdateDebuggerSceneDefault) {
      const sceneSkyBoxes = allSkyBoxStates[givenOrCurrentSceneId];
      const sceneSkyBoxKeys = Object.keys(sceneSkyBoxes);
      for (let i = 0; i < sceneSkyBoxKeys.length; i++) {
        const ssb = sceneSkyBoxes[sceneSkyBoxKeys[i]];
        ssb.isDefaultForScene = false;
      }
    }
  }

  skyBoxStateToBeAdded.id = id;
  skyBoxStateToBeAdded.type = type;

  if (type === 'EQUIRECTANGULAR') {
    // EQUIRECTANGULAR
    const file = params.file;
    const textureId = params.textureId;
    if (!file && !textureId) {
      lerror('Provide either file or textureId in the equirectangular params in createSkyBox.');
      return;
    }
    let equirectTexture: THREE.Texture | THREE.DataTexture | null = null;
    let envTexture: null | THREE.Texture | THREE.DataTexture = null;

    if (isCurScene && skyBoxStateToBeAdded.isCurrent) {
      if (typeof file === 'string' || textureId) {
        // File is a string or textureId was provided (texture has been already loaded)
        if (isHDR(file as string)) {
          // @TODO: cache equirectangular textures
          equirectTexture = await loadTextureAsync({
            id: textureId,
            fileName: file as string,
            path: params.path,
            useHDRLoader: true,
            throwOnError: isDebugEnvironment(),
          });
          // equirectTexture.magFilter = THREE.LinearFilter;
          // equirectTexture.minFilter = THREE.LinearMipMapLinearFilter;
          // equirectTexture.anisotropy = 16;
        } else {
          equirectTexture = file
            ? await loadTextureAsync({
                id: textureId,
                fileName: file as string,
                throwOnError: isDebugEnvironment(),
              })
            : getTexture(textureId || '');
        }
        if (!equirectTexture) {
          const msg = `Could not find or load equirectangular texture in createSkyBox (params: ${JSON.stringify(params)}).`;
          lerror(msg);
          return;
        }
        equirectTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
        envTexture = equirectTexture;
      } else if (file) {
        // File is a Texture/DataTexture
        file.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
        equirectTexture = file;
        envTexture = file;
      }

      // Use sky box as environment map
      if (!envTexture) {
        const msg = 'Could not find envTexture in createSkyBox';
        lerror(msg);
        throw new Error(msg);
      }
      envTexture.mapping = THREE.EquirectangularReflectionMapping;
      // const reflectVec = positionViewDirection
      //   .negate()
      //   .reflect(normalView)
      //   .transformDirection(cameraViewMatrix);
      pmremRoughnessBg.value = skyBoxStateToBeAdded.equiRectRoughness;
      const backgroundEnvNode = pmremTexture(envTexture, normalWorld, pmremRoughnessBg);

      const rootScene = getRootScene() as THREE.Scene;
      rootScene.backgroundNode = backgroundEnvNode;
      rootScene.environmentNode = backgroundEnvNode;
      if (scene) {
        scene.userData.backgroundNodeTextureId = textureId || envTexture.userData.id;
      }
      if (isDebugEnvironment()) {
        // const pmremRoughnessBall = uniform(skyBoxStateToBeAdded.equiRectRoughness);
        // const pmremNodeBall = pmremTexture(envTexture, reflectVec, pmremRoughnessBall);
        // setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
      }
    }

    if (equirectTexture) {
      equirectTexture.flipY = false;
      equirectTexture.needsUpdate = true;
    }

    // Add to skyBoxStateToBeAdded
    skyBoxStateToBeAdded.equiRectFile = typeof file === 'string' ? file : '';
    skyBoxStateToBeAdded.equiRectTextureId = textureId
      ? textureId
      : equirectTexture?.userData.id || undefined;
    skyBoxStateToBeAdded.equiRectColorSpace =
      params.colorSpace !== undefined ? params.colorSpace : THREE.SRGBColorSpace;
  } else if (type === 'CUBETEXTURE') {
    // CUBETEXTURE
    const { fileNames, path, textureId, flipY } = params;

    if (isCurScene && skyBoxStateToBeAdded.isCurrent) {
      cubeTexture = (await loadTextureAsync({
        id: textureId,
        fileName: fileNames,
        path,
        throwOnError: isDebugEnvironment(),
      })) as THREE.CubeTexture;
      cubeTexture.userData.id = textureId || cubeTexture.uuid;
      cubeTexture.generateMipmaps = true;
      cubeTexture.minFilter = THREE.LinearMipmapLinearFilter;
      cubeTexture.colorSpace = params.colorSpace || defaultSkyBoxState.cubeTextColorSpace;

      pmremRoughnessBg.value = skyBoxStateToBeAdded.cubeTextRoughness;
      let backgroundUV = normalWorld;
      const rotateYMatrix = new THREE.Matrix4();
      rotateYMatrix.makeRotationY(Math.PI * skyBoxStateToBeAdded.cubeTextRotate);
      backgroundUV = backgroundUV.transformDirection(uniform(rotateYMatrix));
      // If it's upside down, flip the Y. If mirrored, flip Z.
      if (flipY) {
        backgroundUV = vec3(backgroundUV.x.negate(), backgroundUV.y.negate(), backgroundUV.z);
      } else {
        backgroundUV = vec3(backgroundUV.x.negate(), backgroundUV.y, backgroundUV.z);
      }
      if (isCurScene && isCurrent !== false) {
        const rootScene = getRootScene() as THREE.Scene;
        rootScene.backgroundNode = pmremTexture(cubeTexture, backgroundUV, pmremRoughnessBg);
      }
      if (scene) {
        scene.userData.backgroundNodeTextureId = textureId || cubeTexture.userData.id;
      }
      if (isDebugEnvironment()) {
        // const pmremRoughnessBall = uniform(skyBoxStateToBeAdded.cubeTextRoughness);
        // const pmremNodeBall = pmremTexture(cubeTexture, backgroundUV.mul(-1), pmremRoughnessBall);
        // setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
      }
    }

    // Add to skyBoxStateToBeAdded
    skyBoxStateToBeAdded.cubeTextFile = fileNames;
    skyBoxStateToBeAdded.cubeTextPath = path || defaultSkyBoxState.cubeTextPath;
    skyBoxStateToBeAdded.cubeTextTextureId = textureId || cubeTexture?.userData.id || undefined;
    skyBoxStateToBeAdded.cubeTextColorSpace =
      params.colorSpace !== undefined ? params.colorSpace : defaultSkyBoxState.cubeTextColorSpace;
    skyBoxStateToBeAdded.cubeTextRotate =
      params.cubeTextRotate !== undefined
        ? params.cubeTextRotate
        : defaultSkyBoxState.cubeTextRotate;
    skyBoxStateToBeAdded.cubeTextFlipY = Boolean(flipY);
  } else if (type === 'SKYANDSUN') {
    // SKYANDSUN
    // @TODO: implement SKYANDSUN
    lwarn('At the moment SKYANDSUN skybox type is not supported (maybe in the future).'); // @TODO: remove when fully implemented
  }

  if (skyBoxStateToBeAdded.isCurrent) {
    // If the sky box is set to current, then set all the scene's existing sky boxes as not current
    const curSceneStates = allSkyBoxStates[givenOrCurrentSceneId];
    const curSceneStatesKeys = Object.keys(curSceneStates);

    for (let i = 0; i < curSceneStatesKeys.length; i++) {
      const key = curSceneStatesKeys[i];
      if (allSkyBoxStates[givenOrCurrentSceneId][key]) {
        allSkyBoxStates[givenOrCurrentSceneId][key].isCurrent = false;
        if (!doNotUpdateDebuggerSceneDefault) {
          allSkyBoxStates[givenOrCurrentSceneId][key].isDefaultForScene = false;
        }
      }
    }
    if (!doNotUpdateDebuggerSceneDefault) skyBoxStateToBeAdded.isDefaultForScene = true;
  }
  allSkyBoxStates[givenOrCurrentSceneId][id] = {
    ...defaultSkyBoxState,
    ...skyBoxStateToBeAdded,
    name: debugData?.name,
  };

  if (skyBoxStateToBeAdded.isCurrent) {
    skyBoxState = { ...skyBoxState, ...allSkyBoxStates[givenOrCurrentSceneId][id] };
  }

  createSkyBoxDebugGUI();
};

/**
 * Deletes the current scene's current sky box
 */
export const deleteCurrentSkyBox = () => {
  const rootScene = getRootScene() as THREE.Scene;
  rootScene.backgroundNode = null;
  rootScene.environmentNode = null;
  skyBoxState = { ...defaultSkyBoxState };

  const sceneId = getCurSceneSkyBoxSceneId();
  const curSceneStates = allSkyBoxStates[sceneId];
  const curSceneStatesKeys = Object.keys(curSceneStates);
  for (let i = 0; i < curSceneStatesKeys.length; i++) {
    const key = curSceneStatesKeys[i];
    if (allSkyBoxStates[sceneId][key]) {
      allSkyBoxStates[sceneId][key].isCurrent = false;
    }
  }
};

// Debug
type SkyBoxGUIModule = typeof import('../core/Debug/_dbg__SkyBox');
let debugGUI: DebugModuleRef<SkyBoxGUIModule> | null = null;

export const registerSkyBoxDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__SkyBox'));
};

/**
 * Build the debug GUI
 */
export const createSkyBoxDebugGUI = () => {
  useDebug(debugGUI)?._createSkyBoxDebugGUI(skyBoxState, allSkyBoxStates);
};

export const extractSkyBoxParamsFromState = (state: SkyBoxState) => {
  if (state.type === 'EQUIRECTANGULAR') {
    return {
      type: state.type,
      params: {
        file: state.equiRectFile || undefined,
        textureId: state.equiRectTextureId || undefined,
        colorSpace: state.equiRectColorSpace || undefined,
        roughness: state.equiRectRoughness || undefined,
      },
    } as SkyBoxProps;
  }
  if (state.type === 'CUBETEXTURE') {
    return {
      type: state.type,
      params: {
        fileNames: state.cubeTextFile || undefined,
        path: state.cubeTextPath || undefined,
        textureId: state.cubeTextTextureId || undefined,
        colorSpace: state.cubeTextColorSpace || undefined,
        roughness: state.cubeTextRoughness || undefined,
        cubeTextRotate: state.cubeTextRotate || undefined,
        flipY: state.cubeTextFlipY || undefined,
      },
    } as SkyBoxProps;
  }
  if (state.type === 'SKYANDSUN') {
    return {
      type: state.type,
      params: null,
    } as SkyBoxProps;
  }
  return {
    type: '',
    params: null,
  } as SkyBoxProps;
};

export const getCurSceneSkyBoxSceneId = () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) {
    const msg = 'Could not find current scene id in getCurSceneSkyBoxSceneId.';
    lerror(msg);
    throw new Error(msg);
  }
  return sceneId;
};

/**
 * Clears the current sky box state and root scene's background and environment nodes
 */
export const clearSkyBox = () => {
  skyBoxState = { ...defaultSkyBoxState };
  const rootScene = getRootScene() as THREE.Scene;
  if (rootScene) {
    rootScene.backgroundNode = null;
    rootScene.environmentNode = null;
  }
  createSkyBoxDebugGUI();
};

/**
 * Get pmremRoughnessBg (the environment map roughness shader node)
 * @returns ShaderNodeObject<THREE.UniformNode<number>>
 */
export const getEnvMapRoughnessBg = () => pmremRoughnessBg;

export const applySkyBoxForScene = async (sceneId: string) => {
  const states = allSkyBoxStates[sceneId];
  if (!states || !Object.keys(states).length) return;
  let current = Object.values(states).find((s) => s.isCurrent);
  if (!current || current.id === NO_SKYBOX_ID || !current.type) {
    current = states[Object.keys(states)[0]];
    if (!current) return;
  }
  await createSkyBox(
    { ...extractSkyBoxParamsFromState(current), id: current.id, sceneId, isCurrent: true },
    true
  );
};
