import * as THREE from 'three/webgpu';
import {
  normalWorld,
  uniform,
  normalView,
  positionViewDirection,
  cameraViewMatrix,
  pmremTexture,
  reflectVector,
} from 'three/tsl';
import { lerror, lwarn } from '../utils/Logger';
import { getCurrentScene, getRootScene, getScene, isCurrentScene } from './Scene';
import { getRenderer } from './Renderer';
import { getTexture, loadTexture } from './Texture';
import { isDebugEnvironment } from './Config';
import { createNewDebuggerPane, createDebuggerTab } from '../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import {
  changeDebugEnvBallRoughness,
  getDebugToolsState,
  setDebugEnvBallMaterial,
} from '../debug/DebugTools';
import { RGBELoader } from 'three/examples/jsm/Addons.js';
import { isHDR } from '../utils/helpers';

type SkyBoxProps = {
  id: string; // @TODO
  name?: string; // @TODO
  isCurrent?: boolean;
  sceneId?: string;
  deleteWhenSceneUnloads?: boolean; // @TODO
} & (
  | {
      type: '';
      params: null;
    }
  | {
      type: 'EQUIRECTANGULAR';
      params: {
        file?: string | THREE.Texture | THREE.DataTexture;
        textureId?: string;
        colorSpace?: THREE.ColorSpace;
        isEnvMap?: boolean;
        roughness?: number;
      };
    }
  | {
      type: 'CUBETEXTURE';
      params: {
        fileNames: string[];
        path?: string;
        textureId?: string;
        colorSpace?: THREE.ColorSpace;
        roughness?: number;
        cubeTextRotate?: number;
      };
    }
  | {
      type: 'SKYANDSUN';
      params: null;
    }
);

type SkyBoxState = {
  id: string;
  name?: string;
  deleteWhenSceneUnloads?: boolean;
  type: '' | 'EQUIRECTANGULAR' | 'CUBETEXTURE' | 'SKYANDSUN';
  textureId?: string;
  equiRectFolderExpanded: boolean;
  equiRectFile: string;
  equiRectTextureId: string;
  equiRectColorSpace: THREE.ColorSpace;
  equiRectIsEnvMap: boolean;
  equiRectRoughness: number;
  cubeTextFolderExpanded: boolean;
  cubeTextFile: string; // Check if this works, there should an array of strings
  cubeTextTextureId: string;
  cubeTextColorSpace: THREE.ColorSpace;
  cubeTextRoughness: number;
  cubeTextRotate: number;
  envBallRoughness: number;
};

const LS_KEY_STATE = 'debugSkyBoxState';
const LS_KEY_ALL_STATES = 'debugAllSkyBoxStates';
let defaultRoughness = 0.5;
const pmremRoughnessBg = uniform(defaultRoughness);
let allSkyBoxStates: {
  [sceneId: string]: {
    [id: string]: SkyBoxState;
  };
} = {};

const defaultSkyBoxState: SkyBoxState = {
  id: '',
  type: '',
  textureId: undefined,
  equiRectFolderExpanded: false,
  equiRectFile: '',
  equiRectTextureId: '',
  equiRectColorSpace: THREE.SRGBColorSpace,
  equiRectIsEnvMap: false,
  equiRectRoughness: defaultRoughness,
  cubeTextFolderExpanded: false,
  cubeTextFile: '',
  cubeTextTextureId: '',
  cubeTextColorSpace: THREE.SRGBColorSpace,
  cubeTextRoughness: defaultRoughness,
  cubeTextRotate: 0,
  envBallRoughness: defaultRoughness,
};
let skyBoxState = { ...defaultSkyBoxState };
let debuggerCreated = false;
let cubeTexture: THREE.CubeTexture | null = null;

/**
 * Creates either a sky box (equirectangular, cube texture, or sky and sun). The sky and sun type ("SKYANDSUN") includes a dynamic sun element.
 * @param skyBoxProps object that has different property's based on the type property, {@link SkyBoxProps}
 */
export const addSkyBox = async ({ sceneId, type, params }: SkyBoxProps) => {
  if (params && 'roughness' in params) {
    defaultRoughness = params.roughness || 0.5;
    skyBoxState.equiRectRoughness = defaultRoughness;
  }

  const renderer = getRenderer();
  if (!renderer) {
    const msg = `Could not find renderer in addSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  let scene = getCurrentScene();
  if (sceneId) scene = getScene(sceneId);
  const isCurScene = isCurrentScene(scene?.userData.id);
  if (!scene) {
    const msg = `Could not find ${sceneId ? `scene with id "${sceneId}"` : 'current scene'} in addSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  if (isDebugEnvironment()) {
    const savedSkyBoxState = lsGetItem(LS_KEY_STATE, skyBoxState);
    skyBoxState = { ...skyBoxState, ...savedSkyBoxState };
    const savedAllSkyBoxStates = lsGetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    allSkyBoxStates = { ...allSkyBoxStates, ...savedAllSkyBoxStates };
    if (!debuggerCreated) {
      createSkyBoxDebugGUI();
      debuggerCreated = true;
    }
  }

  skyBoxState.type = type;
  if (type === 'EQUIRECTANGULAR') {
    const file = params.file;
    const textureId = params.textureId;
    if (!file && !textureId) {
      lerror('Provide either file or textureId in the equirectangular params in addSkyBox.');
      return;
    }
    let envTexture: null | THREE.Texture | THREE.DataTexture = null;
    if (typeof file === 'string' || textureId) {
      // File is a string or textureId was provided (texture was preloaded)
      let equirectTexture: THREE.Texture | THREE.DataTexture | null = null;
      if (isHDR(file as string)) {
        equirectTexture = await new RGBELoader().loadAsync(file as string);
        // equirectTexture.magFilter = THREE.LinearFilter;
        // equirectTexture.minFilter = THREE.LinearMipMapLinearFilter;
        // equirectTexture.anisotropy = 16;
      } else {
        equirectTexture = file
          ? loadTexture({
              id: textureId,
              fileName: file as string,
              throwOnError: isDebugEnvironment(),
            })
          : getTexture(textureId || '');
      }
      if (!equirectTexture) {
        const msg = `Could not find or load equirectangular texture in addSkyBox (params: ${JSON.stringify(params)}).`;
        lerror(msg);
        return;
      }
      if (typeof file === 'string') skyBoxState.equiRectFile = file;
      skyBoxState.equiRectTextureId = textureId ? textureId : equirectTexture.userData.id;
      equirectTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
      envTexture = equirectTexture;
    } else if (file) {
      // File is a Texture/DataTexture
      file.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
      envTexture = file;
    }

    // Use sky box as environment map
    if (!envTexture) {
      const msg = 'Could not find envTexture in addSkyBox';
      lerror(msg);
      throw new Error(msg);
    }
    envTexture.mapping = THREE.EquirectangularReflectionMapping;
    const reflectVec = positionViewDirection
      .negate()
      .reflect(normalView)
      .transformDirection(cameraViewMatrix);
    pmremRoughnessBg.value = skyBoxState.equiRectRoughness;
    const backgroundEnvNode = pmremTexture(envTexture, normalWorld, pmremRoughnessBg);
    if (isCurScene) {
      const rootScene = getRootScene() as THREE.Scene;
      rootScene.backgroundNode = backgroundEnvNode;
      rootScene.environmentNode = backgroundEnvNode;
    }
    scene.userData.backgroundNodeTextureId = textureId || envTexture.userData.id;
    if (isDebugEnvironment()) {
      const pmremRoughnessBall = uniform(skyBoxState.equiRectRoughness);
      const pmremNodeBall = pmremTexture(envTexture, reflectVec, pmremRoughnessBall);
      setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
    }

    return;
  }

  if (type === 'CUBETEXTURE') {
    const { fileNames, path, textureId } = params;

    cubeTexture = await new THREE.CubeTextureLoader().setPath(path || './').loadAsync(fileNames);
    cubeTexture.userData.id = textureId || cubeTexture.uuid;
    cubeTexture.generateMipmaps = true;
    cubeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    cubeTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;

    pmremRoughnessBg.value = skyBoxState.cubeTextRoughness;
    const rotateYMatrix = new THREE.Matrix4();
    rotateYMatrix.makeRotationY(Math.PI * skyBoxState.cubeTextRotate);
    const backgroundUV = reflectVector.xyz.mul(uniform(rotateYMatrix));
    if (isCurScene) {
      const rootScene = getRootScene() as THREE.Scene;
      rootScene.backgroundNode = pmremTexture(cubeTexture, backgroundUV, pmremRoughnessBg);
    }
    scene.userData.backgroundNodeTextureId = textureId || cubeTexture.userData.id;
    if (isDebugEnvironment()) {
      const pmremRoughnessBall = uniform(skyBoxState.cubeTextRoughness);
      const pmremNodeBall = pmremTexture(cubeTexture, backgroundUV.mul(-1), pmremRoughnessBall);
      setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
    }

    lwarn('CUBETEXTURE skybox type is under work in progress and may not work properly.');
    return;
  }

  if (type === 'SKYANDSUN') {
    // @TODO: implement SKYANDSUN
    lwarn('At the moment SKYANDSUN skybox type is not supported (maybe in the future).');
    return;
  }
};

// Debug GUI for sky box
const createSkyBoxDebugGUI = () => {
  createDebuggerTab({
    id: 'skyBoxControls',
    buttonText: 'SKYBOX',
    title: 'Sky box controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('skyBox', 'Sky Box Controls');

      debugGUI.addBinding(skyBoxState, 'type', {
        label: 'Type',
        readonly: true,
        options: [
          {
            text: 'None',
            value: '',
          },
          {
            text: 'Equirectangular',
            value: 'EQUIRECTANGULAR',
          },
          {
            text: 'Cube texture',
            value: 'CUBETEXTURE',
          },
          {
            text: 'Sky and sun',
            value: 'SKYANDSUN',
          },
        ],
      });

      // Equirectangular
      const equiRectFolder = debugGUI
        .addFolder({
          title: 'Equirectangular sky box params',
          hidden: skyBoxState.type !== 'EQUIRECTANGULAR',
          expanded: skyBoxState.equiRectFolderExpanded,
        })
        .on('fold', (state) => {
          skyBoxState.equiRectFolderExpanded = state.expanded;
          lsSetItem(LS_KEY_STATE, skyBoxState);
        });
      equiRectFolder.addBinding(skyBoxState, 'equiRectFile', {
        label: 'File path or URL',
        readonly: true,
      });
      equiRectFolder.addBinding(skyBoxState, 'equiRectTextureId', {
        label: 'Texture id',
        readonly: true,
      });
      equiRectFolder.addBinding(skyBoxState, 'equiRectColorSpace', {
        label: 'Color space',
        readonly: true,
      });
      equiRectFolder.addBinding(skyBoxState, 'equiRectIsEnvMap', {
        label: 'Is environment map',
        readonly: true,
      });
      equiRectFolder
        .addBinding(skyBoxState, 'equiRectRoughness', {
          label: 'Roughness',
          step: 0.001,
          min: 0,
          max: 1,
        })
        .on('change', (e) => {
          pmremRoughnessBg.value = e.value;
          const debugToolsState = getDebugToolsState();
          if (!debugToolsState.env.separateBallValues) {
            changeDebugEnvBallRoughness(e.value);
          }
          lsSetItem(LS_KEY_STATE, skyBoxState);
        });
      equiRectFolder.addButton({ title: 'Reset' }).on('click', () => {
        skyBoxState.equiRectRoughness = defaultRoughness;
        pmremRoughnessBg.value = defaultRoughness;
        const debugToolsState = getDebugToolsState();
        if (!debugToolsState.env.separateBallValues) {
          changeDebugEnvBallRoughness(defaultRoughness);
        }
        lsRemoveItem(LS_KEY_STATE);
        debugGUI.refresh();
      });

      // Cubetexture
      const cubeTextureFolder = debugGUI
        .addFolder({
          title: 'Cube texture sky box params',
          hidden: skyBoxState.type !== 'CUBETEXTURE',
          expanded: skyBoxState.cubeTextFolderExpanded,
        })
        .on('fold', (state) => {
          skyBoxState.cubeTextFolderExpanded = state.expanded;
          lsSetItem(LS_KEY_STATE, skyBoxState);
        });
      cubeTextureFolder.addBinding(skyBoxState, 'cubeTextFile', {
        label: 'File path or URL',
        readonly: true,
      });
      cubeTextureFolder.addBinding(skyBoxState, 'cubeTextTextureId', {
        label: 'Texture id',
        readonly: true,
      });
      cubeTextureFolder.addBinding(skyBoxState, 'cubeTextColorSpace', {
        label: 'Color space',
        readonly: true,
      });
      cubeTextureFolder
        .addBinding(skyBoxState, 'cubeTextRoughness', {
          label: 'Roughness',
          step: 0.001,
          min: 0,
          max: 1,
        })
        .on('change', (e) => {
          pmremRoughnessBg.value = e.value;
          const debugToolsState = getDebugToolsState();
          if (!debugToolsState.env.separateBallValues) {
            changeDebugEnvBallRoughness(e.value);
          }
          lsSetItem(LS_KEY_STATE, skyBoxState);
        });
      cubeTextureFolder.addButton({ title: 'Reset' }).on('click', () => {
        skyBoxState.cubeTextRoughness = defaultRoughness;
        pmremRoughnessBg.value = defaultRoughness;
        const debugToolsState = getDebugToolsState();
        if (!debugToolsState.env.separateBallValues) {
          changeDebugEnvBallRoughness(defaultRoughness);
        }
        lsRemoveItem(LS_KEY_STATE);
        debugGUI.refresh();
      });

      return container;
    },
  });
};

/**
 * Get pmremRoughnessBg (the environment map roughness shader node)
 * @returns ShaderNodeObject<THREE.UniformNode<number>>
 */
export const getEnvMapRoughnessBg = () => pmremRoughnessBg;
