import * as THREE from 'three/webgpu';
import { cubeTexture, float, uniform, vec3 } from 'three/tsl';
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
  MAX_SUNS,
  SUN_DEFAULTS,
  sunNode,
  type SunAtmosphere,
  type SunUniforms,
} from './layers/sun';
import {
  applyMoonPositionUniforms,
  applyMoonUniforms,
  createMoonUniforms,
  getFixedMoonDirection,
  MAX_MOONS,
  moonNode,
  type MoonUniforms,
} from './layers/moon';
import {
  applyStarsSkyUniforms,
  applyStarsUniforms,
  STARS_DEFAULTS,
  createStarsUniforms,
  starsNode,
  type StarsUniforms,
} from './layers/stars';
import {
  computeMoonDirection,
  computeSkyRotation,
  computeSunDirection,
  getDayNightStartTime,
  getMoonPhaseOf,
  turnWithSky,
  type SkyTimeState,
} from './SkyTime';
import type { StaticLayersSource } from './SkyStaticLayers';
import {
  applyNebulaeUniforms,
  createNebulaeUniforms,
  getEnabledNebulae,
  getNebulaeSignature,
  nebulaeNode,
  type NebulaUniforms,
} from './layers/nebula';

/**
 * The composite path: every layer of a sky box composited into one node, used as the
 * background (VIEW) and as what the env bake renders (ENV_BAKE). A sky box uses it whenever a
 * procedural layer is enabled; a texture-only or colour-only one keeps the direct path
 * (buildBaseLayer), which needs no bake.
 *
 * Layer order, back to front (p110 "Composite order"): base, static layers (the nebulae's baked
 * cube, p114), stars, discs (the suns, then the moons, p114), atmosphere, clouds, ground. Each layer takes the colour behind it and
 * returns the new colour; an absent or disabled layer is left out of the graph (changing which
 * layers exist is a rebuild, anything else is a uniform write).
 */

/** VIEW: the background the camera sees. ENV_BAKE: what the environment is baked from (a
 * wider, clamped sun disc, no disc where a sun or moon light gives the specular, frozen
 * clouds, no stars). */
export type SkyCompositeMode = 'VIEW' | 'ENV_BAKE';

/** Every layer's uniforms, created once per activation (whether the layer is on or not, so
 * turning one on only rebuilds nodes) and shared by both modes' nodes. */
export type SkyUniforms = {
  base: BaseUniforms;
  /** One set per possible sun (MAX_SUNS), by index; suns[0]'s direction drives the atmosphere
   * (and is written even without any suns). */
  suns: SunUniforms[];
  /** One set per possible moon (MAX_MOONS), by index. */
  moons: MoonUniforms[];
  stars: StarsUniforms;
  atmosphere: AtmosphereUniforms;
  clouds: CloudsUniforms;
  ground: GroundUniforms;
  staticLayers: StaticLayersUniforms;
  /** One set per possible nebula (MAX_NEBULAE); the i-th enabled nebula uses set i. */
  nebulae: NebulaUniforms[];
};

export type StaticLayersUniforms = {
  /** World direction → the static layers' frame (the sidereal rotation with day-night on, else
   * identity). */
  rotation: THREE.UniformNode<'mat3', THREE.Matrix3>;
  /** The stars' frame → the static layers' frame (identity unless the stars don't turn with
   * the sky): where the stars look up their boost mask. */
  starsToStatic: THREE.UniformNode<'mat3', THREE.Matrix3>;
};

/** What the composite samples that isn't a uniform. */
export type SkyCompositeSources = {
  /** The base texture's PMREM (getPMREMTexture), null for a COLOR base or a failed load. */
  basePMREM: THREE.Texture | null;
  /** Each moon's texture (by index), null without one or on a failed load. */
  moonTextures: (THREE.Texture | null)[];
  /** The static layers' baked cube (SkyStaticLayers.ts), null without static layers. */
  staticLayers: THREE.CubeTexture | null;
};

/** A procedural layer is on when its key is there, unless it says `enabled: false`. */
export const isOn = (layer: { enabled?: boolean } | undefined) =>
  Boolean(layer && layer.enabled !== false);

export const isAtmosphereEnabled = (def: SkyBoxDef) => isOn(def.atmosphere);
/** How many suns (moons) the sky box draws: its entries, up to MAX_SUNS (MAX_MOONS). */
export const getSunCount = (def: SkyBoxDef) => Math.min(def.suns?.length ?? 0, MAX_SUNS);
export const getMoonCount = (def: SkyBoxDef) => Math.min(def.moons?.length ?? 0, MAX_MOONS);
/** A sun's disc (suns[0]'s direction drives the atmosphere either way). */
export const isSunEnabled = (def: SkyBoxDef, i: number) => i < MAX_SUNS && isOn(def.suns?.[i]);
/** Whether a sun has a light: then the env bake leaves its disc out (the light gives that
 * highlight already). */
export const isSunLightEnabled = (def: SkyBoxDef, i: number) =>
  i < MAX_SUNS && isOn(def.suns?.[i]?.light);
/** A moon's disc. */
export const isMoonEnabled = (def: SkyBoxDef, i: number) => i < MAX_MOONS && isOn(def.moons?.[i]);
/** Whether a moon has a light: then the env bake leaves its disc out. */
export const isMoonLightEnabled = (def: SkyBoxDef, i: number) =>
  i < MAX_MOONS && isOn(def.moons?.[i]?.light);
export const isStarsEnabled = (def: SkyBoxDef) => isOn(def.stars);
export const isMilkyWayEnabled = (def: SkyBoxDef) =>
  isStarsEnabled(def) && isOn(def.stars?.milkyWay);
/** Clouds need the atmosphere (the schema rejects them without one). */
export const isCloudsEnabled = (def: SkyBoxDef) => isOn(def.clouds) && isAtmosphereEnabled(def);
export const isGroundEnabled = (def: SkyBoxDef) => isOn(def.ground);
/** Whether it has static layers: an enabled nebula (baked into a cube, SkyStaticLayers.ts). */
export const hasStaticLayers = (def: SkyBoxDef) => getEnabledNebulae(def.nebulae).length > 0;
/** The nebula cube's face size. */
export const getNebulaSize = (def: SkyBoxDef | undefined) =>
  def?.env?.nebulaSize ?? ENV_DEFAULTS.nebulaSize;
/** A definition's static layers (its enabled nebulae), or null without any. */
export const getStaticLayersSourceOf = (
  def: SkyBoxDef,
  u: SkyUniforms
): StaticLayersSource | null =>
  hasStaticLayers(def)
    ? { resolution: getNebulaSize(def), build: (dir) => nebulaeNode(dir, def.nebulae, u.nebulae) }
    : null;
/** While on, suns[0]'s and every moon's directions come from the time of day, and the other
 * suns turn with the sky (SkyTime.ts). */
export const isDayNightEnabled = (def: SkyBoxDef | undefined) => isOn(def?.dayNight);

/** The env bake's size: 256 by default, 128 with day-night (it re-bakes as the sun moves). */
export const getEnvSize = (def: SkyBoxDef | undefined) =>
  def?.env?.size ?? (isDayNightEnabled(def) ? DAY_NIGHT_ENV_SIZE : ENV_DEFAULTS.size);
const DAY_NIGHT_ENV_SIZE = 128;

export const createSkyUniforms = (def: SkyBoxDef, time: SkyTimeState): SkyUniforms => {
  const u = {
    base: createBaseUniforms(def.base, def.env),
    suns: Array.from({ length: MAX_SUNS }, createSunUniforms),
    moons: Array.from({ length: MAX_MOONS }, createMoonUniforms),
    stars: createStarsUniforms(),
    atmosphere: createAtmosphereUniforms(),
    clouds: createCloudsUniforms(),
    ground: createGroundUniforms(),
    staticLayers: {
      rotation: uniform(new THREE.Matrix3()),
      starsToStatic: uniform(new THREE.Matrix3()),
    },
    nebulae: createNebulaeUniforms(),
  };
  applySkyUniforms(u, def, time);
  return u;
};

/**
 * A sun's unit direction at `timeOfDay`, into `out`. suns[0]: from the time of day with
 * day-night on, else its elevation and azimuth. Any other sun: its elevation and azimuth, which
 * with day-night and `rotateWithSky` are where it stands at the start time, turned with the sky
 * from there.
 */
export const computeSunDirectionOf = (
  def: SkyBoxDef,
  i: number,
  timeOfDay: number,
  out: THREE.Vector3
) => {
  const dayNight = isDayNightEnabled(def);
  if (i === 0 && dayNight) return computeSunDirection(def.dayNight, timeOfDay, out);
  const sun = def.suns?.[i];
  getFixedSunDirection(sun, out);
  if (!dayNight || i === 0 || !(sun?.rotateWithSky ?? SUN_DEFAULTS.rotateWithSky)) return out;
  return turnWithSky(def.dayNight, out, getDayNightStartTime(def.dayNight), timeOfDay, out);
};

/** A moon's unit direction, into `out`: from the time of day and its running phase with
 * day-night on, else its elevation and azimuth. */
export const computeMoonDirectionOf = (
  def: SkyBoxDef,
  i: number,
  time: SkyTimeState,
  out: THREE.Vector3
) => {
  const moon = def.moons?.[i];
  if (!isDayNightEnabled(def)) return getFixedMoonDirection(moon, out);
  return computeMoonDirection(def.dayNight, moon, time.timeOfDay, time.moonPhases[i] ?? 0, out);
};

/** Every sun's and moon's direction (suns[0] and moons[0] always: the atmosphere, clouds and
 * lights read them without any entries too). */
const writeDirections = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  const suns = Math.max(1, getSunCount(def));
  for (let i = 0; i < suns; i++) {
    computeSunDirectionOf(def, i, time.timeOfDay, u.suns[i].direction.value);
  }
  const moons = Math.max(1, getMoonCount(def));
  for (let i = 0; i < moons; i++) computeMoonDirectionOf(def, i, time, u.moons[i].direction.value);
};

const _skyRotation = new THREE.Matrix3();

/** The stars' fade, and the stars' and static layers' rotation (the sidereal one with
 * day-night, else none). */
const applySkyRotation = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  const rotation = isDayNightEnabled(def)
    ? computeSkyRotation(def.dayNight, time.timeOfDay, _skyRotation)
    : null;
  applyStarsSkyUniforms(u.stars, def.stars, u.suns[0].direction.value, rotation);
  const { rotation: staticRotation, starsToStatic } = u.staticLayers;
  if (rotation) staticRotation.value.copy(rotation);
  else staticRotation.value.identity();
  // The stars' frame is the static layers' unless the stars stay put while the sky turns
  const starsTurn = def.stars?.rotateWithSky ?? STARS_DEFAULTS.rotateWithSky;
  if (rotation && !starsTurn) starsToStatic.value.copy(rotation);
  else starsToStatic.value.identity();
};

/** Each moon's position-dependent values and the clouds' moonlight (moons[0]'s; after the
 * atmosphere's). */
const applyMoonPosition = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  const sunDirection = u.suns[0].direction.value;
  const isDayNight = isDayNightEnabled(def);
  const moons = Math.max(1, getMoonCount(def));
  for (let i = 0; i < moons; i++) {
    applyMoonPositionUniforms(u.moons[i], sunDirection, getMoonPhaseOf(def, time, isDayNight, i));
  }
  if (!isCloudsEnabled(def)) return;
  const moon = isMoonEnabled(def, 0) ? u.moons[0] : null;
  applyCloudsMoonUniforms(u.clouds, moon, u.atmosphere, sunDirection);
};

const getSunAtmosphere = (u: SkyUniforms, def: SkyBoxDef): SunAtmosphere =>
  isAtmosphereEnabled(def) ? { u: u.atmosphere, def: def.atmosphere } : null;

/** Writes every layer's non-structural values to its uniforms. The primary sun's direction
 * comes first: the atmosphere's terms depend on it, and the discs on the atmosphere's. */
export const applySkyUniforms = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  applyBaseUniforms(u.base, def.base, def.env);
  writeDirections(u, def, time);
  const sunDirection = u.suns[0].direction.value;
  applyAtmosphereUniforms(u.atmosphere, def.atmosphere, sunDirection);
  const atmosphere = getSunAtmosphere(u, def);
  const envSize = getEnvSize(def);
  const suns = Math.max(1, getSunCount(def));
  for (let i = 0; i < suns; i++) applySunUniforms(u.suns[i], def.suns?.[i], atmosphere, envSize);
  const moons = Math.max(1, getMoonCount(def));
  for (let i = 0; i < moons; i++) applyMoonUniforms(u.moons[i], def.moons?.[i], envSize);
  applyStarsUniforms(u.stars, def.stars);
  applySkyRotation(u, def, time);
  applyNebulaeUniforms(u.nebulae, def.nebulae);
  applyCloudsUniforms(u.clouds, def.clouds, sunDirection);
  applyMoonPosition(u, def, time);
  applyGroundUniforms(u.ground, def.ground, isAtmosphereEnabled(def), sunDirection);
};

/**
 * The day-night step's write, after the time changed: the sun's and moon's directions and only
 * what depends on them (every other value is as applySkyUniforms left it). Runs every frame while the cycle
 * plays, so it allocates nothing.
 */
export const applySkyTimeUniforms = (u: SkyUniforms, def: SkyBoxDef, time: SkyTimeState) => {
  writeDirections(u, def, time);
  const sunDirection = u.suns[0].direction.value;
  const hasAtmosphere = isAtmosphereEnabled(def);
  // A layer that's off is skipped: nothing reads its uniforms, and turning it on runs
  // applySkyUniforms. The moons' positions are always written: their lights need the lit
  // fraction.
  if (hasAtmosphere) applyAtmosphereSunUniforms(u.atmosphere, def.atmosphere, sunDirection);
  const atmosphere = getSunAtmosphere(u, def);
  const suns = Math.max(1, getSunCount(def));
  for (let i = 0; i < suns; i++) applySunLightingUniforms(u.suns[i], atmosphere);
  if (isCloudsEnabled(def)) applyCloudsSunUniforms(u.clouds, sunDirection);
  applyMoonPosition(u, def, time);
  if (isStarsEnabled(def) || hasStaticLayers(def)) applySkyRotation(u, def, time);
  if (isGroundEnabled(def)) applyGroundSunUniforms(u.ground, hasAtmosphere, sunDirection);
};

/** Whether a definition has an enabled procedural layer (then it's on the composite path). */
export const hasProceduralLayer = (def: SkyBoxDef) =>
  isAtmosphereEnabled(def) ||
  (def.suns?.some((_, i) => isSunEnabled(def, i)) ?? false) ||
  (def.moons?.some((_, i) => isMoonEnabled(def, i)) ?? false) ||
  isStarsEnabled(def) ||
  isGroundEnabled(def) ||
  hasStaticLayers(def);

/** Which layers exist: a change to it is a rebuild. */
export const getCompositeSignature = (def: SkyBoxDef) =>
  [
    Array.from(
      { length: getSunCount(def) },
      (_, i) => `${+isSunEnabled(def, i)}${+isSunLightEnabled(def, i)}`
    ).join(','),
    Array.from(
      { length: getMoonCount(def) },
      (_, i) =>
        `${+isMoonEnabled(def, i)}${+isMoonLightEnabled(def, i)}${+Boolean(def.moons?.[i]?.texture)}`
    ).join(','),
    isStarsEnabled(def),
    isMilkyWayEnabled(def),
    isAtmosphereEnabled(def),
    isCloudsEnabled(def),
    isGroundEnabled(def),
    getNebulaeSignature(def.nebulae),
    hasStaticLayers(def) ? getNebulaSize(def) : 0,
  ].join('|');

/** The static layers (the nebulae) over `behind`: the baked cube, looked up in their frame. */
const staticLayersNode = (
  dir: THREE.Node<'vec3'>,
  behind: THREE.Node,
  u: StaticLayersUniforms,
  cube: THREE.CubeTexture
): THREE.Node =>
  vec3(behind as THREE.Node<'vec3'>).add(cubeTexture(cube, u.rotation.mul(dir), float(0)).rgb);

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
  const staticLayers = hasStaticLayers(def) ? sources.staticLayers : null;
  if (staticLayers) color = staticLayersNode(dir, color, u.staticLayers, staticLayers);
  // Stars: never in the env bake (p110 §0.2)
  if (isStarsEnabled(def) && mode === 'VIEW') {
    const boost = staticLayers
      ? { cube: staticLayers, starsToStatic: u.staticLayers.starsToStatic }
      : null;
    color = starsNode(dir, color, u.stars, isMilkyWayEnabled(def), boost);
  }
  // Unrolled: which discs exist is part of the signature
  for (let i = 0; i < getSunCount(def); i++) {
    if (!isSunEnabled(def, i)) continue;
    color = sunNode(dir, color, u.suns[i], mode, isSunLightEnabled(def, i));
  }
  for (let i = 0; i < getMoonCount(def); i++) {
    if (!isMoonEnabled(def, i)) continue;
    const texture = def.moons?.[i]?.texture;
    const moonTexture = sources.moonTextures[i];
    const map = texture && moonTexture ? { texture: moonTexture, def: texture } : null;
    color = moonNode(dir, color, u.moons[i], mode, isMoonLightEnabled(def, i), map);
  }
  if (isAtmosphereEnabled(def)) {
    const terms = atmosphereTerms(dir, u.atmosphere, u.suns[0].direction);
    const parts = atmosphereParts(dir, color, u.atmosphere, terms);
    color = isCloudsEnabled(def)
      ? cloudsNode(dir, parts, terms, u.atmosphere, u.clouds, mode)
      : composeAtmosphere(parts, u.atmosphere);
  }
  if (isGroundEnabled(def)) color = groundNode(dir, color, u.ground);
  return color;
};
