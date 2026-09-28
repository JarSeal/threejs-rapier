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

  // P080 SPIKE (THROWAWAY, DO NOT COMMIT)
  const vpParams = new URLSearchParams(window.location.search);
  if (vpParams.get('vpTest')) {
    const { createViewport } = await import('./_engine/core/Viewports');
    const { getRootScene } = await import('./_engine/core/Scene');
    const { getMainCamera } = await import('./_engine/core/CameraManager');
    const { setPostFxEnabled } = await import('./_engine/core/PostFX');
    const { getRenderer } = await import('./_engine/core/Renderer');
    if (vpParams.get('postFx') === '0') setPostFxEnabled(false);
    (window as unknown as { __r: unknown }).__r = getRenderer();
    if (vpParams.get('tm') === 'none') {
      setTimeout(() => ((getRenderer() as THREE.Renderer).toneMapping = THREE.NoToneMapping), 3000);
    }
    // Transparent private scene: a spinning cube with pure colours per face
    const cubeScene = new THREE.Scene();
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff].map(
        (color) => new THREE.MeshBasicNodeMaterial({ color })
      )
    );
    cube.rotation.set(0.5, 0.6, 0);
    cubeScene.add(cube);
    const cubeCam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
    cubeCam.position.set(0, 0, 3);
    const spin = vpParams.get('spin') !== '0';
    createViewport({
      id: 'spikeCube',
      scene: cubeScene,
      camera: cubeCam,
      rect: { x: window.innerWidth - 220, y: 20, width: 200, height: 200 },
      onBeforeRender: (_vp, delta) => {
        if (spin) cube.rotation.y += delta;
      },
    });
    // Same cube, partially off the canvas (left edge), to test the crop
    createViewport({
      id: 'spikeCubeCropped',
      scene: cubeScene,
      camera: cubeCam,
      rect: { x: -100, y: 20, width: 200, height: 200 },
    });
    // Opaque PiP of the game scene from the main camera (canvas aspect)
    createViewport({
      id: 'spikePiP',
      scene: getRootScene() as THREE.Scene,
      camera: () => getMainCamera() ?? null,
      rect: { x: 2, y: 68, width: 30, height: 30, unit: '%' },
      transparent: false,
      clearColor: 0x330033,
      toneMapping: 'RENDERER',
    });
  }
});
