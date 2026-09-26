import type * as THREE from 'three/webgpu';
import type { ECSWorld } from '../ECS';

/** The two line renderers. `THIN` is `THREE.LineSegments` (always 1px, cheapest for very
 * large segment counts), `FAT` is instanced screen-space quads (any pixel width). */
export type LineBackendKind = 'THIN' | 'FAT';

/** `AUTO` picks `THIN` at width <= 1 and `FAT` above it; the other two pin a backend. */
export type LineBackendChoice = 'AUTO' | LineBackendKind;

/** What a write past the pre-allocated capacity does. `GROW` doubles the buffer (a
 * reallocation — fine at startup, avoid per frame). `FIXED` drops the overflowing segments
 * with a one-time warning — what a per-frame refill with a known ceiling wants. */
export type LineGrowth = 'GROW' | 'FIXED';

/** Where the line's Object3D is added. The caller owns the policy; the line only obeys it.
 * `ENTITY` parents it to an entity's OBJECT3D (placement only — bindLineToEntity is what
 * ties the line's lifetime to an entity). */
export type LineAttachment =
  | { to: 'ROOT_SCENE' }
  | { to: 'PARENT'; parent: THREE.Object3D }
  | { to: 'ENTITY'; entityId: number; world?: ECSWorld }
  | { to: 'NONE' };

/** A transform relative to whatever the line is attached to. Omitted parts are left as is. */
export type LineLocalTransform = {
  position?: THREE.Vector3Like;
  quaternion?: THREE.QuaternionLike;
  scale?: THREE.Vector3Like;
};

/** How a pulse eases between two colours: `LINEAR`, `SMOOTH` (smoothstep, the default —
 * continuous across colour stops) or `SINE` (half a cosine). */
export type LinePulseEasing = 'LINEAR' | 'SMOOTH' | 'SINE';

/** `CYCLE` (default) wraps last → first; `PING_PONG` sweeps first → last → first. */
export type LinePulseMode = 'CYCLE' | 'PING_PONG';

/** A line's colour. `setColor` is the STATIC case; both write the same GPU uniforms. */
export type LineColorStyle =
  | {
      type: 'STATIC';
      color: THREE.ColorRepresentation;
      /** 0..1, keeps the current opacity when omitted. */
      opacity?: number;
    }
  | {
      type: 'PULSE';
      /** 1 to 4 colours (LINE_PULSE_MAX_COLORS); extras are ignored with a warning. */
      colors: THREE.ColorRepresentation[];
      /** Cycles per second of main loop time — follows play speed, stops on master pause. */
      speed: number;
      /** Start offset in cycles, 0..1. Default 0. */
      phase?: number;
      /** Adds a phase derived from the line id, so many lines pulse out of step. */
      autoPhase?: boolean;
      /** Default `'SMOOTH'`. */
      easing?: LinePulseEasing;
      /** Default `'CYCLE'`. */
      mode?: LinePulseMode;
      /** 0..1, keeps the current opacity when omitted. */
      opacity?: number;
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
  /** Default `0xffffff`. Ignored when `colorStyle` is given. */
  color?: THREE.ColorRepresentation;
  /** A static colour or a pulse. Overrides `color`. */
  colorStyle?: LineColorStyle;
  /** 0..1, default 1. Below 1 the line renders as transparent. */
  opacity?: number;
  /** Line width in screen pixels, default 1. */
  width?: number;
  /** Default `'AUTO'`. */
  backend?: LineBackendChoice;
  /** Default `{ to: 'ROOT_SCENE' }`. */
  attach?: LineAttachment;
  /** Survives scene switches (which dispose every other standalone line), like a
   * PERSISTENT entity. For lines whose owner manages their lifetime itself. Default false.
   * Lines bound to an entity follow that entity instead. */
  persistent?: boolean;
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
