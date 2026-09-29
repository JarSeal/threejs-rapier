/**
 * Clouds layer, ported from three.js r186 `examples/jsm/objects/SkyMesh.js:280-379` (MIT
 * License, Copyright © 2010-2026 three.js authors): gradient noise, 4-octave fbm, Beer-powder
 * self-shadowing and a silver lining, composited through the atmosphere so distant clouds
 * dissolve into haze. They need the atmosphere (they are lit by its sun and seen through its
 * extinction), and are lit by the primary sun (p113 adds moonlight).
 *
 * Differences from SkyMesh: a `color` tint and a `windDirection` (SkyMesh scrolls along
 * (1, 1), the default here); the dayFactor and the horizon fade width are computed on the CPU;
 * and the env bake's clouds are frozen at the bake's time (ENV_BAKE).
 * With the defaults, the atmosphere's exposure at 1 and no sun disc, it's SkyMesh's clouds.
 */
import * as THREE from 'three/webgpu';
import {
  clamp,
  dot,
  exp,
  float,
  floor,
  Fn,
  fract,
  If,
  Loop,
  max,
  mix,
  pow,
  smoothstep,
  sub,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { SkyBoxCloudsDef } from '../SkyBoxTypes';
import type { SkyCompositeMode } from '../SkyComposite';
import { toSkyColor } from '../skyColor';
import {
  composeAtmosphere,
  type AtmosphereParts,
  type AtmosphereTerms,
  type AtmosphereUniforms,
} from './atmosphere';

export const CLOUDS_STRUCTURAL_KEYS = ['enabled'] as const;

export const CLOUDS_DEFAULTS = {
  enabled: true,
  coverage: 0.4,
  density: 0.4,
  scale: 0.0002,
  speed: 0.00002,
  elevation: 0.5,
  color: '#ffffff',
  windDirection: [1, 1] as [number, number],
};

export type CloudsUniforms = {
  coverage: THREE.UniformNode<'float', number>;
  density: THREE.UniformNode<'float', number>;
  scale: THREE.UniformNode<'float', number>;
  speed: THREE.UniformNode<'float', number>;
  /** SkyMesh's cloud plane projection, mix(1, 0.1, elevation) (:329). */
  planeScale: THREE.UniformNode<'float', number>;
  /** SkyMesh's horizon fade width, 0.03 + 0.06 · elevation (:347). */
  horizonFadeWidth: THREE.UniformNode<'float', number>;
  color: THREE.UniformNode<'color', THREE.Color>;
  windDirection: THREE.UniformNode<'vec2', THREE.Vector2>;
  /** SkyMesh's day factor, smoothstep(-0.08, 0.3, sun y) (:351). */
  dayFactor: THREE.UniformNode<'float', number>;
  /** The env bake's frozen time (the view uses three's `time`); set before each bake. */
  bakeTime: THREE.UniformNode<'float', number>;
};

export const createCloudsUniforms = (): CloudsUniforms => ({
  coverage: uniform(CLOUDS_DEFAULTS.coverage),
  density: uniform(CLOUDS_DEFAULTS.density),
  scale: uniform(CLOUDS_DEFAULTS.scale),
  speed: uniform(CLOUDS_DEFAULTS.speed),
  planeScale: uniform(1),
  horizonFadeWidth: uniform(0.06),
  color: uniform(new THREE.Color(1, 1, 1)),
  windDirection: uniform(new THREE.Vector2(1, 1)),
  dayFactor: uniform(1),
  bakeTime: uniform(0),
});

export const applyCloudsUniforms = (
  u: CloudsUniforms,
  def: SkyBoxCloudsDef | undefined,
  sunDirection: THREE.Vector3
) => {
  u.coverage.value = def?.coverage ?? CLOUDS_DEFAULTS.coverage;
  u.density.value = def?.density ?? CLOUDS_DEFAULTS.density;
  u.scale.value = def?.scale ?? CLOUDS_DEFAULTS.scale;
  u.speed.value = def?.speed ?? CLOUDS_DEFAULTS.speed;
  const elevation = def?.elevation ?? CLOUDS_DEFAULTS.elevation;
  u.planeScale.value = THREE.MathUtils.lerp(1, 0.1, elevation);
  u.horizonFadeWidth.value = 0.03 + 0.06 * elevation;
  u.color.value.copy(toSkyColor(def?.color ?? CLOUDS_DEFAULTS.color));
  const [windX, windZ] = def?.windDirection ?? CLOUDS_DEFAULTS.windDirection;
  u.windDirection.value.set(windX, windZ);
  applyCloudsSunUniforms(u, sunDirection);
};

/** Writes the sun-dependent day factor (the day-night step, every time the sun moves). */
export const applyCloudsSunUniforms = (u: CloudsUniforms, sunDirection: THREE.Vector3) => {
  u.dayFactor.value = THREE.MathUtils.smoothstep(sunDirection.y, -0.08, 0.3);
};

// SkyMesh's noise (:280-323)

/** Gradient at a lattice corner; a sinless hash, so every GPU makes the same clouds. */
const gradient = Fn(([i]: [THREE.Node<'vec2'>]) => {
  const p = fract(i.xyx.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p.addAssign(dot(p, p.yzx.add(33.33)));
  return fract(p.xx.add(p.yz).mul(p.zy)).mul(2.0).sub(1.0);
});

/** 2D gradient noise: isotropic lobes like Perlin at value-noise cost, ~[-1, 1]. */
const noise = Fn(([p]: [THREE.Node<'vec2'>]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f
    .mul(f)
    .mul(f)
    .mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0)); // quintic fade
  const a = dot(gradient(i), f);
  const b = dot(gradient(i.add(vec2(1.0, 0.0))), f.sub(vec2(1.0, 0.0)));
  const c = dot(gradient(i.add(vec2(0.0, 1.0))), f.sub(vec2(0.0, 1.0)));
  const d = dot(gradient(i.add(vec2(1.0, 1.0))), f.sub(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y).mul(1.6);
});

/** fbm; the per-octave drift makes clouds billow instead of scrolling as a rigid stamp. */
const fbm = Fn(([position, drift]: [THREE.Node<'vec2'>, THREE.Node<'float'>]) => {
  const p = vec2(position).toVar();
  const result = float(0.0).toVar();
  const amplitude = float(1.0).toVar();
  Loop(4, () => {
    result.addAssign(amplitude.mul(noise(p)));
    amplitude.mulAssign(0.5);
    p.mulAssign(2.0);
    p.addAssign(drift);
  });
  return result;
});

/**
 * The atmosphere with clouds: its composed colour, with the clouds over it (SkyMesh.js:325-379).
 * What they cover (the layers behind the atmosphere, eg. the sun disc, and the night floor) is
 * hidden by their opacity; they are seen through the atmosphere's extinction.
 */
export const cloudsNode = (
  dir: THREE.Node<'vec3'>,
  parts: AtmosphereParts,
  terms: AtmosphereTerms,
  atmosphere: AtmosphereUniforms,
  u: CloudsUniforms,
  mode: SkyCompositeMode
): THREE.Node =>
  Fn(() => {
    const color = composeAtmosphere(parts, atmosphere).toVar();
    const fex = terms.fex as THREE.Node<'vec3'>;
    const cosTheta = terms.cosTheta as THREE.Node<'float'>;
    const t = (mode === 'VIEW' ? time : u.bakeTime) as THREE.Node<'float'>;

    If(dir.y.greaterThan(0.0).and(u.coverage.greaterThan(0.0)), () => {
      // Project onto the cloud plane (a higher elevation brings the clouds lower and closer)
      const cloudUV = dir.xz.div(dir.y.mul(u.planeScale)).toVar();
      cloudUV.mulAssign(u.scale);
      cloudUV.addAssign(u.windDirection.mul(t.mul(u.speed)));

      // Density field
      const evolve = t.mul(u.speed).mul(300.0);
      const cloudNoise = fbm(cloudUV.mul(1000.0), evolve).mul(0.7).add(0.5).clamp(0.0, 1.0).toVar();

      // Large-scale coverage variation: clear gaps next to dense banks
      const region = noise(cloudUV.mul(300.0)).mul(0.37).add(0.5);
      const cov = clamp(u.coverage.add(region.sub(0.5).mul(0.6)), 0.0, 1.0);

      // Clouds where the noise rises above the coverage level, faded near the horizon
      const threshold = sub(1.0, cov).toVar();
      const cloudMask = smoothstep(threshold, threshold.add(0.3), cloudNoise).toVar();
      const horizonFade = smoothstep(0.0, u.horizonFadeWidth, dir.y);
      cloudMask.mulAssign(horizonFade);

      // Lit by the sky's own radiance: 0.22 ~ albedo / pi, 0.04 is SkyMesh's output scale
      const sunColor = atmosphere.sunE.mul(fex).mul(0.22).mul(0.04).toVar();
      const skyAmbient = parts.inscatter;

      // Beer-powder self-shadow from the sampled density
      const depth = max(0.0, cloudNoise.sub(threshold)).toVar();
      const beer = exp(depth.mul(-4.0)).toVar();
      const powder = sub(1.0, beer.mul(beer));
      const shade = mix(0.45, 1.0, beer.mul(powder).mul(2.6).clamp(0.0, 1.0));

      // Henyey-Greenstein forward lobe (g = 0.7): a silver lining on rims toward the sun
      const silver = float(0.51)
        .div(pow(sub(1.49, cosTheta.mul(1.4)), 1.5))
        .clamp(0.0, 3.0);
      const edge = cloudMask.mul(sub(1.0, cloudMask)).mul(4.0);

      const cloudColor = skyAmbient.add(sunColor.mul(shade)).toVar();
      cloudColor.addAssign(sunColor.mul(silver).mul(edge).mul(0.6));
      cloudColor.mulAssign(max(u.dayFactor, 0.03));
      cloudColor.mulAssign(u.color.mul(atmosphere.exposure));

      // Opacity via Beer's law: density sets how solid the clouds get
      const alpha = sub(1.0, exp(depth.mul(u.density).mul(-12.0)))
        .mul(horizonFade)
        .toVar();

      // Hide what the clouds cover, then composite them through the atmosphere
      color.subAssign(parts.transmitted.add(parts.floor.mul(atmosphere.exposure)).mul(alpha));
      const cloudAerial = mix(color, cloudColor, fex);
      color.assign(mix(color, cloudAerial, alpha));
    });

    return color;
  })();
