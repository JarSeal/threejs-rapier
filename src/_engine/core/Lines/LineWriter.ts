import type * as THREE from 'three/webgpu';

/** Floats per segment: two xyz endpoints. */
export const FLOATS_PER_SEGMENT = 6;

/**
 * @internal
 * What a {@link LineWriter} writes into. `positions` may be replaced by `reserve`, so the
 * writer re-reads it after every reservation and never caches it.
 */
export interface LineWriteTarget {
  readonly positions: Float32Array;
  /** Makes room for `floatCount` floats in total. False means no room (a FIXED line
   * overflowed) and the write is dropped. */
  reserve(floatCount: number): boolean;
}

/**
 * Allocation-free segment cursor. Get one from `LineObject.beginWrite()`, which resets it to
 * the start of the buffer; every call appends and returns the writer for chaining. Nothing
 * reaches the GPU until `LineObject.endWrite()`.
 */
export class LineWriter {
  private cursor = 0;

  /** @internal */
  constructor(private readonly target: LineWriteTarget) {}

  /** @internal */
  reset() {
    this.cursor = 0;
    return this;
  }

  /** Number of segments written since the last reset. */
  get segmentCount() {
    return this.cursor / FLOATS_PER_SEGMENT;
  }

  /** Appends one segment from a to b. */
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    if (!this.target.reserve(this.cursor + FLOATS_PER_SEGMENT)) return this;
    const p = this.target.positions;
    const i = this.cursor;
    p[i] = ax;
    p[i + 1] = ay;
    p[i + 2] = az;
    p[i + 3] = bx;
    p[i + 4] = by;
    p[i + 5] = bz;
    this.cursor += FLOATS_PER_SEGMENT;
    return this;
  }

  /** Appends one segment from a to b. */
  vec(a: THREE.Vector3Like, b: THREE.Vector3Like) {
    return this.segment(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  /**
   * Appends segments from a flat `xyzxyz` list. A trailing partial segment is ignored. On
   * a FIXED line only the segments that still fit are written.
   * @param src flat segment endpoints
   * @param start first float to read, default 0
   * @param floatCount floats to read, default everything after `start`
   */
  raw(src: ArrayLike<number>, start = 0, floatCount = src.length - start) {
    let count = floatCount - (floatCount % FLOATS_PER_SEGMENT);
    if (count <= 0) return this;
    if (!this.target.reserve(this.cursor + count)) {
      const room = this.target.positions.length - this.cursor;
      count = room - (room % FLOATS_PER_SEGMENT);
      if (count <= 0) return this;
    }
    const p = this.target.positions;
    const i = this.cursor;
    if (src instanceof Float32Array) {
      p.set(src.subarray(start, start + count), i);
    } else {
      for (let k = 0; k < count; k++) p[i + k] = src[start + k];
    }
    this.cursor += count;
    return this;
  }
}

/** @internal A fixed-size target for the one-shot `*ToSegments` builders. */
export const createArrayWriteTarget = (segmentCount: number): LineWriteTarget => {
  const positions = new Float32Array(segmentCount * FLOATS_PER_SEGMENT);
  return { positions, reserve: (floatCount) => floatCount <= positions.length };
};
