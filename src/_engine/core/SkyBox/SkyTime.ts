/**
 * The day-night cycle's time model (p113): the runtime time of day and moon phase, and the sun's
 * and moon's directions from them. CPU only, plain scalar maths into caller-owned vectors:
 * nothing here allocates on the per-frame path.
 *
 * The celestial model is plausible, not exact (no equation of time, no refraction):
 * - the sun's ecliptic longitude: `λ = 2π (dayOfYear − 81) / 365`, its declination
 *   `δ = axialTilt · sin λ`
 * - its hour angle: `H = 2π (timeOfDay − 12) / 24` (noon: the sun on the meridian)
 * - a moon is `2π · phase` further along: hour angle `H − 2π · phase`, declination
 *   `(axialTilt + inclination) · sin(λ + 2π · phase)` (its orbit's node fixed where that tilt
 *   adds to the Earth's). So a full moon rises as the sun sets, low in summer and high in winter.
 *   Each moon has its own phase (and phase mode, cycle length and inclination): p114's second
 *   moon is a second orbit.
 * - the standard latitude formula into east/north/up, then into world space with +y up and
 *   north at -z, turned clockwise (seen from above) by northOffset.
 * - the stars sit still in their own frame, which turns into world space by the local sidereal
 *   time (`H + λ`: the sun's hour angle plus its right ascension, taken as its longitude), so
 *   a star where the sun is stays with the sun.
 * - the extra suns (p114) that turn with the sky stand at their elevation and azimuth at the
 *   start time, and turn by the sidereal time from there (turnWithSky).
 */
import * as THREE from 'three/webgpu';
import type { SkyBoxDayNightDef, SkyBoxDef, SkyBoxMoonDef, SkyTimeSource } from './SkyBoxTypes';

export const DAY_NIGHT_DEFAULTS = {
  enabled: true,
  timeOfDay: 12,
  cycleDurationSec: 1200,
  speed: 1,
  playing: true,
  timeSource: 'APP' as SkyTimeSource,
  latitude: 45,
  dayOfYear: 172,
  axialTilt: 23.44,
  northOffset: 0,
};

/** How many moons a sky box draws (moons[0..1]; layers/moon.ts re-exports it). Here, not in
 * layers/moon.ts: that module imports this one at load. */
export const MAX_MOONS = 2;

/** The moon's time-related values (the rest of its defaults are in layers/moon.ts). */
export const MOON_TIME_DEFAULTS = {
  phase: 0.5,
  phaseMode: 'FIXED' as 'FIXED' | 'CYCLE',
  lunarCycleDays: 29.53,
  inclination: 5,
};

const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/**
 * The runtime day-night state (on ActiveSkyBox). Games drive it through the SkyBox.ts API; it's
 * never written to the definition, so driving time writes no debug overrides.
 */
export type SkyTimeState = {
  /** Hours, [0, 24). */
  timeOfDay: number;
  /** Time multiplier: negative runs it backwards, 0 freezes it. */
  speed: number;
  /** Real seconds per 24 in-game hours. */
  cycleDurationSec: number;
  playing: boolean;
  /** Each moon's phase (MAX_MOONS entries), [0, 1): its definition's, advanced by the cycle in
   * 'CYCLE' mode. */
  moonPhases: number[];
  /** Set by any time change outside the per-frame step (eg. setTimeOfDay): the next
   * skyBoxSystem tick writes the uniforms and lights. */
  isDirty: boolean;
};

/** Hours wrapped into [0, 24). */
export const wrap24 = (hours: number) => {
  const wrapped = ((hours % 24) + 24) % 24;
  // -1e-17 % 24 + 24 is 24 in floating point
  return wrapped >= 24 ? 0 : wrapped;
};

/** A phase wrapped into [0, 1). */
const wrap1 = (phase: number) => {
  const wrapped = ((phase % 1) + 1) % 1;
  return wrapped >= 1 ? 0 : wrapped;
};

/** Sets the runtime state to the definition's start values (activation, or day-night turned on). */
export const resetSkyTimeState = (state: SkyTimeState, def: SkyBoxDef) => {
  const dayNight = def.dayNight;
  state.timeOfDay = wrap24(dayNight?.timeOfDay ?? DAY_NIGHT_DEFAULTS.timeOfDay);
  state.speed = dayNight?.speed ?? DAY_NIGHT_DEFAULTS.speed;
  state.cycleDurationSec = dayNight?.cycleDurationSec ?? DAY_NIGHT_DEFAULTS.cycleDurationSec;
  state.playing = dayNight?.playing ?? DAY_NIGHT_DEFAULTS.playing;
  for (let i = 0; i < MAX_MOONS; i++) {
    state.moonPhases[i] = wrap1(def.moons?.[i]?.phase ?? MOON_TIME_DEFAULTS.phase);
  }
  state.isDirty = true;
  return state;
};

export const createSkyTimeState = (def: SkyBoxDef): SkyTimeState =>
  resetSkyTimeState(
    {
      timeOfDay: 0,
      speed: 0,
      cycleDurationSec: 1,
      playing: false,
      moonPhases: new Array<number>(MAX_MOONS).fill(0),
      isDirty: true,
    },
    def
  );

/** Applies the runtime keys a definition change sets (the others only change the maths). */
export const applyDayNightChange = (state: SkyTimeState, change: Partial<SkyBoxDayNightDef>) => {
  if (change.timeOfDay !== undefined) state.timeOfDay = wrap24(change.timeOfDay);
  if (change.speed !== undefined) state.speed = change.speed;
  if (change.cycleDurationSec !== undefined) state.cycleDurationSec = change.cycleDurationSec;
  if (change.playing !== undefined) state.playing = change.playing;
  state.isDirty = true;
};

/** Sets a moon's running phase (a definition change of its phase). */
export const setSkyTimeMoonPhase = (state: SkyTimeState, index: number, phase: number) => {
  state.moonPhases[index] = wrap1(phase);
  state.isDirty = true;
};

/**
 * Advances the time by `dtSec` real seconds: `timeOfDay += dt · speed · 24 / cycleDurationSec`,
 * and each 'CYCLE' moon's phase by `1 / lunarCycleDays` per in-game day.
 * @returns whether the time moved
 */
export const advanceSkyTime = (state: SkyTimeState, dtSec: number, def: SkyBoxDef) => {
  if (!state.playing || dtSec === 0 || state.speed === 0) return false;
  const hours = (dtSec * state.speed * 24) / state.cycleDurationSec;
  state.timeOfDay = wrap24(state.timeOfDay + hours);
  const moonCount = Math.min(def.moons?.length ?? 0, MAX_MOONS);
  for (let i = 0; i < moonCount; i++) {
    const moon = def.moons![i];
    if ((moon.phaseMode ?? MOON_TIME_DEFAULTS.phaseMode) !== 'CYCLE') continue;
    const cycleDays = moon.lunarCycleDays ?? MOON_TIME_DEFAULTS.lunarCycleDays;
    state.moonPhases[i] = wrap1(state.moonPhases[i] + hours / 24 / cycleDays);
  }
  return true;
};

/** The phase a moon shows: the running one with day-night, else its definition's. */
export const getMoonPhaseOf = (
  def: SkyBoxDef,
  state: SkyTimeState,
  isDayNight: boolean,
  index = 0
) =>
  isDayNight
    ? state.moonPhases[index] ?? 0
    : wrap1(def.moons?.[index]?.phase ?? MOON_TIME_DEFAULTS.phase);

/**
 * A vector in the hour-angle frame (x toward the meridian on the celestial equator, y 90° west
 * of it, z the celestial pole) into world space, seen from a latitude (radians), with north
 * turned by northOffset (radians, clockwise from -z seen from above), into `out`.
 */
const hourFrameToWorld = (
  hx: number,
  hy: number,
  hz: number,
  latitude: number,
  northOffset: number,
  out: THREE.Vector3
) => {
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const up = sinLat * hz + cosLat * hx;
  const east = -hy;
  const north = cosLat * hz - sinLat * hx;
  // North is (sin o, 0, -cos o) and east (cos o, 0, sin o)
  const sinO = Math.sin(northOffset);
  const cosO = Math.cos(northOffset);
  return out.set(north * sinO + east * cosO, up, east * sinO - north * cosO);
};

/** A unit world direction from an hour angle and a declination (radians), into `out`. */
const setFromEquatorial = (
  hourAngle: number,
  declination: number,
  latitude: number,
  northOffset: number,
  out: THREE.Vector3
) => {
  const cosDec = Math.cos(declination);
  return hourFrameToWorld(
    cosDec * Math.cos(hourAngle),
    cosDec * Math.sin(hourAngle),
    Math.sin(declination),
    latitude,
    northOffset,
    out
  );
};

/** The sun's ecliptic longitude (radians) on the definition's day of the year. */
const getSunLongitude = (def: SkyBoxDayNightDef | undefined) =>
  (TWO_PI * ((def?.dayOfYear ?? DAY_NIGHT_DEFAULTS.dayOfYear) - 81)) / 365;

const getAxialTilt = (def: SkyBoxDayNightDef | undefined) =>
  (def?.axialTilt ?? DAY_NIGHT_DEFAULTS.axialTilt) * DEG_TO_RAD;

/** The sun's hour angle (radians) at a time of day: 0 at noon, growing through the afternoon. */
const getSunHourAngle = (timeOfDay: number) => (TWO_PI * (timeOfDay - 12)) / 24;

const getLatitude = (def: SkyBoxDayNightDef | undefined) =>
  (def?.latitude ?? DAY_NIGHT_DEFAULTS.latitude) * DEG_TO_RAD;

const getNorthOffset = (def: SkyBoxDayNightDef | undefined) =>
  (def?.northOffset ?? DAY_NIGHT_DEFAULTS.northOffset) * DEG_TO_RAD;

/** The sun's unit world direction at `timeOfDay` (hours), into `out`. */
export const computeSunDirection = (
  def: SkyBoxDayNightDef | undefined,
  timeOfDay: number,
  out: THREE.Vector3
) =>
  setFromEquatorial(
    getSunHourAngle(timeOfDay),
    getAxialTilt(def) * Math.sin(getSunLongitude(def)),
    getLatitude(def),
    getNorthOffset(def),
    out
  );

/** The moon's unit world direction at `timeOfDay` (hours) and `phase`, into `out`. */
export const computeMoonDirection = (
  def: SkyBoxDayNightDef | undefined,
  moon: SkyBoxMoonDef | undefined,
  timeOfDay: number,
  phase: number,
  out: THREE.Vector3
) => {
  const elongation = TWO_PI * phase;
  const inclination = (moon?.inclination ?? MOON_TIME_DEFAULTS.inclination) * DEG_TO_RAD;
  return setFromEquatorial(
    getSunHourAngle(timeOfDay) - elongation,
    (getAxialTilt(def) + inclination) * Math.sin(getSunLongitude(def) + elongation),
    getLatitude(def),
    getNorthOffset(def),
    out
  );
};

const _column0 = new THREE.Vector3();
const _column1 = new THREE.Vector3();
const _column2 = new THREE.Vector3();

/**
 * The stars' lookup rotation at `timeOfDay`: world direction → star frame, into `out` (the
 * transpose of the star frame's turn into world space by the local sidereal time). A star at
 * right ascension α and declination δ sits at `(cos δ cos α, −cos δ sin α, sin δ)` in that
 * frame.
 */
export const computeSkyRotation = (
  def: SkyBoxDayNightDef | undefined,
  timeOfDay: number,
  out: THREE.Matrix3
) => {
  const siderealTime = getSunHourAngle(timeOfDay) + getSunLongitude(def);
  const cosT = Math.cos(siderealTime);
  const sinT = Math.sin(siderealTime);
  const latitude = getLatitude(def);
  const northOffset = getNorthOffset(def);
  // The star frame's axes in world space: the hour frame turned about the pole by the time
  const c0 = hourFrameToWorld(cosT, sinT, 0, latitude, northOffset, _column0);
  const c1 = hourFrameToWorld(-sinT, cosT, 0, latitude, northOffset, _column1);
  const c2 = hourFrameToWorld(0, 0, 1, latitude, northOffset, _column2);
  // Rows are those axes: the transpose, world → star frame
  return out.set(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z);
};

const _fromRotation = new THREE.Matrix3();
const _toRotation = new THREE.Matrix3();

/**
 * A world direction turned with the sky from one time of day to another (about the celestial
 * pole, by the change in sidereal time), into `out` (may be `direction`). An extra sun that
 * turns with the sky is its start-time direction turned to now; the debugger turns the view
 * direction back to the start time to place one there. Allocates nothing.
 */
export const turnWithSky = (
  def: SkyBoxDayNightDef | undefined,
  direction: THREE.Vector3,
  fromTimeOfDay: number,
  toTimeOfDay: number,
  out: THREE.Vector3
) => {
  // Into the star frame at `from`, back out of it at `to` (the transpose: out of the frame)
  computeSkyRotation(def, fromTimeOfDay, _fromRotation);
  computeSkyRotation(def, toTimeOfDay, _toRotation).transpose();
  return out.copy(direction).applyMatrix3(_fromRotation).applyMatrix3(_toRotation);
};

/** The day-night start time (hours), from which the extra suns turn with the sky. */
export const getDayNightStartTime = (def: SkyBoxDayNightDef | undefined) =>
  wrap24(def?.timeOfDay ?? DAY_NIGHT_DEFAULTS.timeOfDay);
