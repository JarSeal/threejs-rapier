import type { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let meshoptDecoder: Promise<typeof MeshoptDecoder> | null = null;

/**
 * Returns three's meshopt decoder (EXT_meshopt_compression), imported on the first call, so apps
 * without meshopt-compressed files never download it. (The assets worker imports it statically:
 * its bundle can't be code-split.)
 */
export const getMeshoptDecoder = () => {
  if (!meshoptDecoder) {
    meshoptDecoder = import('three/addons/libs/meshopt_decoder.module.js').then(
      ({ MeshoptDecoder }) => MeshoptDecoder
    );
  }
  return meshoptDecoder;
};
