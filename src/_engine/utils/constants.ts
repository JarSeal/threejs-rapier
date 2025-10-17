import * as THREE from 'three/webgpu';

export const HALF_PI = Math.PI / 2;
export const QUARTER_PI = Math.PI / 4;

export const FOUR_PX_TO_8K_LIST = [
  { value: 4, text: '4px' },
  { value: 8, text: '8px' },
  { value: 16, text: '16px' },
  { value: 32, text: '32px' },
  { value: 64, text: '64px' },
  { value: 128, text: '128px' },
  { value: 256, text: '256px' },
  { value: 512, text: '512px' },
  { value: 1024, text: '1024px' },
  { value: 2048, text: '2048px' },
  { value: 4096, text: '4096px' },
  { value: 8192, text: '8192px' },
];

export const RENDERER_SHADOW_OPTIONS = [
  { value: THREE.BasicShadowMap, text: 'Basic shadow map' },
  { value: THREE.PCFShadowMap, text: 'PCF shadow map' },
  { value: THREE.PCFSoftShadowMap, text: 'PCF soft shadow map' },
  { value: THREE.VSMShadowMap, text: 'VSM shadow map' },
];

// Directions for ray casting with angle (castRayFromAngle)
export const DIRECTIONS = {
  FORWARD: new THREE.Vector3(0, 0, -1),
  BACKWARD: new THREE.Vector3(0, 0, 1),
  UP: new THREE.Vector3(0, 1, 0),
  DOWN: new THREE.Vector3(0, -1, 0),
  RIGHT: new THREE.Vector3(1, 0, 0),
  LEFT: new THREE.Vector3(-1, 0, 0),
};
