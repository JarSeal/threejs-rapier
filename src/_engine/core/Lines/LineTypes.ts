import type * as THREE from 'three/webgpu';

/** The two line renderers. `THIN` is `THREE.LineSegments` (always 1px, cheapest for very
 * large segment counts), `FAT` is instanced screen-space quads (any pixel width). */
export type LineBackendKind = 'THIN' | 'FAT';

/** `AUTO` picks `THIN` at width <= 1 and `FAT` above it; the other two pin a backend. */
export type LineBackendChoice = 'AUTO' | LineBackendKind;

/** What a write past the pre-allocated capacity does. `GROW` doubles the buffer (a
 * reallocation — fine at startup, avoid per frame). `FIXED` drops the overflowing segments
 * with a one-time warning — what a per-frame refill with a known ceiling wants. */
export type LineGrowth = 'GROW' | 'FIXED';

/** Where the line's Object3D is added. The caller owns the policy; the line only obeys it. */
export type LineAttachment =
  | { to: 'ROOT_SCENE' }
  | { to: 'PARENT'; parent: THREE.Object3D }
  | { to: 'NONE' };

/** A transform relative to whatever the line is attached to. Omitted parts are left as is. */
export type LineLocalTransform = {
  position?: THREE.Vector3Like;
  quaternion?: THREE.QuaternionLike;
  scale?: THREE.Vector3Like;
};

export type LineProps = {
  /** Registry id. Auto-generated when omitted; must be unique among live lines. */
  id?: string;
  /** Object3D name (debugging). Defaults to the id. */
  name?: string;
  /** Initial segments as a flat `xyzxyz` list (6 floats per segment). */
  segments?: ArrayLike<number>;
  /** Pre-allocated capacity in segments. Defaults to the initial segment count, or 64 when
   * there are none. */
  capacity?: number;
  /** Overflow policy, default `'GROW'`. */
  growth?: LineGrowth;
  /** Default `0xffffff`. */
  color?: THREE.ColorRepresentation;
  /** 0..1, default 1. Below 1 the line renders as transparent. */
  opacity?: number;
  /** Line width in screen pixels, default 1. */
  width?: number;
  /** Default `'AUTO'`. */
  backend?: LineBackendChoice;
  /** Default `{ to: 'ROOT_SCENE' }`. */
  attach?: LineAttachment;
  localTransform?: LineLocalTransform;
  /** Default true. */
  visible?: boolean;
  /** Default true. False draws the line on top of everything it would be hidden behind. */
  depthTest?: boolean;
  renderOrder?: number;
  /** Default false. A line is an overlay primitive; culling one against stale bounds makes
   * it vanish at unpredictable camera angles. Enable together with `recomputeBounds` for
   * a line that is refilled. */
  frustumCulled?: boolean;
  /** Recompute bounds on every `endWrite()` (O(segments) per commit). Without it, bounds
   * are computed once, on the first commit. Default false. */
  recomputeBounds?: boolean;
};
