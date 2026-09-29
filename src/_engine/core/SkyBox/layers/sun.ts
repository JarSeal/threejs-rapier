/**
 * Sun layer: the disc and an optional halo, drawn behind the atmosphere (which gives it its
 * extinction colour, as SkyMesh does, three r186 `SkyMesh.js:275-276`). suns[0]'s direction also
 * drives the atmosphere. Only suns[0] is drawn until p114.
 */
import * as THREE from 'three/webgpu';
import { dot, max, pow, smoothstep, uniform } from 'three/tsl';
import type { SkyBoxEnvSize, SkyBoxSunDef } from '../SkyBoxTypes';
import type { SkyCompositeMode } from '../SkyComposite';
import { toSkyColor } from '../skyColor';
import type { AtmosphereUniforms } from './atmosphere';

export const SUN_STRUCTURAL_KEYS = ['enabled'] as const;

export const SUN_DEFAULTS = {
  enabled: true,
  elevation: 30,
  azimuth: 180,
  discSize: 1,
  discIntensity: 40,
  glowIntensity: 0,
  glowSize: 10,
  color: 'AUTO',
};

/** SkyMesh's disc (:230, :275-276): it compares the angle to the sun against 0.533° (its
 * comment says the angular diameter, but it's used as the radius), with this edge sharpness and
 * scale. */
const DISC_RADIUS = Math.acos(0.9999566769464484);
const DISC_EDGE = 50000;
const DISC_SCALE = 760;
/** The env bake's disc: at most this bright (GGX fireflies, p110 §0.2), and at least this many
 * bake texels wide. */
const ENV_DISC_CLAMP = 20;
const ENV_DISC_MIN_TEXELS = 2;
/** Keeps a custom colour's extinction compensation finite near the horizon. */
const MIN_EXTINCTION = 1e-3;

export type SunUniforms = {
  /** The primary sun's unit direction (the atmosphere's too). */
  direction: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** Cosine of the disc's angular radius (VIEW), and of the env bake's wider one. */
  discCos: THREE.UniformNode<'float', number>;
  envDiscCos: THREE.UniformNode<'float', number>;
  /** The disc's radiance before the atmosphere (VIEW), and clamped for the env bake. */
  discRadiance: THREE.UniformNode<'float', number>;
  envDiscRadiance: THREE.UniformNode<'float', number>;
  glowIntensity: THREE.UniformNode<'float', number>;
  /** pow(cosTheta, glowExponent) is 0.5 at glowSize degrees. */
  glowExponent: THREE.UniformNode<'float', number>;
  /** White for 'AUTO'; a custom colour divided by the extinction at the sun, so it is seen as
   * given once the atmosphere has dimmed it. */
  tint: THREE.UniformNode<'color', THREE.Color>;
  /** CPU only: the disc's peak radiance (discIntensity), and its colour as given (linear; used
   * unless isAutoColor). The lighting write (applySunLightingUniforms) derives from these. */
  peakRadiance: number;
  color: THREE.Color;
  isAutoColor: boolean;
};

export const createSunUniforms = (): SunUniforms => ({
  direction: uniform(new THREE.Vector3(0, 1, 0)),
  discCos: uniform(1),
  envDiscCos: uniform(1),
  discRadiance: uniform(0),
  envDiscRadiance: uniform(0),
  glowIntensity: uniform(0),
  glowExponent: uniform(1),
  tint: uniform(new THREE.Color(1, 1, 1)),
  peakRadiance: SUN_DEFAULTS.discIntensity,
  color: new THREE.Color(1, 1, 1),
  isAutoColor: true,
});

/**
 * A sun's unit direction from its elevation and azimuth (degrees), the way three's sky example
 * places it: azimuth 0 = +z, 90 = +x, 180 = -z. Day-night derives it from the time instead
 * (SkyTime.ts).
 */
export const getFixedSunDirection = (sun: SkyBoxSunDef | undefined, out: THREE.Vector3) => {
  const elevation = sun?.elevation ?? SUN_DEFAULTS.elevation;
  const azimuth = sun?.azimuth ?? SUN_DEFAULTS.azimuth;
  return out.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevation),
    THREE.MathUtils.degToRad(azimuth)
  );
};

/**
 * Writes the sun's uniforms (its direction is written first, see applySkyUniforms).
 * @param atmosphere the atmosphere's uniforms when it is enabled (its sun terms written already)
 */
export const applySunUniforms = (
  u: SunUniforms,
  sun: SkyBoxSunDef | undefined,
  atmosphere: AtmosphereUniforms | null,
  envSize: SkyBoxEnvSize
) => {
  const radius = DISC_RADIUS * (sun?.discSize ?? SUN_DEFAULTS.discSize);
  u.discCos.value = Math.cos(radius);
  u.envDiscCos.value = Math.cos(Math.max(radius, (ENV_DISC_MIN_TEXELS * Math.PI) / 2 / envSize));

  u.glowIntensity.value = sun?.glowIntensity ?? SUN_DEFAULTS.glowIntensity;
  const glowSize = THREE.MathUtils.degToRad(sun?.glowSize ?? SUN_DEFAULTS.glowSize);
  u.glowExponent.value = Math.log(0.5) / Math.log(Math.cos(glowSize));

  u.peakRadiance = sun?.discIntensity ?? SUN_DEFAULTS.discIntensity;
  const color = sun?.color ?? SUN_DEFAULTS.color;
  u.isAutoColor = color === 'AUTO';
  if (color !== 'AUTO') u.color.copy(toSkyColor(color));

  applySunLightingUniforms(u, atmosphere);
};

/**
 * Writes what the atmosphere's sun terms change: the disc's radiance and a custom colour's
 * extinction compensation. The day-night step calls it every time the sun moves: it
 * allocates nothing.
 */
export const applySunLightingUniforms = (u: SunUniforms, atmosphere: AtmosphereUniforms | null) => {
  // SkyMesh's peak is min(sunE · Fex, 80) · 760 (~60,800): here the peak is discIntensity, and
  // the sun's energy only takes it down (below the horizon, sunE goes to 0)
  const radiance = atmosphere
    ? Math.min(atmosphere.sunE.value * DISC_SCALE, u.peakRadiance)
    : u.peakRadiance;
  u.discRadiance.value = radiance;
  u.envDiscRadiance.value = Math.min(radiance, ENV_DISC_CLAMP);

  if (u.isAutoColor) {
    u.tint.value.setRGB(1, 1, 1);
  } else {
    const fex = atmosphere?.extinctionAtSun;
    u.tint.value.setRGB(
      u.color.r / Math.max(fex?.x ?? 1, MIN_EXTINCTION),
      u.color.g / Math.max(fex?.y ?? 1, MIN_EXTINCTION),
      u.color.b / Math.max(fex?.z ?? 1, MIN_EXTINCTION)
    );
  }
};

/**
 * The sun over `behind`. ENV_BAKE: no disc when the sun has a light (the light gives that
 * highlight, twice would double it); otherwise the disc widened to a few bake texels (a 0.5°
 * disc is sub-texel there) and clamped, so the GGX filter doesn't sparkle. The halo stays.
 */
export const sunNode = (
  dir: THREE.Node<'vec3'>,
  behind: THREE.Node,
  u: SunUniforms,
  mode: SkyCompositeMode,
  hasLight: boolean
): THREE.Node => {
  const cosTheta = dot(dir, u.direction);
  const glow = pow(max(cosTheta, 0.0), u.glowExponent).mul(u.glowIntensity);
  if (mode === 'ENV_BAKE' && hasLight) return (behind as THREE.Node<'vec3'>).add(u.tint.mul(glow));
  const disc =
    mode === 'VIEW'
      ? cosTheta.sub(u.discCos).mul(DISC_EDGE).clamp(0.0, 1.0).mul(u.discRadiance)
      : // Between cos(2r) and cos(r)
        smoothstep(u.envDiscCos.mul(u.envDiscCos).mul(2.0).sub(1.0), u.envDiscCos, cosTheta).mul(
          u.envDiscRadiance
        );
  return (behind as THREE.Node<'vec3'>).add(u.tint.mul(disc.add(glow)));
};
