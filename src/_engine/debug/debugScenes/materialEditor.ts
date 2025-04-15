import * as THREE from 'three/webgpu';
import { createScene } from '../../core/Scene';
import { debugSceneListing } from '../DebugSceneListing';

export const DEBUG_MATERIAL_EDITOR_ID = '_debug-material-editor';

export const initDebugMaterialEditorScene = async () =>
  new Promise<string>((resolve) => {
    console.log('INIT MATERIAL EDItoR');
    const debugScene = debugSceneListing.find((item) => item.id === DEBUG_MATERIAL_EDITOR_ID);
    if (!debugScene) {
      resolve('');
      return;
    }
    createScene(debugScene?.id, {
      ...(debugScene.text ? { name: debugScene.text } : {}),
      backgroundColor: new THREE.Color(0xff0000),
    });

    resolve(DEBUG_MATERIAL_EDITOR_ID);
  });
