/**
 * The active sky box's managed lights (MANAGED_BY, p110 §0.4): a directional light per sun
 * (suns[0] until p114) and an optional hemisphere or ambient light, both following the sun.
 * They are ordinary ECS lights made by createLightEntity, created on activation and deleted with
 * the sky box.
 *
 * The sky box only writes what it owns: the sun light's transform and its target, colour,
 * intensity, shadow settings, shadow intensity and shadow.autoUpdate, and the ambient light's
 * colours and intensity. Anything else (eg. setLightEnabled from app code) is left alone. The
 * light is read from OBJECT3D on every write (the Lights tab can swap it), and `castShadow`
 * changes only when the definition changes it (it rebuilds every lit material), never to fade.
 *
 * A `castShadow` change re-creates the sun light instead of setting the flag: with PostFX on
 * (WebGPU, three r186), turning a light's shadow back on after it was off crashes the frame
 * ("Texture 'output' ... writable usage and another usage in the same synchronization scope"),
 * while a new light with `castShadow: true` renders fine. The cost is the same one lit-material
 * rebuild either way.
 */
import * as THREE from 'three/webgpu';
import { getECSWorld, type ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import {
  createLightEntity,
  getLightTargetId,
  SHADOW_PRESETS,
  ShadowQuality,
} from '../LightManager';
import { getActiveCamera } from '../CameraManager';
import type { SkyBoxAmbientLightDef, SkyBoxDef, SkyBoxSunLightDef } from './SkyBoxTypes';
import { isAtmosphereEnabled, isGroundEnabled, isOn, type SkyUniforms } from './SkyComposite';
import { GROUND_DEFAULTS } from './layers/ground';
import { computeInscatter } from './layers/atmosphere';
import { toSkyColor } from './skyColor';

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

export const AMBIENT_LIGHT_DEFAULTS = {
  enabled: true,
  type: 'HEMISPHERE' as 'HEMISPHERE' | 'AMBIENT',
  intensity: 0.5,
  skyColor: 'AUTO',
  groundColor: 'AUTO',
};

/** The shadow camera's near plane; its far plane is twice the light's distance. */
const SHADOW_NEAR = 0.5;

type SunLightState = {
  entityId: number;
  castShadow: boolean;
  distance: number;
  follow: 'ACTIVE_CAMERA' | 'ORIGIN';
  /** The sun direction, and the light-space axes the shadow camera's lookAt builds from it. */
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
let sunLight: SunLightState | null = null;
let ambientLight: { entityId: number; type: 'HEMISPHERE' | 'AMBIENT' } | null = null;

// Scratch objects (no allocations on the per-frame path)
const _followPoint = new THREE.Vector3();
const _color = new THREE.Color();
const _vec = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const getLight = <T extends THREE.Light>(entityId: number, world: ECSWorld) =>
  world.getComponent(entityId, ComponentType.OBJECT3D)?.value as T | undefined;

/** 1 with the sun at or above horizonFade[0], 0 at or below horizonFade[1] (degrees). */
const getSunFade = (direction: THREE.Vector3, horizonFade: [number, number]) => {
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
const setLightSpaceAxes = (state: SunLightState) => {
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

// Sun light

const createSunLight = (skyBoxId: string, castShadow: boolean, world: ECSWorld): SunLightState => {
  const entityId = createLightEntity(
    { type: 'DIRECTIONAL', intensity: 0, castShadow },
    {
      appId: `__skybox_${skyBoxId}_SUN_0`,
      managedBy: { manager: SKYBOX_MANAGER_ID, ownerId: skyBoxId, role: 'SUN_0' },
      debugData: { name: 'Sky box sun' },
    },
    world
  );
  return {
    entityId,
    castShadow,
    distance: SUN_LIGHT_DEFAULTS.distance,
    follow: SUN_LIGHT_DEFAULTS.shadowFollow,
    direction: new THREE.Vector3(0, 1, 0),
    axisX: new THREE.Vector3(),
    axisY: new THREE.Vector3(),
    axisZ: new THREE.Vector3(),
    texelSize: 0,
    lastFollow: new THREE.Vector3(),
    needsWrite: true,
  };
};

const applySunLight = (
  state: SunLightState,
  lightDef: SkyBoxSunLightDef,
  def: SkyBoxDef,
  u: SkyUniforms,
  world: ECSWorld
) => {
  const light = getLight<THREE.DirectionalLight>(state.entityId, world);
  if (!light?.isDirectionalLight) return;
  state.direction.copy(u.sun.direction.value);
  setLightSpaceAxes(state);
  const fade = getSunFade(state.direction, lightDef.horizonFade ?? SUN_LIGHT_DEFAULTS.horizonFade);

  const color = lightDef.color ?? SUN_LIGHT_DEFAULTS.color;
  if (color !== 'AUTO') {
    light.color.copy(toSkyColor(color));
  } else if (isAtmosphereEnabled(def)) {
    const fex = u.atmosphere.extinctionAtSun;
    light.color.copy(normalizeColor(_color.setRGB(fex.x, fex.y, fex.z)));
  } else {
    light.color.setRGB(1, 1, 1);
  }
  light.intensity = (lightDef.intensity ?? SUN_LIGHT_DEFAULTS.intensity) * fade;

  // castShadow is set at creation only (see the header: a change re-creates the light)

  // Shadow settings: all of them are read live by the shadow node (a map size change resizes
  // the map on its next render)
  const shadow = light.shadow;
  const preset = SHADOW_PRESETS[lightDef.shadowPreset ?? SUN_LIGHT_DEFAULTS.shadowPreset];
  const mapSize = lightDef.shadowMapSize ?? preset.mapSize[0];
  shadow.mapSize.set(mapSize, mapSize);
  shadow.bias = lightDef.shadowBias ?? preset.bias;
  shadow.normalBias = lightDef.shadowNormalBias ?? preset.normalBias;
  shadow.radius = preset.radius;
  shadow.blurSamples = preset.blurSamples;
  shadow.intensity = fade;
  // Below the horizon the shadow map isn't rendered
  shadow.autoUpdate = fade > 0;

  const half = lightDef.shadowFrustumSize ?? SUN_LIGHT_DEFAULTS.shadowFrustumSize;
  state.distance = lightDef.distance ?? SUN_LIGHT_DEFAULTS.distance;
  const camera = shadow.camera;
  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half;
  camera.near = SHADOW_NEAR;
  camera.far = state.distance * 2;
  camera.updateProjectionMatrix();
  state.texelSize = (half * 2) / mapSize;
  state.follow = lightDef.shadowFollow ?? SUN_LIGHT_DEFAULTS.shadowFollow;
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
 * Moves the sun light with its follow point (the active camera, or the origin), snapped to
 * shadow map texels in light space so the shadows don't shimmer as it slides (depth unsnapped:
 * moving along the light doesn't shimmer). Called every frame by skyBoxSystem (MAIN, before
 * object3DSyncSystem); writes nothing while the follow point and settings are unchanged. The
 * camera's world matrix is last frame's here, which a texel-snapped frustum doesn't notice.
 */
export const updateSkyLightsFrame = (world: ECSWorld) => {
  const state = sunLight;
  if (!state) return;
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
  // Fades with the sun like its light does (with the sun light's fade range, if it has one)
  const fade = getSunFade(
    u.sun.direction.value,
    def.suns?.[0]?.light?.horizonFade ?? SUN_LIGHT_DEFAULTS.horizonFade
  );
  light.intensity = ambientDef.intensity ?? AMBIENT_LIGHT_DEFAULTS.intensity;

  const skyColor = ambientDef.skyColor ?? AMBIENT_LIGHT_DEFAULTS.skyColor;
  if (skyColor !== 'AUTO') {
    light.color.copy(toSkyColor(skyColor));
  } else {
    if (isAtmosphereEnabled(def)) {
      computeInscatter(UP, u.atmosphere, u.sun.direction.value, _vec);
      normalizeColor(_color.setRGB(_vec.x, _vec.y, _vec.z));
    } else {
      _color.setRGB(1, 1, 1);
    }
    light.color.copy(_color.multiplyScalar(fade));
  }

  if ((light as THREE.HemisphereLight).isHemisphereLight) {
    const groundColor = ambientDef.groundColor ?? AMBIENT_LIGHT_DEFAULTS.groundColor;
    const ground = (light as THREE.HemisphereLight).groundColor;
    if (groundColor !== 'AUTO') ground.copy(toSkyColor(groundColor));
    else {
      // The ground layer's colour (its default without one), faded with the sun
      const color = isGroundEnabled(def) ? def.ground?.color : undefined;
      ground.copy(toSkyColor(color ?? GROUND_DEFAULTS.color)).multiplyScalar(fade);
    }
  }
};

// Lifecycle

const deleteSunLight = (world: ECSWorld) => {
  // Also deletes its target (LightManager's delete hook)
  if (sunLight) world.deleteEntity(sunLight.entityId);
  sunLight = null;
};

const deleteAmbientLight = (world: ECSWorld) => {
  if (ambientLight) world.deleteEntity(ambientLight.entityId);
  ambientLight = null;
};

/** Deletes the sky box's lights (clearSkyBox, or another sky box activating). */
export const deleteSkyLights = () => {
  const world = getECSWorld();
  deleteSunLight(world);
  deleteAmbientLight(world);
  ownerId = null;
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
  if (sunLight && !world.isAlive(sunLight.entityId)) sunLight = null;
  if (ambientLight && !world.isAlive(ambientLight.entityId)) ambientLight = null;

  const lightDef = def.suns?.[0]?.light;
  if (lightDef && isOn(lightDef)) {
    const castShadow = lightDef.castShadow ?? SUN_LIGHT_DEFAULTS.castShadow;
    // Also when something else changed the light's flag: never toggle it in place
    const current = sunLight && getLight<THREE.DirectionalLight>(sunLight.entityId, world);
    if (sunLight && (sunLight.castShadow !== castShadow || current?.castShadow !== castShadow)) {
      deleteSunLight(world);
    }
    sunLight ??= createSunLight(skyBoxId, castShadow, world);
    applySunLight(sunLight, lightDef, def, u, world);
  } else {
    deleteSunLight(world);
  }

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

/** The sky box's managed light entity ids (debug and tests). */
export const getSkyLightIds = () => ({
  sun: sunLight?.entityId ?? null,
  ambient: ambientLight?.entityId ?? null,
});
