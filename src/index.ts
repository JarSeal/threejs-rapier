import * as THREE from 'three/webgpu';
import { createRenderer } from './_engine/core/Renderer';
import { createCamera } from './_engine/core/Camera';
import { InitEngine } from './_engine/InitApp';
import { scene01 } from './app/scene01';
import { InitRapierPhysics } from './_engine/core/PhysicsRapier';

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

  // Load scene
  // @TODO: add scene loader
  await scene01();
});
