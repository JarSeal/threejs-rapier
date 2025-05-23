import * as THREE from 'three/webgpu';
import { createScene } from '../../core/Scene';
import { debuggerSceneListing } from './debuggerSceneListing';
import { createMesh } from '../../core/Mesh';

export const DEBUG_MATERIAL_EDITOR_ID = '_debug-material-editor';

export const initDebugMaterialEditorScene = async () =>
  new Promise<string>(async (resolve) => {
    // eslint-disable-next-line no-console
    console.log('INIT MATERIAL EDItoR');
    const debugScene = debuggerSceneListing.find((item) => item.id === DEBUG_MATERIAL_EDITOR_ID);
    if (!debugScene) {
      resolve('');
      return;
    }
    const scene = createScene(debugScene?.id, {
      ...(debugScene.text ? { name: debugScene.text } : {}),
      backgroundColor: new THREE.Color(0x770022),
    });

    // @TODO: Fix this! The skybox saved states should come from scene specific objects (now there is only 1)
    // try {
    //   const map01 = [
    //     '/cubemap02_positive_x.png',
    //     '/cubemap02_negative_x.png',
    //     '/cubemap02_negative_y.png',
    //     '/cubemap02_positive_y.png',
    //     '/cubemap02_positive_z.png',
    //     '/cubemap02_negative_z.png',
    //   ];
    //   await addSkyBox({
    //     id: 'desert-dunes',
    //     sceneId: DEBUG_MATERIAL_EDITOR_ID,
    //     type: 'CUBETEXTURE',
    //     params: {
    //       fileNames: map01,
    //       path: './../../../app/assets/testTextures',
    //       textureId: 'cubeTextureId',
    //     },
    //   });
    // } catch (err) {
    //   reject(err);
    // }

    const mesh = createMesh({
      id: 'testMesh',
      geo: { type: 'BOX', params: { width: 1, depth: 1 } },
      mat: { type: 'BASIC', params: { color: new THREE.Color(0xf0ff09) } },
    });

    scene.add(mesh);

    resolve(DEBUG_MATERIAL_EDITOR_ID);
  });
