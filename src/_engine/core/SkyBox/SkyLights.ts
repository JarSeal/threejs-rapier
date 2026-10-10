/**
 * The active sky box's managed lights (MANAGED_BY, p110 §0.4): a directional "disc light" per
 * sun and moon that has one (roles SUN_0..3 and MOON_0..1, p114), and an optional hemisphere or
 * ambient light that follows the primary sun. They are ordinary ECS lights made by
 * createLightEntity, created on activation and deleted with the sky box. A moon light only
 * shines at night: it's scaled by its moon's lit fraction and fades out as the day comes up.
 * Only suns[0]'s light casts shadows by default; the debug env warns above
 * MAX_SHADOW_CASTERS_HINT shadow-casting sky lights (each is a full extra scene render).
 *
 * The sky box only writes what it owns: a disc light's transform and its target, colour,
 * intensity, shadow settings, shadow intensity and shadow.autoUpdate, and the ambient light's
 * colours and intensity. Anything else (eg. setLightEnabled from app code) is left alone. The
 * light is read from OBJECT3D on every write (the Lights tab can swap it), and `castShadow`
 * changes only when the definition changes it (it rebuilds every lit material), never to fade.
 *
 * A `castShadow` change re-creates the disc light instead of setting the flag: with PostFX on
 * (WebGPU, three r186), turning a light's shadow back on after it was off crashes the frame
 * ("Texture 'output' ... writable usage and another usage in the same synchronization scope"),
 * while a new light with `castShadow: true` renders fine. The cost is the same one lit-material
 * rebuild either way.
 */
import * as THREE from 'three/webgpu';
import { getECSWorld, type ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import type { ShadowQuality } from '../LightManager';
import { createLightEntity, getLightTargetId, SHADOW_PRESETS } from '../LightManager';
import { getActiveCamera } from '../CameraManager';
import type {
  SkyBoxAmbientLightDef,
  SkyBoxDef,
  SkyBoxMoonLightDef,
  SkyBoxSunLightDef,
} from './SkyBoxTypes';
import {
  getMoonCount,
  getSunCount,
  isAtmosphereEnabled,
  isGroundEnabled,
  isOn,
  type SkyUniforms,
} from './SkyComposite';
import { GROUND_DEFAULTS } from './layers/ground';
import { computeInscatter, computeRelativeExtinction, getDayFactor } from './layers/atmosphere';
import { MAX_MOONS, MOONLIGHT_COLOR } from './layers/moon';
import { MAX_SUNS } from './layers/sun';
import { toSkyColor } from './skyColor';
import { isDebugEnvironment } from '../Config';
import { lwarn } from '../../utils/Logger';

/** The MANAGED_BY manager id of the entities a sky box owns. */
export const SKYBOX_MANAGER_ID = 'SKYBOX';

export const SUN_LIGHT_DEFAULTS = {
  enabled: true,
  intensity: 3,
  color: 'AUTO',
  castShadow: true,
  // A literal, not ShadowQuality.MEDIUM: LightManager imports Scene, which imports this module
  // (through SkyBox.ts), so its values aren't set yet while this one loads
  shadowPreset: 'MEDIUM' as `${ShadowQuality}`,
  shadowFrustumSize: 30,
  distance: 100,
  shadowFollow: 'ACTIVE_CAMERA' as 'ACTIVE_CAMERA' | 'ORIGIN',
  horizonFade: [6, -3] as [number, number],
};

/** suns[1..3]'s lights: no shadow by default (one shadow-casting sky light by default). */
export const EXTRA_SUN_LIGHT_DEFAULTS = {
  ...SUN_LIGHT_DEFAULTS,
  castShadow: false,
};

export const MOON_LIGHT_DEFAULTS = {
  ...SUN_LIGHT_DEFAULTS,
  intensity: 0.3,
  castShadow: false,
};

/** Above this many shadow-casting sky lights, the debug env warns. */
export const MAX_SHADOW_CASTERS_HINT = 2;

export const AMBIENT_LIGHT_DEFAULTS = {
  enabled: true,
  type: 'HEMISPHERE' as 'HEMISPHERE' | 'AMBIENT',
  intensity: 0.5,
  skyColor: 'AUTO',
  groundColor: 'AUTO',
};

/** The shadow camera's near plane; its far plane is twice the light's distance. */
const SHADOW_NEAR = 0.5;

/** Which kind of sky disc a directional light follows. */
export type DiscKind = 'SUN' | 'MOON';

/** A disc light's defaults, by kind and index. */
export const getDiscLightDefaults = (kind: DiscKind, index: number) =>
  kind === 'MOON'
    ? MOON_LIGHT_DEFAULTS
    : index === 0
      ? SUN_LIGHT_DEFAULTS
      : EXTRA_SUN_LIGHT_DEFAULTS;

/** Its MANAGED_BY role, eg. 'SUN_0', and its debug name ('Sky box sun', 'Sky box sun 2'). */
const getDiscLightRole = (kind: DiscKind, index: number) => `${kind}_${index}`;
const getDiscLightName = (kind: DiscKind, index: number) =>
  `Sky box ${kind === 'SUN' ? 'sun' : 'moon'}${index > 0 ? ` ${index + 1}` : ''}`;

type DiscLightDef = SkyBoxSunLightDef | SkyBoxMoonLightDef;

type DiscLightState = {
  kind: DiscKind;
  index: number;
  entityId: number;
  castShadow: boolean;
  distance: number;
  follow: 'ACTIVE_CAMERA' | 'ORIGIN';
  /** The disc's direction, and the light-space axes the shadow camera's lookAt builds from it. */
  direction: THREE.Vector3;
  axisX: THREE.Vector3;
  axisY: THREE.Vector3;
  axisZ: THREE.Vector3;
  /** One shadow map texel, in world units. */
  texelSize: number;
  lastFollow: THREE.Vector3;
  /** Set by every settings write: the next frame writes the transforms even if the follow point
   * hasn't moved. */
  needsWrite: boolean;
};

let ownerId: string | null = null;
/** By kind, then by sun or moon index. */
const discLights: Record<DiscKind, (DiscLightState | null)[]> = {
  SUN: new Array<DiscLightState | null>(MAX_SUNS).fill(null),
  MOON: new Array<DiscLightState | null>(MAX_MOONS).fill(null),
};
/** The shadow-casting count last warned about (debug env), so a drag doesn't repeat it. */
let warnedShadowCasters = 0;
let ambientLight: { entityId: number; type: 'HEMISPHERE' | 'AMBIENT' } | null = null;

// Scratch objects (no allocations on the per-frame path)
const _followPoint = new THREE.Vector3();
const _color = new THREE.Color();
const _vec = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const GROUND_DEFAULT_COLOR = toSkyColor(GROUND_DEFAULTS.color);

const getLight = <T extends THREE.Light>(entityId: number, world: ECSWorld) =>
  world.getComponent(entityId, ComponentType.OBJECT3D)?.value as T | undefined;

/** 1 with a disc at or above horizonFade[0], 0 at or below horizonFade[1] (degrees). */
const getHorizonFade = (direction: THREE.Vector3, horizonFade: [number, number]) => {
  const elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)));
  const [start, end] = horizonFade;
  if (start === end) return elevation >= start ? 1 : 0;
  return THREE.MathUtils.smoothstep(elevation, Math.min(start, end), Math.max(start, end));
};

/** Sets `out` to a colour scaled so its largest channel is 1 (black stays black). */
const normalizeColor = (out: THREE.Color) => {
  const max = Math.max(out.r, out.g, out.b);
  return max > 0 ? out.multiplyScalar(1 / max) : out;
};

/** The shadow camera's axes for a light looking along -direction (as Matrix4.lookAt builds
 * them with the camera's default up, including its nudge when looking straight down). */
const setLightSpaceAxes = (state: DiscLightState) => {
  state.axisZ.copy(state.direction);
  state.axisX.crossVectors(UP, state.axisZ);
  if (state.axisX.lengthSq() === 0) {
    state.axisZ.z += 0.0001;
    state.axisZ.normalize();
    state.axisX.crossVectors(UP, state.axisZ);
  }
  state.axisX.normalize();
  state.axisY.crossVectors(state.axisZ, state.axisX);
};

// Disc lights (sun and moon)

const getDiscLightDef = (
  kind: DiscKind,
  index: number,
  def: SkyBoxDef
): DiscLightDef | undefined =>
  kind === 'SUN' ? def.suns?.[index]?.light : def.moons?.[index]?.light;

const getDiscDirection = (kind: DiscKind, index: number, u: SkyUniforms) =>
  kind === 'SUN' ? u.suns[index].direction.value : u.moons[index].direction.value;

const createDiscLight = (
  kind: DiscKind,
  index: number,
  skyBoxId: string,
  castShadow: boolean,
  world: ECSWorld
): DiscLightState => {
  const role = getDiscLightRole(kind, index);
  const defaults = getDiscLightDefaults(kind, index);
  const entityId = createLightEntity(
    { type: 'DIRECTIONAL', intensity: 0, castShadow },
    {
      appId: `__skybox_${skyBoxId}_${role}`,
      managedBy: { manager: SKYBOX_MANAGER_ID, ownerId: skyBoxId, role },
      debugData: { name: getDiscLightName(kind, index) },
    },
    world
  );
  // Render the shadow map once now, even when the light starts faded out (autoUpdate false):
  // a map first sampled and only later rendered into gets its GPU texture destroyed in place
  // on that first render (see initEnvBakeTarget in SkyEnvironment.ts), a "Destroyed texture
  // used in a submit" on every frame after that (WebGPU)
  const light = getLight<THREE.DirectionalLight>(entityId, world);
  if (castShadow && light?.shadow) light.shadow.needsUpdate = true;
  return {
    kind,
    index,
    entityId,
    castShadow,
    distance: defaults.distance,
    follow: defaults.shadowFollow,
    direction: new THREE.Vector3(0, 1, 0),
    axisX: new THREE.Vector3(),
    axisY: new THREE.Vector3(),
    axisZ: new THREE.Vector3(),
    texelSize: 0,
    lastFollow: new THREE.Vector3(),
    needsWrite: true,
  };
};

const applyDiscLight = (
  state: DiscLightState,
  lightDef: DiscLightDef,
  def: SkyBoxDef,
  u: SkyUniforms,
  world: ECSWorld
) => {
  const light = getLight<THREE.DirectionalLight>(state.entityId, world);
  if (!light?.isDirectionalLight) return;
  const defaults = getDiscLightDefaults(state.kind, state.index);

  const color = lightDef.color ?? defaults.color;
  if (color !== 'AUTO') light.color.copy(toSkyColor(color));

  // castShadow is set at creation only (see the header: a change re-creates the light)

  // Shadow settings: all of them are read live by the shadow node (a map size change resizes
  // the map on its next render)
  const shadow = light.shadow;
  const preset = SHADOW_PRESETS[lightDef.shadowPreset ?? defaults.shadowPreset];
  const mapSize = lightDef.shadowMapSize ?? preset.mapSize[0];
  shadow.mapSize.set(mapSize, mapSize);
  shadow.bias = lightDef.shadowBias ?? preset.bias;
  shadow.normalBias = lightDef.shadowNormalBias ?? preset.normalBias;
  shadow.radius = preset.radius;
  shadow.blurSamples = preset.blurSamples;

  const half = lightDef.shadowFrustumSize ?? defaults.shadowFrustumSize;
  state.distance = lightDef.distance ?? defaults.distance;
  const camera = shadow.camera;
  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half;
  camera.near = SHADOW_NEAR;
  camera.far = state.distance * 2;
  camera.updateProjectionMatrix();
  state.texelSize = (half * 2) / mapSize;
  state.follow = lightDef.shadowFollow ?? defaults.shadowFollow;

  applyDiscLightMotion(state, lightDef, def, u, light);
};

/**
 * A disc light's values that follow the sky: its direction (and light-space axes), AUTO colour,
 * faded intensity and shadow fade. A sun light fades below the horizon; a moon light also
 * with its moon's lit fraction and the day (`1 − dayFactor` of the primary sun). The day-night
 * step calls it every time the sky moves: it allocates nothing.
 */
const applyDiscLightMotion = (
  state: DiscLightState,
  lightDef: DiscLightDef,
  def: SkyBoxDef,
  u: SkyUniforms,
  light: THREE.DirectionalLight
) => {
  const defaults = getDiscLightDefaults(state.kind, state.index);
  state.direction.copy(getDiscDirection(state.kind, state.index, u));
  setLightSpaceAxes(state);
  let fade = getHorizonFade(state.direction, lightDef.horizonFade ?? defaults.horizonFade);
  if (state.kind === 'MOON') {
    fade *=
      u.moons[state.index].illuminatedFraction * (1 - getDayFactor(u.suns[0].direction.value));
  }

  if ((lightDef.color ?? defaults.color) === 'AUTO') {
    const hasAtmosphere = isAtmosphereEnabled(def);
    if (state.kind === 'SUN') {
      // The extinction along this sun (suns[0]'s is the atmosphere's extinctionAtSun)
      const fex = u.suns[state.index].extinction;
      if (hasAtmosphere) light.color.copy(normalizeColor(_color.setRGB(fex.x, fex.y, fex.z)));
      else light.color.setRGB(1, 1, 1);
    } else {
      light.color.copy(MOONLIGHT_COLOR);
      if (hasAtmosphere) {
        const { betaR, betaM } = u.atmosphere;
        // Relative to the zenith's: overhead, it's the moonlight colour as given
        const fex = computeRelativeExtinction(state.direction.y, betaR.value, betaM.value, _vec);
        light.color.multiply(normalizeColor(_color.setRGB(fex.x, fex.y, fex.z)));
      }
    }
  }
  light.intensity = (lightDef.intensity ?? defaults.intensity) * fade;
  light.shadow.intensity = fade;
  // Faded out, the shadow map isn't rendered
  light.shadow.autoUpdate = fade > 0;
  state.needsWrite = true;
};

const snapToStep = (value: number, step: number) => Math.round(value / step) * step;

const writeTransform = (entityId: number, position: THREE.Vector3, world: ECSWorld) => {
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (!transform) return;
  transform.position.copy(position);
  transform.setDirty();
  world.commitTransform(entityId, transform);
};

/**
 * Moves the disc lights with their follow point (the active camera, or the origin), snapped to
 * shadow map texels in light space so the shadows don't shimmer as it slides (depth unsnapped:
 * moving along the light doesn't shimmer). Called every frame by skyBoxSystem (MAIN, before
 * object3DSyncSystem); writes nothing while the follow point and settings are unchanged. The
 * camera's world matrix is last frame's here, which a texel-snapped frustum doesn't notice.
 */
export const updateSkyLightsFrame = (world: ECSWorld) => {
  for (const state of discLights.SUN) if (state) updateDiscLightTransform(state, world);
  for (const state of discLights.MOON) if (state) updateDiscLightTransform(state, world);
};

const updateDiscLightTransform = (state: DiscLightState, world: ECSWorld) => {
  const p = _vec.set(0, 0, 0);
  if (state.follow === 'ACTIVE_CAMERA') getActiveCamera()?.getWorldPosition(p);
  const { axisX, axisY, axisZ, texelSize } = state;
  _followPoint
    .copy(axisX)
    .multiplyScalar(snapToStep(p.dot(axisX), texelSize))
    .addScaledVector(axisY, snapToStep(p.dot(axisY), texelSize))
    .addScaledVector(axisZ, p.dot(axisZ));
  if (!state.needsWrite && _followPoint.equals(state.lastFollow)) return;
  state.lastFollow.copy(_followPoint);
  state.needsWrite = false;

  const targetId = getLightTargetId(state.entityId, world);
  if (targetId !== undefined) writeTransform(targetId, _followPoint, world);
  writeTransform(
    state.entityId,
    _vec.copy(_followPoint).addScaledVector(state.direction, state.distance),
    world
  );
};

// Ambient light

const createAmbientLight = (skyBoxId: string, type: 'HEMISPHERE' | 'AMBIENT', world: ECSWorld) => ({
  type,
  entityId: createLightEntity(
    { type, intensity: 0 },
    {
      appId: `__skybox_${skyBoxId}_AMBIENT`,
      managedBy: { manager: SKYBOX_MANAGER_ID, ownerId: skyBoxId, role: 'AMBIENT' },
      debugData: { name: 'Sky box ambient' },
    },
    world
  ),
});

const applyAmbientLight = (
  entityId: number,
  ambientDef: SkyBoxAmbientLightDef,
  def: SkyBoxDef,
  u: SkyUniforms,
  world: ECSWorld
) => {
  const light = getLight<THREE.HemisphereLight | THREE.AmbientLight>(entityId, world);
  if (!light) return;
  light.intensity = ambientDef.intensity ?? AMBIENT_LIGHT_DEFAULTS.intensity;
  const skyColor = ambientDef.skyColor ?? AMBIENT_LIGHT_DEFAULTS.skyColor;
  if (skyColor !== 'AUTO') light.color.copy(toSkyColor(skyColor));
  if ((light as THREE.HemisphereLight).isHemisphereLight) {
    const groundColor = ambientDef.groundColor ?? AMBIENT_LIGHT_DEFAULTS.groundColor;
    if (groundColor !== 'AUTO') {
      (light as THREE.HemisphereLight).groundColor.copy(toSkyColor(groundColor));
    }
  }
  applyAmbientLightSun(light, ambientDef, def, u);
};

/**
 * The ambient light's AUTO colours, which fade with the sun (with the sun light's fade range, if
 * it has one). The day-night step calls it every time the sun moves: it allocates nothing.
 */
const applyAmbientLightSun = (
  light: THREE.HemisphereLight | THREE.AmbientLight,
  ambientDef: SkyBoxAmbientLightDef,
  def: SkyBoxDef,
  u: SkyUniforms
) => {
  const sunDirection = u.suns[0].direction.value;
  const fade = getHorizonFade(
    sunDirection,
    def.suns?.[0]?.light?.horizonFade ?? SUN_LIGHT_DEFAULTS.horizonFade
  );

  if ((ambientDef.skyColor ?? AMBIENT_LIGHT_DEFAULTS.skyColor) === 'AUTO') {
    if (isAtmosphereEnabled(def)) {
      computeInscatter(UP, u.atmosphere, sunDirection, _vec);
      normalizeColor(_color.setRGB(_vec.x, _vec.y, _vec.z));
    } else {
      _color.setRGB(1, 1, 1);
    }
    light.color.copy(_color.multiplyScalar(fade));
  }

  if (
    (light as THREE.HemisphereLight).isHemisphereLight &&
    (ambientDef.groundColor ?? AMBIENT_LIGHT_DEFAULTS.groundColor) === 'AUTO'
  ) {
    // The ground layer's colour (its default without one), faded with the sun
    (light as THREE.HemisphereLight).groundColor
      .copy(isGroundEnabled(def) ? u.ground.color.value : GROUND_DEFAULT_COLOR)
      .multiplyScalar(fade);
  }
};

/**
 * The day-night step's light write, after the sky moved (applySkyTimeUniforms first): each
 * light's motion-dependent values only. The transforms follow in updateSkyLightsFrame. Runs
 * every frame while the cycle plays, so it allocates nothing.
 */
export const updateSkyLightsForTime = (def: SkyBoxDef, u: SkyUniforms, world: ECSWorld) => {
  for (let i = 0; i < MAX_SUNS; i++) updateDiscLightForTime('SUN', i, def, u, world);
  for (let i = 0; i < MAX_MOONS; i++) updateDiscLightForTime('MOON', i, def, u, world);
  const ambientDef = def.ambientLight;
  if (ambientLight && ambientDef) {
    const light = getLight<THREE.HemisphereLight | THREE.AmbientLight>(
      ambientLight.entityId,
      world
    );
    if (light) applyAmbientLightSun(light, ambientDef, def, u);
  }
};

const updateDiscLightForTime = (
  kind: DiscKind,
  index: number,
  def: SkyBoxDef,
  u: SkyUniforms,
  world: ECSWorld
) => {
  const state = discLights[kind][index];
  if (!state) return;
  const lightDef = getDiscLightDef(kind, index, def);
  if (!lightDef) return;
  const light = getLight<THREE.DirectionalLight>(state.entityId, world);
  if (light?.isDirectionalLight) applyDiscLightMotion(state, lightDef, def, u, light);
};

// Lifecycle

const deleteDiscLight = (kind: DiscKind, index: number, world: ECSWorld) => {
  // Also deletes its target (LightManager's delete hook)
  const state = discLights[kind][index];
  if (state) world.deleteEntity(state.entityId);
  discLights[kind][index] = null;
};

/** Whether a sun's or moon's light casts shadows (its definition, else its default). */
const castsShadow = (kind: DiscKind, index: number, lightDef: DiscLightDef) =>
  lightDef.castShadow ?? getDiscLightDefaults(kind, index).castShadow;

/** Creates, updates or deletes a disc light to match its definition. */
const syncDiscLight = (
  kind: DiscKind,
  index: number,
  skyBoxId: string,
  def: SkyBoxDef,
  u: SkyUniforms
) => {
  const world = getECSWorld();
  const count = kind === 'SUN' ? getSunCount(def) : getMoonCount(def);
  const lightDef = index < count ? getDiscLightDef(kind, index, def) : undefined;
  if (!lightDef || !isOn(lightDef)) {
    deleteDiscLight(kind, index, world);
    return;
  }
  const castShadow = castsShadow(kind, index, lightDef);
  // Also when something else changed the light's flag: never toggle it in place
  const state = discLights[kind][index];
  const current = state && getLight<THREE.DirectionalLight>(state.entityId, world);
  if (state && (state.castShadow !== castShadow || current?.castShadow !== castShadow)) {
    deleteDiscLight(kind, index, world);
  }
  const next = discLights[kind][index] ?? createDiscLight(kind, index, skyBoxId, castShadow, world);
  discLights[kind][index] = next;
  applyDiscLight(next, lightDef, def, u, world);
};

/** How many of the sky box's lights cast shadows (each is a full extra scene render). */
export const getSkyShadowCasterCount = () =>
  [...discLights.SUN, ...discLights.MOON].filter((state) => state?.castShadow).length;

/** Debug env: warns once each time the shadow-casting count goes above the hint. */
const warnAboutShadowCasters = (skyBoxId: string) => {
  const count = getSkyShadowCasterCount();
  if (count <= MAX_SHADOW_CASTERS_HINT) {
    warnedShadowCasters = 0;
    return;
  }
  if (count === warnedShadowCasters || !isDebugEnvironment()) return;
  warnedShadowCasters = count;
  lwarn(
    `Sky box "${skyBoxId}": ${count} sky lights cast shadows (more than ${MAX_SHADOW_CASTERS_HINT}). Each shadow map is a full extra scene render.`
  );
};

const deleteAmbientLight = (world: ECSWorld) => {
  if (ambientLight) world.deleteEntity(ambientLight.entityId);
  ambientLight = null;
};

/** Deletes the sky box's lights (clearSkyBox, or another sky box activating). */
export const deleteSkyLights = () => {
  const world = getECSWorld();
  for (let i = 0; i < MAX_SUNS; i++) deleteDiscLight('SUN', i, world);
  for (let i = 0; i < MAX_MOONS; i++) deleteDiscLight('MOON', i, world);
  deleteAmbientLight(world);
  ownerId = null;
  warnedShadowCasters = 0;
};

/**
 * Creates, updates or deletes the sky box's lights to match its definition (after every
 * activation and change). The transforms follow on the next skyBoxSystem tick.
 */
export const syncSkyLights = (skyBoxId: string, def: SkyBoxDef, u: SkyUniforms) => {
  const world = getECSWorld();
  if (ownerId !== skyBoxId) deleteSkyLights();
  ownerId = skyBoxId;
  // An entity deleted from outside (eg. a world reset) is created again
  for (const kind of ['SUN', 'MOON'] as const) {
    const states = discLights[kind];
    states.forEach((state, i) => {
      if (state && !world.isAlive(state.entityId)) states[i] = null;
    });
  }
  if (ambientLight && !world.isAlive(ambientLight.entityId)) ambientLight = null;

  for (let i = 0; i < MAX_SUNS; i++) syncDiscLight('SUN', i, skyBoxId, def, u);
  for (let i = 0; i < MAX_MOONS; i++) syncDiscLight('MOON', i, skyBoxId, def, u);
  warnAboutShadowCasters(skyBoxId);

  const ambientDef = def.ambientLight;
  if (ambientDef && isOn(ambientDef)) {
    const type = ambientDef.type ?? AMBIENT_LIGHT_DEFAULTS.type;
    // The light type is structural: another type is another light
    if (ambientLight && ambientLight.type !== type) deleteAmbientLight(world);
    ambientLight ??= createAmbientLight(skyBoxId, type, world);
    applyAmbientLight(ambientLight.entityId, ambientDef, def, u, world);
  } else {
    deleteAmbientLight(world);
  }
};

/** The sky box's managed light entity ids, by sun and moon index (debug and tests). */
export const getSkyLightIds = () => ({
  suns: discLights.SUN.map((state) => state?.entityId ?? null),
  moons: discLights.MOON.map((state) => state?.entityId ?? null),
  ambient: ambientLight?.entityId ?? null,
});
