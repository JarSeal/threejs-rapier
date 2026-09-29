/**
 * The day-night cycle's time model (p113): the runtime time of day, and the sun's direction
 * from it. CPU only, plain scalar maths into caller-owned vectors: nothing here allocates on the
 * per-frame path.
 *
 * The celestial model is plausible, not exact (no equation of time, no refraction):
 * - declination: `δ = axialTilt · sin(2π (dayOfYear − 81) / 365)`
 * - hour angle: `H = 2π (timeOfDay − 12) / 24` (noon: the sun on the meridian)
 * - the standard latitude formula into east/north/up, then into world space with +y up and
 *   north at -z, turned clockwise (seen from above) by northOffset.
 */
import * as THREE from 'three/webgpu';
import type { SkyBoxDayNightDef, SkyTimeSource } from './SkyBoxTypes';

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

/** Sets the runtime state to the definition's start values (activation, or day-night turned on). */
export const resetSkyTimeState = (state: SkyTimeState, def: SkyBoxDayNightDef | undefined) => {
  state.timeOfDay = wrap24(def?.timeOfDay ?? DAY_NIGHT_DEFAULTS.timeOfDay);
  state.speed = def?.speed ?? DAY_NIGHT_DEFAULTS.speed;
  state.cycleDurationSec = def?.cycleDurationSec ?? DAY_NIGHT_DEFAULTS.cycleDurationSec;
  state.playing = def?.playing ?? DAY_NIGHT_DEFAULTS.playing;
  state.isDirty = true;
  return state;
};

export const createSkyTimeState = (def: SkyBoxDayNightDef | undefined): SkyTimeState =>
  resetSkyTimeState(
    { timeOfDay: 0, speed: 0, cycleDurationSec: 1, playing: false, isDirty: true },
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

/**
 * Advances the time by `dtSec` real seconds: `timeOfDay += dt · speed · 24 / cycleDurationSec`.
 * @returns whether the time moved
 */
export const advanceSkyTime = (state: SkyTimeState, dtSec: number) => {
  if (!state.playing || dtSec === 0 || state.speed === 0) return false;
  state.timeOfDay = wrap24(state.timeOfDay + (dtSec * state.speed * 24) / state.cycleDurationSec);
  return true;
};

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

/** The sun's declination (radians) on the definition's day of the year. */
const getSunDeclination = (def: SkyBoxDayNightDef | undefined) => {
  const tilt = (def?.axialTilt ?? DAY_NIGHT_DEFAULTS.axialTilt) * DEG_TO_RAD;
  const day = def?.dayOfYear ?? DAY_NIGHT_DEFAULTS.dayOfYear;
  return tilt * Math.sin((TWO_PI * (day - 81)) / 365);
};

/** The sun's hour angle (radians) at a time of day: 0 at noon, growing through the afternoon. */
const getSunHourAngle = (timeOfDay: number) => (TWO_PI * (timeOfDay - 12)) / 24;

/** The sun's unit world direction at `timeOfDay` (hours), into `out`. */
export const computeSunDirection = (
  def: SkyBoxDayNightDef | undefined,
  timeOfDay: number,
  out: THREE.Vector3
) =>
  setFromEquatorial(
    getSunHourAngle(timeOfDay),
    getSunDeclination(def),
    (def?.latitude ?? DAY_NIGHT_DEFAULTS.latitude) * DEG_TO_RAD,
    (def?.northOffset ?? DAY_NIGHT_DEFAULTS.northOffset) * DEG_TO_RAD,
    out
  );
