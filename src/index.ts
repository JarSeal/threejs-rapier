import * as THREE from 'three/webgpu';
import { createRenderer } from './_engine/core/Renderer';
import { createCamera } from './_engine/core/Camera';
import { InitEngine } from './_engine/InitApp';
import { scene01 } from './app/scene01_v2';
import { createSceneLoader, loadScene } from './_engine/core/SceneLoader';
import { CMP } from './_engine/utils/CMP';

export const MAIN_APP_CAM_ID = 'mainAppCam';

InitEngine(async () => {
  // Init camera
  createCamera(MAIN_APP_CAM_ID, { isCurrentCamera: true, fov: 90 });

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
    loaderContainerFn: () =>
      CMP({
        text: '',
        style: {
          id: 'main-sene-loader-cmp',
          width: '100vw',
          height: '100vh',
          background: 'blue',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 1000,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          transition: 'opacity 0.5s ease-in',
          opacity: 0,
        },
      }),
    loadStartFn: (loader) =>
      new Promise((resolve) => {
        setTimeout(() => loader.loaderContainer?.updateStyle({ opacity: 1 }), 1);
        setTimeout(() => resolve(true), 500);
      }),
    loadEndFn: (loader) =>
      new Promise((resolve) => {
        loader.loaderContainer?.updateStyle({ opacity: 0 });
        setTimeout(() => resolve(true), 500);
      }),
    updateLoaderStatusFn: async (loader, params) => {
      if (!params) return true;
      if ('loadedCount' in params && 'totalCount' in params) {
        loader.loaderContainer?.updateText(`Loading, ${params.loadedCount} / ${params.totalCount}`);
        if (params.loaded === params.totalCount) return true;
      }
    },
  });

  // Load scene
  loadScene({ nextSceneFn: scene01 });
});
