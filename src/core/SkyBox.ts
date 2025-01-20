import * as THREE from 'three/webgpu';
import {
  texture,
  equirectUV,
  ShaderNodeObject,
  normalWorld,
  uniform,
  normalView,
  positionViewDirection,
  cameraViewMatrix,
  pmremTexture,
} from 'three/tsl';
import { lerror, lwarn } from '../utils/Logger';
import { getCurrentScene, getScene } from './Scene';
import { getRenderer } from './Renderer';
import { getTexture, loadTexture } from './Texture';
import { isDebugEnvironment } from './Config';
import { createNewDebuggerGUI, setDebuggerTabAndContainer } from '../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import {
  changeDebugEnvBallRoughness,
  getDebugToolsState,
  setDebugEnvBallMaterial,
} from '../debug/DebugTools';

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
        file: string;
      };
    }
  | {
      type: 'SKYANDSUN';
      params: null;
    }
);

const LS_KEY = 'debugSkyBox';
let defaultRoughness = 0.5;
const pmremRoughnessBg = uniform(defaultRoughness);
let skyBoxState = {
  type: '',
  equiRectFolderExpanded: false,
  equiRectFile: '',
  equiRectTextureId: '',
  equiRectColorSpace: THREE.SRGBColorSpace,
  equiRectIsEnvMap: false,
  equiRectRoughness: defaultRoughness,
  cubeTextFolderExpanded: false,
};
let debuggerCreated = false;

/**
 * Creates either a sky box (equirectangular, cube texture, or sky and sun). The sky and sun type ("SKYANDSUN") includes a dynamic sun element.
 * @param skyBoxProps object that has different property's based on the type property, {@link SkyBoxProps}
 */
export const addSkyBox = ({ sceneId, type, params }: SkyBoxProps) => {
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
    if (typeof file === 'string' || textureId) {
      // File is a string or textureId was provided (texture was preloaded)
      const equirectTexture = file
        ? loadTexture({
            id: textureId,
            fileName: file as string,
            throwOnError: isDebugEnvironment(),
          })
        : getTexture(textureId || '');
      if (!equirectTexture) {
        const msg = `Could not find or load equirectangular texture in addSkyBox (params: ${JSON.stringify(params)}).`;
        lerror(msg);
        return;
      }
      if (typeof file === 'string') skyBoxState.equiRectFile = file;
      if (textureId) skyBoxState.equiRectTextureId = textureId;
      equirectTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;

      // Sky box without environment map
      if (!params.isEnvMap) {
        const shaderNodeTexture = texture(equirectTexture, equirectUV(), 0);
        scene.backgroundNode = shaderNodeTexture as unknown as ShaderNodeObject<THREE.Node>;
        scene.userData.backgroundNodeTextureId = textureId || equirectTexture.userData.id;
        return;
      }

      // Use sky box as environment map
      if (typeof file === 'string') {
        equirectTexture.mapping = THREE.EquirectangularReflectionMapping;
        const reflectVec = positionViewDirection
          .negate()
          .reflect(normalView)
          .transformDirection(cameraViewMatrix);
        pmremRoughnessBg.value = skyBoxState.equiRectRoughness;
        scene.backgroundNode = pmremTexture(equirectTexture, normalWorld, pmremRoughnessBg);
        scene.userData.backgroundNodeTextureId = textureId || equirectTexture.userData.id;
        if (isDebugEnvironment()) {
          const pmremRoughnessBall = uniform(skyBoxState.equiRectRoughness);
          const pmremNodeBall = pmremTexture(equirectTexture, reflectVec, pmremRoughnessBall);
          setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
        }
      }
    } else if (file) {
      // File is a Texture/DataTexture
      file.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
      const shaderNodeTexture = texture(file, equirectUV(), 0);
      scene.backgroundNode = shaderNodeTexture as unknown as ShaderNodeObject<THREE.Node>;
      scene.userData.backgroundNodeTextureId = file.userData.id;
    }
    return;
  }

  if (type === 'CUBETEXTURE') {
    // @TODO: implement CUBETEXTURE
    lwarn('At the moment CUBETEXTURE skybox type is not supported (maybe in the future).');
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
  setDebuggerTabAndContainer({
    id: 'skyBoxControls',
    buttonText: 'SKYBOX',
    title: 'Sky box controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerGUI('skyBox', 'Sky Box Controls');

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

      return container;
    },
  });
};
