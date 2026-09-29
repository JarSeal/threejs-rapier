/**
 * The day-night cycle's time model (p113): the runtime time of day and moon phase, and the sun's
 * and moon's directions from them. CPU only, plain scalar maths into caller-owned vectors:
 * nothing here allocates on the per-frame path.
 *
 * The celestial model is plausible, not exact (no equation of time, no refraction):
 * - the sun's ecliptic longitude: `λ = 2π (dayOfYear − 81) / 365`, its declination
 *   `δ = axialTilt · sin λ`
 * - its hour angle: `H = 2π (timeOfDay − 12) / 24` (noon: the sun on the meridian)
 * - the moon is `2π · phase` further along: hour angle `H − 2π · phase`, declination
 *   `(axialTilt + inclination) · sin(λ + 2π · phase)` (its orbit's node fixed where that tilt
 *   adds to the Earth's). So a full moon rises as the sun sets, low in summer and high in winter.
 * - the standard latitude formula into east/north/up, then into world space with +y up and
 *   north at -z, turned clockwise (seen from above) by northOffset.
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
  /** moons[0]'s phase, [0, 1): its definition's, advanced by the cycle in 'CYCLE' mode. */
  moonPhase: number;
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
  state.moonPhase = wrap1(def.moons?.[0]?.phase ?? MOON_TIME_DEFAULTS.phase);
  state.isDirty = true;
  return state;
};

export const createSkyTimeState = (def: SkyBoxDef): SkyTimeState =>
  resetSkyTimeState(
    { timeOfDay: 0, speed: 0, cycleDurationSec: 1, playing: false, moonPhase: 0, isDirty: true },
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

/** Sets the running moon phase (a definition change of moons[0].phase). */
export const setSkyTimeMoonPhase = (state: SkyTimeState, phase: number) => {
  state.moonPhase = wrap1(phase);
  state.isDirty = true;
};

/**
 * Advances the time by `dtSec` real seconds: `timeOfDay += dt · speed · 24 / cycleDurationSec`,
 * and a 'CYCLE' moon's phase by `1 / lunarCycleDays` per in-game day.
 * @returns whether the time moved
 */
export const advanceSkyTime = (state: SkyTimeState, dtSec: number, def: SkyBoxDef) => {
  if (!state.playing || dtSec === 0 || state.speed === 0) return false;
  const hours = (dtSec * state.speed * 24) / state.cycleDurationSec;
  state.timeOfDay = wrap24(state.timeOfDay + hours);
  const moon = def.moons?.[0];
  if (moon && (moon.phaseMode ?? MOON_TIME_DEFAULTS.phaseMode) === 'CYCLE') {
    const cycleDays = moon.lunarCycleDays ?? MOON_TIME_DEFAULTS.lunarCycleDays;
    state.moonPhase = wrap1(state.moonPhase + hours / 24 / cycleDays);
  }
  return true;
};

/** The phase moons[0] shows: the running one with day-night, else its definition's. */
export const getMoonPhaseOf = (def: SkyBoxDef, state: SkyTimeState, isDayNight: boolean) =>
  isDayNight ? state.moonPhase : wrap1(def.moons?.[0]?.phase ?? MOON_TIME_DEFAULTS.phase);

/**
 * A unit world direction from equatorial coordinates: an hour angle and a declination (radians)
 * seen from a latitude (radians), with north turned by northOffset (radians, clockwise from -z
 * seen from above), into `out`.
 */
const setFromEquatorial = (
  hourAngle: number,
  declination: number,
  latitude: number,
  northOffset: number,
  out: THREE.Vector3
) => {
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const cosH = Math.cos(hourAngle);
  const up = sinLat * sinDec + cosLat * cosDec * cosH;
  const east = -cosDec * Math.sin(hourAngle);
  const north = cosLat * sinDec - sinLat * cosDec * cosH;
  // North is (sin o, 0, -cos o) and east (cos o, 0, sin o)
  const sinO = Math.sin(northOffset);
  const cosO = Math.cos(northOffset);
  return out.set(north * sinO + east * cosO, up, east * sinO - north * cosO);
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
