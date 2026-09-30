/**
 * Nebula layer (p114): procedural emission nebulae, baked into the static-layers cube
 * (SkyStaticLayers.ts), never evaluated per frame. Each nebula is a patch of the sky around its
 * direction: an elliptical shape (size, stretch, orientation, falloff) that erodes a
 * domain-warped fbm cloud (filaments over a soft glow), coloured by density through 2-3 colour
 * stops, with dark dust lanes (ridged fbm) cut out of it. The cube's alpha holds each nebula's star boost (the live stars
 * layer reads it, see layers/stars.ts).
 *
 * The noise runs on the 3D direction (never on cube face UVs), so the bake is seamless. The warp
 * uses three float fbm calls instead of mx_fractal_noise_vec3, which hangs SwiftShader's WebGL2.
 * Everything but `octaves` (and which nebulae exist) is a uniform, so a param change only
 * re-bakes; the nebulae are unrolled at build time.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  acos,
  float,
  Fn,
  If,
  length,
  max,
  mix,
  mx_fractal_noise_float as fractalNoise,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SkyBoxNebulaDef } from '../SkyBoxTypes';
import { toSkyColor } from '../skyColor';

export const NEBULA_DEFAULTS = {
  enabled: true,
  seed: 0,
  direction: [0, 0.2, -1] as [number, number, number],
  size: 25,
  falloff: 0.6,
  stretch: 1,
  orientation: 0,
  colors: ['#1c1450', '#b0307a', '#ffc49a'],
  density: 0.5,
  octaves: 5,
  warp: 0.6,
  dust: 0.4,
  brightness: 1,
  starBoost: 0,
};

/** The most nebulae a sky box can have (the schema's limit): one uniform set each. */
export const MAX_NEBULAE = 8;

/** Noise cycles per radian of the nebula's size: its detail scales with it. */
const NOISE_FREQUENCY = 2.2;
/** How far the warp can push the density noise's domain (at warp 1). */
const WARP_SCALE = 1.2;
const WARP_OCTAVES = 3;
/** The dust lanes' noise, relative to the density noise, and how thin they are. */
const DUST_FREQUENCY = 1.8;
const DUST_OCTAVES = 3;
const DUST_LANE_WIDTH = 0.12;
/** The cloud: bright filaments over a soft body (the diffuse glow), and how much of the body's
 * brightness follows the noise. */
const FILAMENT_WEIGHT = 0.75;
const FILAMENT_SOFTNESS = 0.5;
const BODY_WEIGHT = 0.35;
const BODY_NOISE = 0.7;
/** The density noise's offsets for the three warp channels and the dust. */
const WARP_OFFSETS = [
  [17.3, 5.1, 9.7],
  [3.9, 21.7, 13.1],
  [11.2, 7.4, 27.5],
] as const;
const DUST_OFFSET = [41.7, 33.3, 19.9] as const;

export type NebulaUniforms = {
  /** The centre direction (unit, in the static layers' frame), and the shape's long and short
   * axes on the sky (unit, perpendicular to it). */
  center: THREE.UniformNode<'vec3', THREE.Vector3>;
  axisU: THREE.UniformNode<'vec3', THREE.Vector3>;
  axisV: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** Angular radius (radians), and the cosine of the widest extent (the early out). */
  size: THREE.UniformNode<'float', number>;
  extentCos: THREE.UniformNode<'float', number>;
  /** Where the edge fade starts (1 - falloff, in units of the radius). */
  fadeStart: THREE.UniformNode<'float', number>;
  stretch: THREE.UniformNode<'float', number>;
  frequency: THREE.UniformNode<'float', number>;
  /** The noise domain's offset (from the seed). */
  offset: THREE.UniformNode<'vec3', THREE.Vector3>;
  density: THREE.UniformNode<'float', number>;
  warp: THREE.UniformNode<'float', number>;
  dust: THREE.UniformNode<'float', number>;
  brightness: THREE.UniformNode<'float', number>;
  starBoost: THREE.UniformNode<'float', number>;
  color0: THREE.UniformNode<'color', THREE.Color>;
  color1: THREE.UniformNode<'color', THREE.Color>;
  color2: THREE.UniformNode<'color', THREE.Color>;
  /** 1 with two colour stops, 2 with three (the ramp's segment count). */
  segments: THREE.UniformNode<'float', number>;
};

const createNebulaUniforms = (): NebulaUniforms => ({
  center: uniform(new THREE.Vector3(0, 0, -1)),
  axisU: uniform(new THREE.Vector3(1, 0, 0)),
  axisV: uniform(new THREE.Vector3(0, 1, 0)),
  size: uniform(0.4),
  extentCos: uniform(0.9),
  fadeStart: uniform(0.4),
  stretch: uniform(1),
  frequency: uniform(5),
  offset: uniform(new THREE.Vector3()),
  density: uniform(NEBULA_DEFAULTS.density),
  warp: uniform(NEBULA_DEFAULTS.warp),
  dust: uniform(NEBULA_DEFAULTS.dust),
  brightness: uniform(NEBULA_DEFAULTS.brightness),
  starBoost: uniform(NEBULA_DEFAULTS.starBoost),
  color0: uniform(new THREE.Color()),
  color1: uniform(new THREE.Color()),
  color2: uniform(new THREE.Color()),
  segments: uniform(2),
});

/** One uniform set per possible nebula, created once per activation. */
export const createNebulaeUniforms = () =>
  Array.from({ length: MAX_NEBULAE }, () => createNebulaUniforms());

/** The enabled nebulae (the ones in the bake, in order: the i-th gets uniform set i). */
export const getEnabledNebulae = (nebulae: SkyBoxNebulaDef[] | undefined) =>
  (nebulae || []).filter((nebula) => nebula.enabled !== false).slice(0, MAX_NEBULAE);

/** mulberry32: the same seed always gives the same offsets. */
const seededRandom = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const _up = new THREE.Vector3();

/** Writes a nebula's centre and its shape's axes: U along `orientation` (degrees, from the
 * sky's "up" around the centre), V across it. */
const writeFrame = (u: NebulaUniforms, def: SkyBoxNebulaDef) => {
  const [x, y, z] = def.direction ?? NEBULA_DEFAULTS.direction;
  const center = u.center.value.set(x, y, z);
  if (center.lengthSq() === 0) center.set(...NEBULA_DEFAULTS.direction);
  center.normalize();
  // "Up" on the sky at the centre: toward +y, or +z at the poles
  _up.set(0, 1, 0);
  if (Math.abs(center.y) > 0.999) _up.set(0, 0, 1);
  const axisV = u.axisV.value.copy(_up).addScaledVector(center, -_up.dot(center)).normalize();
  const axisU = u.axisU.value.crossVectors(axisV, center).normalize();
  const angle = THREE.MathUtils.degToRad(def.orientation ?? NEBULA_DEFAULTS.orientation);
  // Rotate both about the centre
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  _up.copy(axisU);
  axisU.multiplyScalar(cos).addScaledVector(axisV, sin);
  axisV.multiplyScalar(cos).addScaledVector(_up, -sin);
};

/** Writes the enabled nebulae's values to their uniform sets. */
export const applyNebulaeUniforms = (
  uniforms: NebulaUniforms[],
  nebulae: SkyBoxNebulaDef[] | undefined
) => {
  getEnabledNebulae(nebulae).forEach((def, i) => {
    const u = uniforms[i];
    writeFrame(u, def);
    const size = THREE.MathUtils.degToRad(def.size ?? NEBULA_DEFAULTS.size);
    const stretch = Math.max(1, def.stretch ?? NEBULA_DEFAULTS.stretch);
    u.size.value = size;
    u.stretch.value = stretch;
    u.extentCos.value = Math.cos(Math.min(size * stretch, Math.PI));
    u.fadeStart.value = THREE.MathUtils.clamp(
      1 - (def.falloff ?? NEBULA_DEFAULTS.falloff),
      0,
      0.999
    );
    u.frequency.value = NOISE_FREQUENCY / size;
    const random = seededRandom(def.seed ?? NEBULA_DEFAULTS.seed);
    u.offset.value.set(random() * 1000, random() * 1000, random() * 1000);
    u.density.value = def.density ?? NEBULA_DEFAULTS.density;
    u.warp.value = def.warp ?? NEBULA_DEFAULTS.warp;
    u.dust.value = def.dust ?? NEBULA_DEFAULTS.dust;
    u.brightness.value = def.brightness ?? NEBULA_DEFAULTS.brightness;
    u.starBoost.value = def.starBoost ?? NEBULA_DEFAULTS.starBoost;
    const colors = def.colors?.length ? def.colors : NEBULA_DEFAULTS.colors;
    u.color0.value.copy(toSkyColor(colors[0]));
    u.color1.value.copy(toSkyColor(colors[1] ?? colors[0]));
    u.color2.value.copy(toSkyColor(colors[2] ?? colors[1] ?? colors[0]));
    u.segments.value = colors.length >= 3 ? 2 : 1;
  });
};

/** The structural part of the nebulae: which exist, and their octaves. */
export const getNebulaeSignature = (nebulae: SkyBoxNebulaDef[] | undefined) =>
  getEnabledNebulae(nebulae)
    .map((nebula) => getOctaves(nebula))
    .join(',');

const getOctaves = (def: SkyBoxNebulaDef) =>
  THREE.MathUtils.clamp(Math.round(def.octaves ?? NEBULA_DEFAULTS.octaves), 2, 6);

const offsetVec = (offset: readonly number[]) => vec3(offset[0], offset[1], offset[2]);

/** A colour uniform as the vec3 it is in the shader (the types keep 'color' apart). */
const rgb = (color: THREE.UniformNode<'color', THREE.Color>) =>
  color as unknown as THREE.Node<'vec3'>;

/**
 * One nebula's emission (rgb) and star boost (a) in direction `s` (the static layers' frame).
 * Zero outside its widest extent, where it's skipped (the bake is not a view, so the branch has
 * no derivative to break).
 */
const nebulaNode = (s: THREE.Node<'vec3'>, u: NebulaUniforms, octaves: number) =>
  Fn(() => {
    const result = vec4(0).toVar();
    const along = s.dot(u.center);
    If(along.greaterThan(u.extentCos), () => {
      // Azimuthal equidistant around the centre: angle from it, along the shape's axes
      const x = s.dot(u.axisU);
      const y = s.dot(u.axisV);
      const angle = acos(along.clamp(-1, 1));
      const onSky = vec2(x, y)
        .div(max(length(vec2(x, y)), 1e-6))
        .mul(angle);
      const radius = length(vec2(onSky.x.div(u.stretch), onSky.y)).div(u.size);
      const shape = float(1).sub(smoothstep(u.fadeStart, 1, radius));

      const q = s.mul(u.frequency).add(u.offset);
      const warp = vec3(
        fractalNoise(q.add(offsetVec(WARP_OFFSETS[0])), WARP_OCTAVES, 2, 0.5),
        fractalNoise(q.add(offsetVec(WARP_OFFSETS[1])), WARP_OCTAVES, 2, 0.5),
        fractalNoise(q.add(offsetVec(WARP_OFFSETS[2])), WARP_OCTAVES, 2, 0.5)
      );
      const warped = q.add(warp.mul(u.warp.mul(WARP_SCALE)));
      const noise = fractalNoise(warped, octaves, 2, 0.5).mul(0.5).add(0.5);
      // A soft body (the diffuse glow) under the filaments, which the shape erodes toward its
      // edge (wispy, not a clean ellipse)
      const body = shape.mul(shape).mul(noise.mul(BODY_NOISE).add(1 - BODY_NOISE));
      const threshold = float(0.7).sub(u.density.mul(0.5));
      const filaments = smoothstep(
        threshold,
        threshold.add(FILAMENT_SOFTNESS),
        noise.add(shape.sub(1).mul(0.5))
      ).mul(shape);
      const cloud = filaments.mul(FILAMENT_WEIGHT).add(body.mul(BODY_WEIGHT)).toVar();

      // Dust: thin dark lanes where the ridged noise peaks
      const ridge = float(1).sub(
        abs(
          fractalNoise(warped.mul(DUST_FREQUENCY).add(offsetVec(DUST_OFFSET)), DUST_OCTAVES, 2, 0.5)
        )
      );
      const lanes = smoothstep(float(1).sub(DUST_LANE_WIDTH), 1, ridge);

      // Colour by density: color0 at the thin edges to color2 in the dense core
      const t = cloud.mul(u.segments);
      const color = mix(
        mix(rgb(u.color0), rgb(u.color1), t.clamp(0, 1)),
        rgb(u.color2),
        t.sub(1).clamp(0, 1)
      );
      const emission = color
        .mul(cloud)
        .mul(u.brightness)
        .mul(float(1).sub(lanes.mul(u.dust)));
      result.assign(vec4(emission, cloud.mul(u.starBoost)));
    });
    return result;
  })();

/**
 * Every enabled nebula summed (rgb, additive) with the strongest star boost (a), in direction
 * `dir` (the static layers' frame). What the static-layers cube bakes.
 */
export const nebulaeNode = (
  dir: THREE.Node<'vec3'>,
  nebulae: SkyBoxNebulaDef[] | undefined,
  uniforms: NebulaUniforms[]
): THREE.Node<'vec4'> => {
  const enabled = getEnabledNebulae(nebulae);
  // Built once, before any nebula's branch (they all share it)
  const s = vec3(dir).toVar();
  let color: THREE.Node<'vec3'> = vec3(0);
  let boost: THREE.Node<'float'> = float(0);
  enabled.forEach((def, i) => {
    const nebula = nebulaNode(s, uniforms[i], getOctaves(def)).toVar();
    color = color.add(nebula.rgb);
    boost = max(boost, nebula.a);
  });
  return vec4(color, boost.clamp(0, 1));
};
