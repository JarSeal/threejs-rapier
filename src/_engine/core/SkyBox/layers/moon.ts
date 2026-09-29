/**
 * Moon layer: the disc, drawn as a small sphere lit by the sun into its phase, behind the
 * atmosphere (which gives it its extinction and hides it by day, like the sun disc). moons[0]
 * only until p114.
 *
 * The disc's lit direction is the moon's direction turned toward the sun by the phase's
 * elongation, taken the short way (`2π · phase` folded into [0, π]): the phase always shows as
 * given (0 new, 0.5 full) with the lit side facing the sun, whether day-night places the moon
 * (SkyTime.ts, where that is about the true elongation) or its elevation and azimuth do.
 */
import * as THREE from 'three/webgpu';
import {
  atan,
  asin,
  dot,
  float,
  fwidth,
  max,
  mix,
  smoothstep,
  sqrt,
  step,
  texture as textureNode,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { SkyBoxEnvSize, SkyBoxMoonDef, SkyBoxMoonTextureDef } from '../SkyBoxTypes';
import type { SkyCompositeMode } from '../SkyComposite';
import { toSkyColor } from '../skyColor';
import { getTexture, loadTextureAsync } from '../../Texture';
import { isDebugEnvironment } from '../../Config';
import { lerror } from '../../../utils/Logger';
import { MOON_TIME_DEFAULTS } from '../SkyTime';
import { SUN_DISC_RADIUS } from './sun';

export const MOON_DEFAULTS = {
  enabled: true,
  elevation: 30,
  azimuth: 0,
  discSize: 1,
  intensity: 2,
  color: '#ffffff',
  limbDarkening: 0.2,
  earthshine: 0.02,
  ...MOON_TIME_DEFAULTS,
};

/** Moonlight's colour (#b8c6ff): the moon light's AUTO colour, and the clouds' moonlight. */
export const MOONLIGHT_COLOR = new THREE.Color('#b8c6ff');

/** The env bake's glow (without a moon light): at most this bright, at least this many bake
 * texels wide (as the sun's, layers/sun.ts). */
const ENV_DISC_CLAMP = 20;
const ENV_DISC_MIN_TEXELS = 2;

export type MoonUniforms = {
  /** The moon's unit direction. */
  direction: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** The disc's right and up axes (the sky's up projected onto the disc). */
  axisU: THREE.UniformNode<'vec3', THREE.Vector3>;
  axisV: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** Where the disc's sphere is lit from (world direction). */
  lightDir: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** Sine of the disc's angular radius (its offsets are normalized by it). */
  sinRadius: THREE.UniformNode<'float', number>;
  /** Cosine of the env bake's (wider) disc radius. */
  envDiscCos: THREE.UniformNode<'float', number>;
  radiance: THREE.UniformNode<'float', number>;
  /** The env bake's glow: the radiance times the lit fraction, clamped. */
  envRadiance: THREE.UniformNode<'float', number>;
  color: THREE.UniformNode<'color', THREE.Color>;
  earthshine: THREE.UniformNode<'float', number>;
  limbDarkening: THREE.UniformNode<'float', number>;
  /** CPU only: the lit fraction of the disc, (1 − cos 2π·phase) / 2. */
  illuminatedFraction: number;
};

export const createMoonUniforms = (): MoonUniforms => ({
  direction: uniform(new THREE.Vector3(0, 1, 0)),
  axisU: uniform(new THREE.Vector3(1, 0, 0)),
  axisV: uniform(new THREE.Vector3(0, 0, -1)),
  lightDir: uniform(new THREE.Vector3(0, -1, 0)),
  sinRadius: uniform(Math.sin(SUN_DISC_RADIUS)),
  envDiscCos: uniform(1),
  radiance: uniform(MOON_DEFAULTS.intensity),
  envRadiance: uniform(0),
  color: uniform(new THREE.Color(1, 1, 1)),
  earthshine: uniform(MOON_DEFAULTS.earthshine),
  limbDarkening: uniform(MOON_DEFAULTS.limbDarkening),
  illuminatedFraction: 1,
});

/** The moon's unit direction from its elevation and azimuth (degrees), as the sun's
 * (getFixedSunDirection). Day-night places it from the time and phase instead (SkyTime.ts). */
export const getFixedMoonDirection = (moon: SkyBoxMoonDef | undefined, out: THREE.Vector3) =>
  out.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - (moon?.elevation ?? MOON_DEFAULTS.elevation)),
    THREE.MathUtils.degToRad(moon?.azimuth ?? MOON_DEFAULTS.azimuth)
  );

/** Writes the moon's settings (its direction and phase follow in applyMoonPositionUniforms). */
export const applyMoonUniforms = (
  u: MoonUniforms,
  moon: SkyBoxMoonDef | undefined,
  envSize: SkyBoxEnvSize
) => {
  const radius = SUN_DISC_RADIUS * (moon?.discSize ?? MOON_DEFAULTS.discSize);
  u.sinRadius.value = Math.max(Math.sin(radius), 1e-6);
  u.envDiscCos.value = Math.cos(Math.max(radius, (ENV_DISC_MIN_TEXELS * Math.PI) / 2 / envSize));
  u.radiance.value = moon?.intensity ?? MOON_DEFAULTS.intensity;
  u.color.value.copy(toSkyColor(moon?.color ?? MOON_DEFAULTS.color));
  u.earthshine.value = moon?.earthshine ?? MOON_DEFAULTS.earthshine;
  u.limbDarkening.value = moon?.limbDarkening ?? MOON_DEFAULTS.limbDarkening;
};

const UP = new THREE.Vector3(0, 1, 0);
const _toSun = new THREE.Vector3();

/**
 * Writes what follows the moon's direction (written first) and phase: the disc's axes, its lit
 * direction, lit fraction and env glow. The day-night step calls it every time the sky moves:
 * it allocates nothing.
 */
export const applyMoonPositionUniforms = (
  u: MoonUniforms,
  sunDirection: THREE.Vector3,
  phase: number
) => {
  const direction = u.direction.value;
  // The disc's up is the sky's up (toward the zenith); straight up, -z
  const axisV = u.axisV.value.copy(UP).addScaledVector(direction, -direction.y);
  if (axisV.lengthSq() < 1e-8) axisV.set(0, 0, -1);
  axisV.normalize();
  // Right, as a camera looking along the direction sees it
  u.axisU.value.crossVectors(direction, axisV).normalize();

  // Toward the sun across the disc; with the sun right behind or in front, the disc's up
  const toSun = _toSun.copy(sunDirection).addScaledVector(direction, -sunDirection.dot(direction));
  if (toSun.lengthSq() < 1e-8) toSun.copy(axisV);
  toSun.normalize();
  // The angle to the sun is the elongation the short way: 0.25 and 0.75 are both lit on the
  // sun's side
  const elongation = Math.PI - Math.abs(Math.PI - Math.PI * 2 * phase);
  u.lightDir.value
    .copy(direction)
    .multiplyScalar(Math.cos(elongation))
    .addScaledVector(toSun, Math.sin(elongation));

  u.illuminatedFraction = (1 - Math.cos(elongation)) / 2;
  u.envRadiance.value = Math.min(u.radiance.value * u.illuminatedFraction, ENV_DISC_CLAMP);
};

// Texture

export const MOON_TEXTURE_DEFAULTS = { projection: 'DISC' as 'DISC' | 'EQUIRECTANGULAR' };

/** Loads (or finds, by textureId) the moon's texture; null without one or on a failed load. */
export const loadMoonTexture = async (moon: SkyBoxMoonDef | undefined) => {
  const def = moon?.texture;
  if (!def) return null;
  let texture: THREE.Texture | null = null;
  if (def.file) {
    texture = await loadTextureAsync({
      id: def.textureId,
      fileName: def.file,
      path: def.path,
      throwOnError: isDebugEnvironment(),
    });
  } else if (def.textureId) {
    texture = getTexture(def.textureId) || null;
  }
  if (!texture) {
    lerror(`Could not find or load the moon texture (${JSON.stringify(def)}).`);
    return null;
  }
  const colorSpace = (def.colorSpace as THREE.ColorSpace) || THREE.SRGBColorSpace;
  if (texture.colorSpace !== colorSpace) {
    texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
  }
  return texture;
};

/** The texture's colour at a point of the disc's sphere (x right, y up, z toward the viewer). */
const sampleMoonTexture = (
  map: THREE.Texture,
  def: SkyBoxMoonTextureDef,
  x: THREE.Node<'float'>,
  y: THREE.Node<'float'>,
  z: THREE.Node<'float'>
) => {
  const projection = def.projection ?? MOON_TEXTURE_DEFAULTS.projection;
  const uv =
    projection === 'DISC'
      ? vec2(x, y).mul(0.5).add(0.5)
      : vec2(
          atan(x, z)
            .div(Math.PI * 2)
            .add(0.5),
          asin(y.clamp(-1, 1)).div(Math.PI).add(0.5)
        );
  // TSL's typings don't take a built vec2 here (three r186)
  const uvNode = uv as unknown as Parameters<typeof textureNode>[1];
  return textureNode(map, uvNode).rgb as unknown as THREE.Node<'vec3'>;
};

/**
 * The moon over `behind`. VIEW: the lit sphere (the phase, earthshine and limb darkening, and the
 * texture), antialiased at the rim. No branch: implicit-derivative work (fwidth, the texture
 * sample) must stay in uniform control flow on WebGPU, and a few dot products per sky pixel are
 * cheap. ENV_BAKE: nothing when the moon has a light (it gives that highlight); otherwise a
 * clamped glow a few bake texels wide, scaled by the lit fraction.
 */
export const moonNode = (
  dir: THREE.Node<'vec3'>,
  behind: THREE.Node,
  u: MoonUniforms,
  mode: SkyCompositeMode,
  hasLight: boolean,
  map: { texture: THREE.Texture; def: SkyBoxMoonTextureDef } | null
): THREE.Node => {
  const back = behind as THREE.Node<'vec3'>;
  const cosTheta = dot(dir, u.direction);
  if (mode === 'ENV_BAKE') {
    if (hasLight) return back;
    // Between cos(2r) and cos(r)
    const glow = smoothstep(
      u.envDiscCos.mul(u.envDiscCos).mul(2.0).sub(1.0),
      u.envDiscCos,
      cosTheta
    );
    return back.add(u.color.mul(glow.mul(u.envRadiance)));
  }

  // The view direction's offset from the disc's centre, in disc radii (only the front half)
  const inFront = step(0.0, cosTheta);
  const x = dot(dir, u.axisU).div(u.sinRadius);
  const y = dot(dir, u.axisV).div(u.sinRadius);
  const rho = sqrt(x.mul(x).add(y.mul(y)));
  const edge = max(fwidth(rho), 1e-4);
  const mask = float(1.0)
    .sub(smoothstep(float(1.0).sub(edge), 1.0, rho))
    .mul(inFront);

  // The point on the sphere, and its normal (toward the viewer: -direction)
  const clampedRho = max(rho, 1.0);
  const sx = x.div(clampedRho);
  const sy = y.div(clampedRho);
  const z = sqrt(max(float(1.0).sub(sx.mul(sx).add(sy.mul(sy))), 0.0));
  const normal = vec3(u.axisU).mul(sx).add(vec3(u.axisV).mul(sy)).sub(vec3(u.direction).mul(z));
  const lit = max(dot(normal, u.lightDir), 0.0).add(u.earthshine);
  const limb = mix(float(1.0), z, u.limbDarkening);
  const shade = lit.mul(limb).mul(mask).mul(u.radiance);
  const tint = u.color as unknown as THREE.Node<'vec3'>;
  const moon = map
    ? tint.mul(sampleMoonTexture(map.texture, map.def, sx, sy, z)).mul(shade)
    : tint.mul(shade);
  return back.add(moon);
};
