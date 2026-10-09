import * as THREE from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import {
  advanceSkyTime,
  computeMoonDirection,
  computeSkyRotation,
  computeSunDirection,
  createSkyTimeState,
  DAY_NIGHT_DEFAULTS,
  turnWithSky,
  wrap24,
} from './SkyTime';
import type { SkyBoxDayNightDef, SkyBoxDef } from './SkyBoxTypes';

const DEG = Math.PI / 180;
const EPS = 1e-9;

/** The unit direction at an elevation and an azimuth (degrees, clockwise from north), with north
 * at -z and east at +x (northOffset 0) */
const fromElevationAzimuth = (elevation: number, azimuth: number) => {
  const cosEl = Math.cos(elevation * DEG);
  return new THREE.Vector3(
    cosEl * Math.sin(azimuth * DEG),
    Math.sin(elevation * DEG),
    -cosEl * Math.cos(azimuth * DEG)
  );
};

const expectVec = (actual: THREE.Vector3, expected: THREE.Vector3, eps = EPS) => {
  expect(actual.distanceTo(expected)).toBeLessThan(eps);
};

const sun = (def: SkyBoxDayNightDef | undefined, timeOfDay: number) =>
  computeSunDirection(def, timeOfDay, new THREE.Vector3());

// dayOfYear 81: the sun's longitude is 0, so its declination is 0
const EQUINOX = { dayOfYear: 81 } as SkyBoxDayNightDef;

describe('wrap24', () => {
  test.each([
    [0, 0],
    [25, 1],
    [-1, 23],
    [48, 0],
    [-1e-17, 0],
  ])('%s → %s', (hours, expected) => {
    expect(wrap24(hours)).toBeCloseTo(expected, 12);
    expect(wrap24(hours)).toBeLessThan(24);
  });
});

describe('sun direction', () => {
  test('equinox at the equator: overhead at noon, due east at 6:00, due west at 18:00', () => {
    const def = { ...EQUINOX, latitude: 0 } as SkyBoxDayNightDef;
    expectVec(sun(def, 12), new THREE.Vector3(0, 1, 0));
    expectVec(sun(def, 6), new THREE.Vector3(1, 0, 0));
    expectVec(sun(def, 18), new THREE.Vector3(-1, 0, 0));
    expectVec(sun(def, 0), new THREE.Vector3(0, -1, 0));
  });

  test('equinox at 45°N: 45° up due south at noon, rising due east', () => {
    const def = { ...EQUINOX, latitude: 45 } as SkyBoxDayNightDef;
    expectVec(sun(def, 12), fromElevationAzimuth(45, 180));
    expectVec(sun(def, 6), fromElevationAzimuth(0, 90));
  });

  test('the defaults (45°N, the June solstice): 90 - 45 + δ up at noon, below by 45 - δ at midnight', () => {
    // dayOfYear 172 is 91 days past the equinox, so δ = tilt · sin(2π · 91 / 365)
    const declination = DAY_NIGHT_DEFAULTS.axialTilt * Math.sin((2 * Math.PI * (172 - 81)) / 365);
    expectVec(sun(undefined, 12), fromElevationAzimuth(90 - 45 + declination, 180));
    expectVec(sun(undefined, 0), fromElevationAzimuth(-(45 - declination), 0));
    // Summer: up before 6:00, in the north-east
    const sixAm = sun(undefined, 6);
    expect(sixAm.y).toBeGreaterThan(0);
    expect(sixAm.x).toBeGreaterThan(0);
  });

  test('northOffset turns north clockwise seen from above', () => {
    const def = { ...EQUINOX, latitude: 45, northOffset: 90 } as SkyBoxDayNightDef;
    // North is +x, so the noon sun (south) is at -x
    expectVec(sun(def, 12), new THREE.Vector3(-Math.SQRT1_2, Math.SQRT1_2, 0));
  });

  test('always a unit vector', () => {
    for (let t = 0; t < 24; t += 0.7) expect(sun(undefined, t).length()).toBeCloseTo(1, 12);
  });
});

describe('moon direction', () => {
  test('a new moon without inclination is where the sun is', () => {
    const moon = { inclination: 0 } as Parameters<typeof computeMoonDirection>[1];
    const out = new THREE.Vector3();
    for (let t = 0; t < 24; t += 1.5) {
      expectVec(computeMoonDirection(undefined, moon, t, 0, out), sun(undefined, t));
    }
  });

  test('a full moon is on the meridian at midnight, low in summer', () => {
    const out = computeMoonDirection(undefined, undefined, 0, 0.5, new THREE.Vector3());
    // Opposite the sun's longitude, so its declination is -(tilt + 5°) · sin λ
    const declination =
      -(DAY_NIGHT_DEFAULTS.axialTilt + 5) * Math.sin((2 * Math.PI * (172 - 81)) / 365);
    expectVec(out, fromElevationAzimuth(90 - 45 + declination, 180));
  });
});

describe('sky rotation', () => {
  // Determinant -1: the hour frame (x the meridian, y west, z the pole) is left-handed against
  // the world's right-handed axes. turnWithSky multiplies two of these, a proper rotation.
  test('is orthonormal, with the hour frame’s handedness (determinant -1)', () => {
    const m = new THREE.Matrix3();
    const product = new THREE.Matrix3();
    for (const t of [0, 5.5, 12, 23.9]) {
      computeSkyRotation(undefined, t, m);
      expect(m.determinant()).toBeCloseTo(-1, 12);
      product.copy(m).multiply(m.clone().transpose());
      product.elements.forEach((value, i) => expect(value).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12));
    }
  });

  test('the sun stays put in the star frame: turning its direction with the sky lands on it', () => {
    const out = new THREE.Vector3();
    for (const [from, to] of [
      [6, 9],
      [12, 23],
      [20, 3],
    ]) {
      expectVec(turnWithSky(undefined, sun(undefined, from), from, to, out), sun(undefined, to));
    }
  });

  test('the celestial pole stays still, and a full day turns back to the start', () => {
    // At 45°N the pole is 45° up due north
    const pole = fromElevationAzimuth(45, 0);
    const out = new THREE.Vector3();
    expectVec(turnWithSky(undefined, pole, 3, 17, out), pole);

    const dir = new THREE.Vector3(0.2, 0.5, -0.8).normalize();
    expectVec(turnWithSky(undefined, dir, 8, 32, out), dir);
  });
});

describe('advanceSkyTime', () => {
  const def = {
    dayNight: { timeOfDay: 23, cycleDurationSec: 1200 },
    moons: [{ phase: 0.25, phaseMode: 'CYCLE', lunarCycleDays: 30 }, { phase: 0.5 }],
  } as SkyBoxDef;

  test('moves cycleDurationSec / 24 seconds per hour, wraps past midnight', () => {
    const state = createSkyTimeState(def);
    expect(advanceSkyTime(state, 100, def)).toBe(true);
    expect(state.timeOfDay).toBeCloseTo(1, 12);
  });

  test('advances only CYCLE moons, by 1 / lunarCycleDays per in-game day', () => {
    const state = createSkyTimeState(def);
    advanceSkyTime(state, 1200 * 3, def);
    expect(state.moonPhases[0]).toBeCloseTo(0.25 + 3 / 30, 12);
    expect(state.moonPhases[1]).toBe(0.5);
  });

  test('does nothing while paused or at speed 0', () => {
    const state = createSkyTimeState(def);
    state.playing = false;
    expect(advanceSkyTime(state, 100, def)).toBe(false);
    state.playing = true;
    state.speed = 0;
    expect(advanceSkyTime(state, 100, def)).toBe(false);
    expect(state.timeOfDay).toBe(23);
  });

  test('a negative speed runs it backwards', () => {
    const state = createSkyTimeState(def);
    state.speed = -2;
    advanceSkyTime(state, 50, def);
    expect(state.timeOfDay).toBeCloseTo(21, 12);
  });
});
