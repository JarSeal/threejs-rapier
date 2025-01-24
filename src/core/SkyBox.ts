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
import { getCurrentScene, getScene } from './Scene';
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
  sceneId?: string;
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
        colorSpace?: string;
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
        colorSpace?: string;
        roughness?: number;
        cubeTextRotate?: number;
      };
    }
  | {
      type: 'SKYANDSUN';
      params: null;
    }
);

let defaultRoughness = 0.5;
const pmremRoughnessBg = uniform(defaultRoughness);

const LS_KEY = 'debugSkyBox';
let skyBoxState = {
  type: '',
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
};
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
  const savedSkyBoxState = lsGetItem(LS_KEY, skyBoxState);
  skyBoxState = { ...skyBoxState, ...savedSkyBoxState };
  const renderer = getRenderer();
  if (!renderer) {
    const msg = `Could not find renderer in addSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }
  let scene = getCurrentScene();
  if (sceneId) scene = getScene(sceneId);
  if (!scene) {
    const msg = `Could not find ${sceneId ? `scene with id "${sceneId}"` : 'current scene'} in addSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  if (isDebugEnvironment() && !debuggerCreated) {
    createSkyBoxDebugGUI();
    debuggerCreated = true;
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
    scene.backgroundNode = backgroundEnvNode;
    scene.environmentNode = backgroundEnvNode;
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
    scene.backgroundNode = pmremTexture(cubeTexture, backgroundUV);
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

      const equiRectFolder = debugGUI
        .addFolder({
          title: 'Equirectangular sky box params',
          hidden: skyBoxState.type !== 'EQUIRECTANGULAR',
          expanded: skyBoxState.equiRectFolderExpanded,
        })
        .on('fold', (state) => {
          skyBoxState.equiRectFolderExpanded = state.expanded;
          lsSetItem(LS_KEY, skyBoxState);
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
          lsSetItem(LS_KEY, skyBoxState);
        });
      equiRectFolder.addButton({ title: 'Reset' }).on('click', () => {
        skyBoxState.equiRectRoughness = defaultRoughness;
        pmremRoughnessBg.value = defaultRoughness;
        lsRemoveItem(LS_KEY);
        debugGUI.refresh();
      });

      const cubeTextureFolder = debugGUI
        .addFolder({
          title: 'Cube texture sky box params',
          hidden: skyBoxState.type !== 'CUBETEXTURE',
          expanded: skyBoxState.cubeTextFolderExpanded,
        })
        .on('fold', (state) => {
          skyBoxState.cubeTextFolderExpanded = state.expanded;
          lsSetItem(LS_KEY, skyBoxState);
        });
      cubeTextureFolder.addBinding(skyBoxState, 'equiRectFile', {
        label: 'File path or URL',
        readonly: true,
      });
      cubeTextureFolder.addBinding(skyBoxState, 'equiRectTextureId', {
        label: 'Texture id',
        readonly: true,
      });
      cubeTextureFolder.addBinding(skyBoxState, 'equiRectColorSpace', {
        label: 'Color space',
        readonly: true,
      });
      cubeTextureFolder.addBinding(skyBoxState, 'equiRectIsEnvMap', {
        label: 'Is environment map',
        readonly: true,
      });
      cubeTextureFolder
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
          lsSetItem(LS_KEY, skyBoxState);
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
