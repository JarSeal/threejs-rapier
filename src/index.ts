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
    loaderContainer: CMP({
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
        opacity: 1,
      },
    }),
    // @TODO: This does not work, because we cannot have multiple Three.js scenes.
    // Change the scenes to be Three.js Groups and create a root scene in the
    // initEngine method.
    // loadStartFn: (loader) =>
    //   new Promise((resolve) => {
    //     loader.loaderContainer?.updateStyle({ opacity: 1 });
    //     setTimeout(() => resolve(true), 500);
    //   }),
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
  // await scene01();
});
