import type * as THREE from 'three/webgpu';

/** The ray kinds the debug helper renderer draws, each with its own settings and colors. */
export type RayHelperKind = 'THREE' | 'PHYSICS';

/**
 * Debug helper options of a ray cast. Ignored outside debug. Every omitted option falls back
 * to the ray kind's setting (Ray cast controls tab).
 *
 * A helper is active (solid, `color`) while its ray is cast and for `holdMs` after the last
 * cast, then inactive (dashed, `inactiveColor`, fading out over `fadeOutMs`), then hidden.
 */
export type RayDebugOpts = {
  /** Stable helper id: the same id reuses the same helper across casts and frames */
  id: string;
  /** Active color */
  color?: THREE.ColorRepresentation;
  /** Inactive (fading) color */
  inactiveColor?: THREE.ColorRepresentation;
  /** Line width in screen pixels */
  width?: number;
  /** Minimum time the helper stays active after its last cast, in ms */
  holdMs?: number;
  /** Duration of the inactive fade-out, in ms */
  fadeOutMs?: number;
  /** Whether the hit point is marked with a cross, default true */
  showHit?: boolean;
  /** Default false: helpers draw on top of everything */
  depthTest?: boolean;
};
