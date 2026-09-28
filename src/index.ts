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
    const vpApi = await import('./_engine/core/Viewports');
    const { createViewport, getViewportPointerNDC } = vpApi;
    const { getRootScene, getCurrentSceneId } = await import('./_engine/core/Scene');
    const { getMainCamera } = await import('./_engine/core/CameraManager');
    const { setPostFxEnabled } = await import('./_engine/core/PostFX');
    const { getRenderer } = await import('./_engine/core/Renderer');
    const w = window as unknown as Record<string, unknown>;
    w.__r = getRenderer();
    w.__vp = vpApi;
    w.__loadScene = (sceneId: string) => loadScene({ sceneId });
    if (vpParams.get('postFx') === '0') setPostFxEnabled(false);
    // Transition test: toggling body.vpSpikeShift slides the top-right stack
    const styleElem = document.createElement('style');
    styleElem.textContent = `.aekViewportStack_TOP_RIGHT { transition: right 0.6s linear; }
      body.vpSpikeShift .aekViewportStack_TOP_RIGHT { right: 40rem; }
      @media (max-width: 600px) { .vpSpikeSmall { display: none; } }`;
    document.head.appendChild(styleElem);
    // Transparent private scene: a cube with pure colours per face
    const cubeScene = new THREE.Scene();
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff].map(
        (color) => new THREE.MeshBasicNodeMaterial({ color })
      )
    );
    cube.rotation.set(0.5, 0.6, 0);
    cubeScene.add(cube);
    const makeCam = () => {
      const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
      cam.position.set(0, 0, 3);
      return cam;
    };
    const ndc = new THREE.Vector2();
    w.__ndc = [];
    // Corner stack: order 0 (in the corner, interactive) and order 1 (wide, left of it)
    const cornerVp = createViewport({
      id: 'spikeCorner',
      scene: cubeScene,
      camera: makeCam(),
      anchor: 'TOP_RIGHT',
      order: 0,
      size: { width: '10rem', height: '10rem' },
      syncCameraAspect: true,
      interactive: true,
    });
    cornerVp.slotElem.addEventListener('pointerdown', (e) => {
      const inside = getViewportPointerNDC('spikeCorner', e, ndc);
      (w.__ndc as unknown[]).push({ inside, x: ndc.x, y: ndc.y });
    });
    createViewport({
      id: 'spikeWide',
      scene: cubeScene,
      camera: makeCam(),
      anchor: 'TOP_RIGHT',
      order: 1,
      size: { width: '16rem', height: '8rem' },
      slotClass: 'vpSpikeSmall',
      syncCameraAspect: true,
    });
    createViewport({
      id: 'spikeBottomRight',
      scene: cubeScene,
      camera: makeCam(),
      anchor: 'BOTTOM_RIGHT',
      size: { width: '8rem', height: '8rem' },
      syncCameraAspect: true,
    });
    // Explicit px rect, partially off the canvas (crop)
    createViewport({
      id: 'spikeCropped',
      scene: cubeScene,
      camera: makeCam(),
      rect: { x: -60, y: 90, width: 120, height: 120 },
      syncCameraAspect: true,
    });
    // Opaque PiP of the game scene from the main camera, deleted on this scene's exit
    createViewport({
      id: 'spikePiP',
      scene: getRootScene() as THREE.Scene,
      camera: () => getMainCamera() ?? null,
      rect: { x: 2, y: 68, width: 30, height: 30, unit: '%' },
      transparent: false,
      clearColor: 0x330033,
      toneMapping: 'RENDERER',
      sceneId: getCurrentSceneId() || undefined,
    });
  }
});
