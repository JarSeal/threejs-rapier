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
import { createMesh } from './Mesh';
import { createGeometry } from './Geometry';
import { createMaterial } from './Material';
import { getCurrentCamera } from './Camera';
import { createNewDebuggerGUI, setDebuggerTabAndContainer } from '../debug/DebuggerGUI';
import { lsSetItem } from '../utils/LocalAndSessionStorage';
import { setDebugEnvBallMaterial } from '../debug/DebugTools';

type SkyBoxProps = {
  sceneId?: string;
} & (
  | {
      type: 'EQUIRECTANGULAR';
      params: {
        file?: string | THREE.Texture | THREE.DataTexture;
        textureId?: string;
        colorSpace?: string;
        isEnvMap?: boolean;
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
const skyBoxState = {
  type: '',
  file: '',
  textureId: '',
  colorSpace: THREE.SRGBColorSpace,
  isEnvMap: false,
};
let debuggerCreated = false;

/**
 * Creates either a sky box (equirectangular, cube texture, or sky and sun). The sky and sun type ("SKYANDSUN") includes a dynamic sun element.
 * @param skyBoxProps object that has different property's based on the type property, {@link SkyBoxProps}
 */
export const addSkyBox = ({ sceneId, type, params }: SkyBoxProps) => {
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

  if (type === 'EQUIRECTANGULAR') {
    const file = params.file;
    const textureId = params.textureId;
    if (!file && !textureId) {
      lerror('Provide either file or textureId in the equirectangular params in addSkyBox.');
      return;
    }
    if (typeof file === 'string' || textureId) {
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
        const pmremRoughnessBg = uniform(0.5);
        const pmremRoughnessBall = uniform(1);
        const pmremNodeBall = pmremTexture(equirectTexture, reflectVec, pmremRoughnessBall);
        scene.backgroundNode = pmremTexture(equirectTexture, normalWorld, pmremRoughnessBg);
        scene.userData.backgroundNodeTextureId = textureId || equirectTexture.userData.id;
        console.log(pmremRoughnessBall);
        setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall, pmremRoughnessBg);
      }
    } else if (file) {
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
      const { container, debugGui } = createNewDebuggerGUI('skyBox', 'Sky Box Controls');
      debugGui
        .add(skyBoxState, 'type')
        .name('Type')
        .onChange(() => {
          lsSetItem(LS_KEY, skyBoxState);
        });
      debugGui
        .add(skyBoxState, 'file')
        .name('File path')
        .onChange(() => {
          lsSetItem(LS_KEY, skyBoxState);
        });
      debugGui
        .add(skyBoxState, 'textureId')
        .name('Texture id')
        .onChange(() => {
          lsSetItem(LS_KEY, skyBoxState);
        });
      debugGui
        .add(skyBoxState, 'colorSpace')
        .name('Color space')
        .onChange(() => {
          lsSetItem(LS_KEY, skyBoxState);
        });
      debugGui
        .add(skyBoxState, 'isEnvMap')
        .name('Is environment map')
        .onChange(() => {
          lsSetItem(LS_KEY, skyBoxState);
        });
      return container;
    },
  });
};
