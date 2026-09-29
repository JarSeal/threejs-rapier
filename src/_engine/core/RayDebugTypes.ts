import type * as THREE from 'three/webgpu';

/** Debug helper options of a ray cast. Ignored outside debug. */
export type RayDebugOpts = {
  /** Stable helper id: the same id reuses the same helper across casts and frames */
  id: string;
  /** Helper color, default red */
  color?: THREE.ColorRepresentation;
};
