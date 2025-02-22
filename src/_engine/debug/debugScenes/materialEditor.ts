import * as THREE from 'three/webgpu';
import { createScene } from '../../core/Scene';
import { DEBUG_SCENE_LISTING } from '../DebugSceneListing';

export const initDebugMaterialEditorScene = () => {
  console.log('INIT MATERIAL EDItoR');
  createScene(DEBUG_SCENE_LISTING.materialEditor.value, {
    backgroundColor: new THREE.Color(0xff0000),
  });
};
