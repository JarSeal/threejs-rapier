import * as THREE from 'three/webgpu';
import { abs, cos, float, floor, fract, min, mix, mod, uniform } from 'three/tsl';
import type { LineColorNode } from './LineBackend';
import type { LineColorStyle, LinePulseEasing } from './LineTypes';

/**
 * Line colour on the GPU: a static colour or a pulse through up to
 * {@link LINE_PULSE_MAX_COLORS} colours, driven by one engine-wide time uniform. Every line
 * reads the same time value, so pulsing costs no per-line CPU work.
 *
 * For `N` colours, `speed` in cycles per second and `phase` in [0, 1):
 * `t = phase + time * speed`, then
 * - CYCLE: `u = fract(t) * N`, blending colour `floor(u)` into the next one (wrapping N-1 → 0),
 * - PING_PONG: `u = (1 - |1 - 2 * fract(t / 2)|) * (N - 1)`, sweeping first → last → first
 *   (one cycle is one sweep in one direction),
 * with the blend factor `u - floor(u)` passed through the easing. Blending happens in the
 * working colour space (linear sRGB).
 */

/** Colours a pulse can blend between. Four uniforms and a select chain keep every palette
 * size on one pipeline; raising it means more uniforms (a LUT texture is the general form). */
export const LINE_PULSE_MAX_COLORS = 4;

/** Seconds of main loop time (getElapsedTime): scales with play speed and stands still
 * while the master loop is paused, unlike TSL's wall-clock `time`. Written once per frame
 * by the line time system (LineSystem.ts). */
export const lineTimeUniform = uniform(0);

/** @internal The uniforms one line's colour graphs read. setColor and pulses write the
 * same set, so there is only ever one writer of a line's colour. */
export const createLineColorUniforms = () => ({
  colors: Array.from({ length: LINE_PULSE_MAX_COLORS }, () => uniform(new THREE.Color(0xffffff))),
  count: uniform(1),
  speed: uniform(0),
  phase: uniform(0),
  opacity: uniform(1),
});

export type LineColorUniforms = ReturnType<typeof createLineColorUniforms>;

/** @internal Which graph a style needs; a change of key means a pipeline rebuild. Anything
 * with a single colour is STATIC — setColor is the one-colour pulse. */
export const colorGraphKey = (style: LineColorStyle) =>
  style.type === 'PULSE' && style.colors.length > 1
    ? `PULSE:${style.easing ?? 'SMOOTH'}:${style.mode ?? 'CYCLE'}`
    : 'STATIC';

type FloatNode = THREE.Node<'float'>;

const ease = (k: FloatNode, easing: LinePulseEasing): FloatNode => {
  switch (easing) {
    case 'LINEAR':
      return k;
    case 'SINE':
      return float(0.5).sub(cos(k.mul(Math.PI)).mul(0.5));
    case 'SMOOTH':
      // C¹ across colour stops, so the cycle reads as one continuous motion
      return k.mul(k).mul(float(3).sub(k.mul(2)));
  }
};

/** colors[index] for a float index, via a select chain (no dynamic uniform indexing). */
const pickColor = (u: LineColorUniforms, index: FloatNode) =>
  index
    .lessThan(0.5)
    .select(
      u.colors[0],
      index.lessThan(1.5).select(u.colors[1], index.lessThan(2.5).select(u.colors[2], u.colors[3]))
    );

/** @internal The colour node for a style's graph key. */
export const createLineColorNode = (u: LineColorUniforms, style: LineColorStyle): LineColorNode => {
  if (colorGraphKey(style) === 'STATIC') return u.colors[0];
  const easing = style.type === 'PULSE' ? style.easing ?? 'SMOOTH' : 'SMOOTH';
  const mode = style.type === 'PULSE' ? style.mode ?? 'CYCLE' : 'CYCLE';

  const t = u.phase.add(lineTimeUniform.mul(u.speed));
  const n = u.count;
  let from: FloatNode;
  let to: FloatNode;
  let k: FloatNode;
  if (mode === 'CYCLE') {
    const x = fract(t).mul(n);
    from = floor(x);
    to = mod(from.add(1), n);
    k = x.sub(from);
  } else {
    const sweep = float(1).sub(abs(float(1).sub(fract(t.mul(0.5)).mul(2))));
    const x = sweep.mul(n.sub(1));
    // At the very end of a sweep x = N - 1: stay on the last arc with k = 1
    from = min(floor(x), n.sub(2));
    to = from.add(1);
    k = x.sub(from);
  }
  return mix(pickColor(u, from), pickColor(u, to), ease(k, easing));
};

/** @internal A stable [0, 1) phase offset from a line id, for `autoPhase`: FNV-1a, then the
 * murmur3 finaliser. Without the finaliser, ids differing only in their last character
 * (`box_1`, `box_2`) differ only in the low bits and land ~0.004 cycles apart — a grid of
 * them would still pulse in unison. */
export const hashLinePhase = (id: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
};
