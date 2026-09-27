// Worker-safe: only imports three types, so the assets worker can use these too (unlike
// helpers.ts, which imports Config.ts, which reads `window` at module load).
import type * as THREE from 'three/webgpu';

/** Whether an object is a plain Object3D (eg. an empty), not a mesh, group, light, camera or
 * texture. */
export const isOnlyObject3D = (
  obj: THREE.Object3D | THREE.Mesh | THREE.Group | THREE.Light | THREE.Camera | THREE.Texture
) =>
  'isObject3D' in obj &&
  obj.isObject3D &&
  !('isMesh' in obj) &&
  !('isGroup' in obj) &&
  !('isLight' in obj) &&
  !('isCamera' in obj) &&
  !('isTexture' in obj);
