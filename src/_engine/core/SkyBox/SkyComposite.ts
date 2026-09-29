import type * as THREE from 'three/webgpu';
import type { SkyBoxDef } from './SkyBoxTypes';
import {
  applyBaseUniforms,
  baseNode,
  createBaseUniforms,
  ENV_DEFAULTS,
  type BaseUniforms,
} from './layers/base';
import {
  applyAtmosphereSunUniforms,
  applyAtmosphereUniforms,
  atmosphereParts,
  atmosphereTerms,
  composeAtmosphere,
  createAtmosphereUniforms,
  type AtmosphereUniforms,
} from './layers/atmosphere';
import {
  applyCloudsMoonUniforms,
  applyCloudsSunUniforms,
  applyCloudsUniforms,
  cloudsNode,
  createCloudsUniforms,
  type CloudsUniforms,
} from './layers/clouds';
import {
  applyGroundSunUniforms,
  applyGroundUniforms,
  createGroundUniforms,
  groundNode,
  type GroundUniforms,
} from './layers/ground';
import {
  applySunLightingUniforms,
  applySunUniforms,
  createSunUniforms,
  getFixedSunDirection,
  sunNode,
  type SunUniforms,
} from './layers/sun';
import {
  applyMoonPositionUniforms,
  applyMoonUniforms,
  createMoonUniforms,
  getFixedMoonDirection,
  moonNode,
  type MoonUniforms,
} from './layers/moon';
import {
  computeMoonDirection,
  computeSunDirection,
  getMoonPhaseOf,
  type SkyTimeState,
} from './SkyTime';

/**
 * The composite path: every layer of a sky box composited into one node, used as the
 * background (VIEW) and as what the env bake renders (ENV_BAKE). A sky box uses it whenever a
 * procedural layer is enabled; a texture-only or colour-only one keeps the direct path
 * (buildBaseLayer), which needs no bake.
 *
 * Layer order, back to front (p110 "Composite order"): base, space layers (p113/p114), discs,
 * atmosphere, clouds, ground. Each layer takes the colour behind it and returns the new colour;
 * an absent or disabled layer is left out of the graph (changing which layers exist is a
 * rebuild, anything else is a uniform write).
 */

/** VIEW: the background the camera sees. ENV_BAKE: what the environment is baked from (a
 * wider, clamped sun disc, no disc where a sun or moon light gives the specular, frozen
 * clouds; later also no stars). */
export type SkyCompositeMode = 'VIEW' | 'ENV_BAKE';

/** Every layer's uniforms, created once per activation (whether the layer is on or not, so
 * turning one on only rebuilds nodes) and shared by both modes' nodes. */
export type SkyUniforms = {
  base: BaseUniforms;
  sun: SunUniforms;
  moon: MoonUniforms;
  atmosphere: AtmosphereUniforms;
  clouds: CloudsUniforms;
  ground: GroundUniforms;
};

/** What the composite samples that isn't a uniform. */
export type SkyCompositeSources = {
  /** The base texture's PMREM (getPMREMTexture), null for a COLOR base or a failed load. */
  basePMREM: THREE.Texture | null;
  /** moons[0]'s texture, null without one or on a failed load. */
  moonTexture: THREE.Texture | null;
};

/** A procedural layer is on when its key is there, unless it says `enabled: false`. */
export const isOn = (layer: { enabled?: boolean } | undefined) =>
  Boolean(layer && layer.enabled !== false);

export const isAtmosphereEnabled = (def: SkyBoxDef) => isOn(def.atmosphere);
/** suns[0]'s disc (its direction drives the atmosphere either way). */
export const isSunEnabled = (def: SkyBoxDef) => isOn(def.suns?.[0]);
/** Whether suns[0] has a light: then the env bake leaves its disc out (the light gives that
 * highlight already). */
export const isSunLightEnabled = (def: SkyBoxDef) => isOn(def.suns?.[0]?.light);
/** moons[0]'s disc. */
export const isMoonEnabled = (def: SkyBoxDef) => isOn(def.moons?.[0]);
/** Whether moons[0] has a light: then the env bake leaves its disc out. */
export const isMoonLightEnabled = (def: SkyBoxDef) => isOn(def.moons?.[0]?.light);
/** Clouds need the atmosphere (the schema rejects them without one). */
export const isCloudsEnabled = (def: SkyBoxDef) => isOn(def.clouds) && isAtmosphereEnabled(def);
export const isGroundEnabled = (def: SkyBoxDef) => isOn(def.ground);
/** While on, suns[0]'s and moons[0]'s directions come from the time of day (SkyTime.ts). */
export const isDayNightEnabled = (def: SkyBoxDef | undefined) => isOn(def?.dayNight);

/** The env bake's size: 256 by default, 128 with day-night (it re-bakes as the sun moves). */
export const getEnvSize = (def: SkyBoxDef | undefined) =>
  def?.env?.size ?? (isDayNightEnabled(def) ? DAY_NIGHT_ENV_SIZE : ENV_DEFAULTS.size);
const DAY_NIGHT_ENV_SIZE = 128;

export const createSkyUniforms = (def: SkyBoxDef, time: SkyTimeState): SkyUniforms => {
  const u = {
    base: createBaseUniforms(def.base, def.env),
    sun: createSunUniforms(),
    moon: createMoonUniforms(),
    atmosphere: createAtmosphereUniforms(),
    clouds: createCloudsUniforms(),
    ground: createGroundUniforms(),
  };
  applySkyUniforms(u, def, time);
  return u;
};

/** suns[0]'s and moons[0]'s directions: from the time of day (and the moon's phase) with
 * day-night on, else their elevations and azimuths. */
const writeDirections = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  const moon = def.moons?.[0];
  if (isDayNightEnabled(def)) {
    computeSunDirection(def.dayNight, time.timeOfDay, u.sun.direction.value);
    computeMoonDirection(
      def.dayNight,
      moon,
      time.timeOfDay,
      time.moonPhase,
      u.moon.direction.value
    );
  } else {
    getFixedSunDirection(def.suns?.[0], u.sun.direction.value);
    getFixedMoonDirection(moon, u.moon.direction.value);
  }
};

/** The moon's position-dependent values and the clouds' moonlight (after the atmosphere's). */
const applyMoonPosition = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  const sunDirection = u.sun.direction.value;
  applyMoonPositionUniforms(
    u.moon,
    sunDirection,
    getMoonPhaseOf(def, time, isDayNightEnabled(def))
  );
  applyCloudsMoonUniforms(u.clouds, isMoonEnabled(def) ? u.moon : null, u.atmosphere, sunDirection);
};

/** Writes every layer's non-structural values to its uniforms. The primary sun's direction
 * comes first: the atmosphere's terms depend on it, and the disc on the atmosphere's. */
export const applySkyUniforms = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  applyBaseUniforms(u.base, def.base, def.env);
  writeDirections(u, def, time);
  applyAtmosphereUniforms(u.atmosphere, def.atmosphere, u.sun.direction.value);
  applySunUniforms(
    u.sun,
    def.suns?.[0],
    isAtmosphereEnabled(def) ? u.atmosphere : null,
    getEnvSize(def)
  );
  applyMoonUniforms(u.moon, def.moons?.[0], getEnvSize(def));
  applyCloudsUniforms(u.clouds, def.clouds, u.sun.direction.value);
  applyMoonPosition(u, def, time);
  applyGroundUniforms(u.ground, def.ground, isAtmosphereEnabled(def), u.sun.direction.value);
};

/**
 * The day-night step's write, after the time changed: the sun's and moon's directions and only
 * what depends on them (every other value is as applySkyUniforms left it). Runs every frame while the cycle
 * plays, so it allocates nothing.
 */
export const applySkyTimeUniforms = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  writeDirections(u, def, time);
  const sunDirection = u.sun.direction.value;
  const hasAtmosphere = isAtmosphereEnabled(def);
  applyAtmosphereSunUniforms(u.atmosphere, def.atmosphere, sunDirection);
  applySunLightingUniforms(u.sun, hasAtmosphere ? u.atmosphere : null);
  applyCloudsSunUniforms(u.clouds, sunDirection);
  applyMoonPosition(u, def, time);
  applyGroundSunUniforms(u.ground, hasAtmosphere, sunDirection);
};

/** Whether a definition has an enabled procedural layer (then it's on the composite path). */
export const hasProceduralLayer = (def: SkyBoxDef) =>
  isAtmosphereEnabled(def) || isSunEnabled(def) || isMoonEnabled(def) || isGroundEnabled(def);

/** Which layers exist: a change to it is a rebuild. */
export const getCompositeSignature = (def: SkyBoxDef) =>
  [
    isSunEnabled(def),
    isSunLightEnabled(def),
    isMoonEnabled(def),
    isMoonLightEnabled(def),
    Boolean(def.moons?.[0]?.texture),
    isAtmosphereEnabled(def),
    isCloudsEnabled(def),
    isGroundEnabled(def),
  ].join('|');

/**
 * The composite colour in direction `dir` (a world direction: normalWorldGeometry of the
 * background sphere, in both modes: the bake scene's background is drawn the same way).
 */
export const buildSkyComposite = (
  def: SkyBoxDef,
  u: SkyUniforms,
  mode: SkyCompositeMode,
  sources: SkyCompositeSources,
  dir: THREE.Node<'vec3'>
): THREE.Node => {
  let color = baseNode(dir, def.base, u.base, sources.basePMREM);
  // Space layers (p113/p114)
  if (isSunEnabled(def)) color = sunNode(dir, color, u.sun, mode, isSunLightEnabled(def));
  if (isMoonEnabled(def)) {
    const texture = def.moons?.[0]?.texture;
    const map =
      texture && sources.moonTexture ? { texture: sources.moonTexture, def: texture } : null;
    color = moonNode(dir, color, u.moon, mode, isMoonLightEnabled(def), map);
  }
  if (isAtmosphereEnabled(def)) {
    const terms = atmosphereTerms(dir, u.atmosphere, u.sun.direction);
    const parts = atmosphereParts(dir, color, u.atmosphere, terms);
    color = isCloudsEnabled(def)
      ? cloudsNode(dir, parts, terms, u.atmosphere, u.clouds, mode)
      : composeAtmosphere(parts, u.atmosphere);
  }
  if (isGroundEnabled(def)) color = groundNode(dir, color, u.ground);
  return color;
};
