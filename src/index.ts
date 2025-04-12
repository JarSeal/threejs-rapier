import * as THREE from 'three/webgpu';
import { createRenderer } from './_engine/core/Renderer';
import { createCamera } from './_engine/core/Camera';
import { InitEngine } from './_engine/InitApp';
import { scene01 } from './app/scene01_v2';
import { InitRapierPhysics } from './_engine/core/PhysicsRapier';
import { createSceneLoader, loadScene } from './_engine/core/SceneLoader';

InitEngine(async () => {
  await InitRapierPhysics();

  // Init camera
  createCamera('mainCam', { isCurrentCamera: true, fov: 90 });

  // Init renderer
  createRenderer({
    antialias: true,
    forceWebGL: false,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 0.7,
    outputColorSpace: THREE.SRGBColorSpace,
    alpha: true,
  });

  // Create sceneLoader
  createSceneLoader({
    id: 'main-scene-loader',
    loadFn: (loader, nextSceneFn) => {
      console.log('LOAD_FN', loader);
      nextSceneFn();
      return new Promise((resolve) => resolve(true));
    },
    updateLoaderStatusFn: async (_, params) => {
      console.log('Update loader status', params);
      if (!params) return true;
      if ('loadedCount' in params && 'totalCount' in params) {
        if (params.loaded === params.totalCount) return true;
        return false;
      }
      return true;
    },
  });

  // Load scene
  // @TODO: add scene loader
  loadScene({ nextSceneFn: scene01 });
  // await scene01();
});
