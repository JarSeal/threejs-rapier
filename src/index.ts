import * as THREE from 'three/webgpu';
import { createRenderer } from './_engine/core/Renderer';
import { createCamera } from './_engine/core/Camera';
import { InitEngine } from './_engine/InitApp';
import { scene01 } from './app/scene01_v2';
import { InitRapierPhysics } from './_engine/core/PhysicsRapier';
import { createSceneLoader, loadScene } from './_engine/core/SceneLoader';
import { CMP } from './_engine/utils/CMP';

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
    loadFn: (_loader, nextSceneFn) => nextSceneFn(),
    loaderContainer: CMP({
      text: 'LOADING...',
      style: {
        id: 'main-sene-loader-container',
        width: '100vw',
        height: '100vh',
        background: 'blue',
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 99999,
      },
    }),
    updateLoaderStatusFn: async (_, params) => {
      if (!params) return true;
      if ('loadedCount' in params && 'totalCount' in params) {
        if (params.loaded === params.totalCount) return true;
        return false;
      }
      return true;
    },
  });

  // Load scene
  loadScene({ nextSceneFn: scene01 });
  // await scene01();
});
