import * as THREE from 'three/webgpu';
import { texture, equirectUV, ShaderNodeObject } from 'three/tsl';
import { lerror, lwarn } from '../utils/Logger';
import { getCurrentScene, getScene } from './Scene';
import { getRenderer } from './Renderer';

type SkyBoxProps = {
  sceneId?: string;
} & (
  | {
      type: 'EQUIRECTANGULAR';
      params: {
        file: string | THREE.Texture;
        colorSpace?: string;
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

  if (type === 'EQUIRECTANGULAR') {
    const file = params.file;
    if (typeof file === 'string') {
      new THREE.TextureLoader().load(
        file,
        (equirectTexture) => {
          equirectTexture.colorSpace = THREE.SRGBColorSpace;
          const shaderNodeTexture = texture(equirectTexture, equirectUV(), 0);
          equirectTexture.dispose();
          scene.backgroundNode = shaderNodeTexture as unknown as ShaderNodeObject<THREE.Node>;
        },
        undefined,
        (err) => {
          if (err) {
            const msg = `Error while loading equirectangular texture for ${sceneId ? `scene with id "${sceneId}"` : 'current scene'} in addSkyBox (type: ${type}, file: ${params.file}).`;
            lerror(msg, err);
            throw new Error(msg);
          }
        }
      );
    } else {
      file.colorSpace = THREE.SRGBColorSpace;
      const shaderNodeTexture = texture(file, equirectUV(), 0);
      scene.backgroundNode = shaderNodeTexture as unknown as ShaderNodeObject<THREE.Node>;
    }
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
