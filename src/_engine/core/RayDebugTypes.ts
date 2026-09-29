import type * as THREE from 'three/webgpu';
import type { IntervalWindowConfig } from '../utils/stats/IntervalCounterStats';

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
  /** Whether geometry in front hides the helper. Defaults to the kind's "Respect depth" setting,
   * which is off: helpers draw on top of everything. */
  depthTest?: boolean;
};

/**
 * Helper id prefix of the debug ray tester windows' rays. Physics queries have no
 * `countInStats` option, so the physics ray statistics skip the queries whose `debug.id` starts
 * with it (they are still drawn). Don't use it for gameplay rays.
 */
export const RAY_TESTER_ID_PREFIX = 'rayTester_';

/** The interval windows of every ray statistics counter (Three.js rays, physics rays and shape
 * casts), so their numbers are comparable. */
export const RAY_STATS_WINDOWS: readonly IntervalWindowConfig[] = [
  { id: 'minMax3s', intervalMs: 3000, kind: 'MIN_MAX' },
  { id: 'minMax10s', intervalMs: 10000, kind: 'MIN_MAX' },
  { id: 'average3s', intervalMs: 3000, kind: 'AVERAGE' },
  { id: 'average20s', intervalMs: 20000, kind: 'AVERAGE' },
];
