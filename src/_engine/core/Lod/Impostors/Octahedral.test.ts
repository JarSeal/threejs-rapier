import * as THREE from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import {
  decodeOctahedral,
  encodeOctahedral,
  FRAME_POLE_Y,
  getOctahedralFrameBasis,
  getOctahedralFrameCoord,
  getOctahedralFrameDirection,
} from './Octahedral';

const EPS = 1e-9;

// A fixed spread of directions: a Fibonacci sphere, plus the axes and the octants' diagonals
const directions = (() => {
  const dirs: THREE.Vector3[] = [];
  const n = 200;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    dirs.push(new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r));
  }
  for (const v of [-1, 0, 1]) {
    for (const w of [-1, 0, 1]) {
      for (const u of [-1, 0, 1]) {
        if (u || v || w) dirs.push(new THREE.Vector3(u, v, w).normalize());
      }
    }
  }
  return dirs;
})();

const expectVec = (actual: THREE.Vector3, expected: THREE.Vector3, eps = EPS) => {
  expect(actual.distanceTo(expected)).toBeLessThan(eps);
};

describe('full map', () => {
  test('decode(encode(d)) = d over the sphere', () => {
    const uv = new THREE.Vector2();
    const out = new THREE.Vector3();
    for (const dir of directions) {
      encodeOctahedral(dir.x, dir.y, dir.z, false, uv);
      expect(Math.abs(uv.x)).toBeLessThanOrEqual(1 + EPS);
      expect(Math.abs(uv.y)).toBeLessThanOrEqual(1 + EPS);
      expectVec(decodeOctahedral(uv.x, uv.y, false, out), dir);
    }
  });

  test('+y at the centre, the equator on the diamond, -y at the corners', () => {
    const uv = new THREE.Vector2();
    const out = new THREE.Vector3();
    expect(encodeOctahedral(0, 1, 0, false, uv).toArray()).toEqual([0, 0]);
    encodeOctahedral(1, 0, 0, false, uv);
    expect(Math.abs(uv.x) + Math.abs(uv.y)).toBeCloseTo(1, 12);
    for (const [u, v] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      expectVec(decodeOctahedral(u, v, false, out), new THREE.Vector3(0, -1, 0));
    }
  });

  test('length doesn’t matter', () => {
    const a = encodeOctahedral(0.3, -0.5, 0.8, false, new THREE.Vector2());
    const b = encodeOctahedral(3, -5, 8, false, new THREE.Vector2());
    expect(a.distanceTo(b)).toBeLessThan(EPS);
  });
});

describe('hemi map', () => {
  test('decode(encode(d)) = d over the upper hemisphere', () => {
    const uv = new THREE.Vector2();
    const out = new THREE.Vector3();
    for (const dir of directions.filter((d) => d.y >= 0)) {
      encodeOctahedral(dir.x, dir.y, dir.z, true, uv);
      expect(Math.abs(uv.x)).toBeLessThanOrEqual(1 + EPS);
      expect(Math.abs(uv.y)).toBeLessThanOrEqual(1 + EPS);
      expectVec(decodeOctahedral(uv.x, uv.y, true, out), dir);
    }
  });

  test('below the horizon clamps onto it, keeping the heading', () => {
    const uv = new THREE.Vector2();
    const out = new THREE.Vector3();
    for (const dir of directions.filter((d) => d.y < 0 && (d.x || d.z))) {
      encodeOctahedral(dir.x, dir.y, dir.z, true, uv);
      expect(Math.max(Math.abs(uv.x), Math.abs(uv.y))).toBeCloseTo(1, 9);
      expectVec(
        decodeOctahedral(uv.x, uv.y, true, out),
        new THREE.Vector3(dir.x, 0, dir.z).normalize()
      );
    }
  });

  test('+y at the centre, the horizon on the square’s edge', () => {
    const uv = new THREE.Vector2();
    expect(encodeOctahedral(0, 1, 0, true, uv).toArray()).toEqual([0, 0]);
    expect(encodeOctahedral(1, 0, 0, true, uv).toArray()).toEqual([1, 1]);
    expect(encodeOctahedral(0, 0, 1, true, uv).toArray()).toEqual([1, -1]);
  });
});

describe('frames', () => {
  test('the grid’s first and last frames sit on the square’s edges', () => {
    expect(getOctahedralFrameCoord(0, 12)).toBe(-1);
    expect(getOctahedralFrameCoord(11, 12)).toBe(1);
    expect(getOctahedralFrameCoord(6, 13)).toBe(0);
  });

  test('an odd grid’s centre frame looks straight down from +y', () => {
    for (const hemi of [false, true]) {
      const dir = getOctahedralFrameDirection(6, 6, 13, hemi, new THREE.Vector3());
      expectVec(dir, new THREE.Vector3(0, 1, 0));
    }
  });

  test.each([false, true])(
    'every frame basis is orthonormal and right-handed (hemi: %s)',
    (hemi) => {
      const frames = 12;
      const dir = new THREE.Vector3();
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      const cross = new THREE.Vector3();
      for (let i = 0; i < frames; i++) {
        for (let j = 0; j < frames; j++) {
          getOctahedralFrameDirection(i, j, frames, hemi, dir);
          expect(dir.length()).toBeCloseTo(1, 12);
          getOctahedralFrameBasis(dir, right, up);
          expect(right.length()).toBeCloseTo(1, 9);
          expect(up.length()).toBeCloseTo(1, 9);
          expect(right.dot(up)).toBeCloseTo(0, 9);
          expect(right.dot(dir)).toBeCloseTo(0, 9);
          expectVec(cross.crossVectors(right, up), dir, 1e-9);
        }
      }
    }
  );

  test('up is +y projected onto the image, and -z within FRAME_POLE_Y of a pole', () => {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();

    getOctahedralFrameBasis(new THREE.Vector3(0, 0, 1), right, up);
    expectVec(up, new THREE.Vector3(0, 1, 0));
    expectVec(right, new THREE.Vector3(1, 0, 0));

    for (const y of [1, -1]) {
      getOctahedralFrameBasis(new THREE.Vector3(0, y, 0), right, up);
      expectVec(up, new THREE.Vector3(0, 0, -1));
    }

    // Just outside the pole cone the up reference is still +y
    const nearPole = new THREE.Vector3(Math.sqrt(1 - FRAME_POLE_Y ** 2), FRAME_POLE_Y, 0);
    getOctahedralFrameBasis(nearPole, right, up);
    expect(up.y).toBeGreaterThan(0);
  });
});
