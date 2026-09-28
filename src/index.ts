import * as THREE from 'three/webgpu';
import { createRenderer } from './_engine/core/Renderer';
import { InitEngine } from './_engine/InitApp';
import { createSceneLoader, loadScene } from './_engine/core/SceneLoader';
import { CMP } from './_engine/utils/CMP';

InitEngine(async () => {
  // Init renderer
  await createRenderer({
    antialias: true,
    forceWebGL: false,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 0.7,
    outputColorSpace: THREE.SRGBColorSpace,
    alpha: true,
    enableShadows: true,
    // shadowMapType: THREE.PCFSoftShadowMap,
    // shadowMapType: THREE.PCFShadowMap,
    // shadowMapType: THREE.BasicShadowMap,
    shadowMapType: THREE.VSMShadowMap,
  });

  // Create sceneLoader
  createSceneLoader({
    id: 'main-scene-loader',
    loaderContainerFn: () =>
      CMP({
        id: 'main-scene-loader-cmp',
        text: '',
        style: {
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
        setTimeout(() => {
          loader.loaderContainer?.updateStyle({ opacity: 1 });
          setTimeout(() => resolve(true), 500);
        }, 0);
      }),
    loadEndFn: (loader) =>
      new Promise((resolve) => {
        setTimeout(() => {
          loader.loaderContainer?.updateStyle({ opacity: 0 });
          setTimeout(() => resolve(true), 500);
        }, 0);
      }),
    updateLoaderStatusFn: async (loader, params) => {
      if (!params) return true;
      if ('loadedCount' in params && 'totalCount' in params) {
        loader.loaderContainer?.update({
          text: `Loading, ${params.loadedCount} / ${params.totalCount}`,
        });
        if (params.loaded === params.totalCount) return true;
      }
    },
  });

  // Load scene
  await loadScene({ sceneId: 'sceneTestECS' });
});
