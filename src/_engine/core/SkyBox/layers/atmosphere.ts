/**
 * Atmosphere layer: Preetham daylight scattering, ported from three.js r186
 * `examples/jsm/objects/SkyMesh.js` (MIT License, Copyright © 2010-2026 three.js authors), itself
 * based on "A Practical Analytic Model for Daylight" (Preetham et al.).
 *
 * Differences from SkyMesh:
 * - A function of the view direction, so it works as any layer of the background (SkyMesh
 *   needs its own mesh around the camera, SkyMesh.js:239).
 * - SkyMesh's vertex-stage terms (sun direction, sunE, sunfade, betaR, betaM; :160-212) depend
 *   only on its parameters: they are computed here on the CPU (applyAtmosphereUniforms).
 * - It composites over what is behind it (`behind · Fex + inscatter`) instead of drawing an
 *   opaque colour; at night Fex is ~1 and the inscatter ~0, so the layers behind show through.
 * - The sun disc is the sun layer's (SkyMesh.js:275-276), and the clouds are their own layer.
 * - Extra params: exposure (sky only), sunIntensity (on EE), nightSkyColor (replaces the fixed
 *   floor, :272, :278), twilightLength (on the earth-shadow cutoff and steepness, :177-178),
 *   and horizon/zenith tints.
 * With exposure 1 and the extras at their defaults it computes exactly what SkyMesh does.
 */
import * as THREE from 'three/webgpu';
import { acos, cos, dot, exp, float, max, mix, pow, uniform, vec3 } from 'three/tsl';
import type { SkyBoxAtmosphereDef } from '../SkyBoxTypes';
import { toSkyColor } from '../skyColor';

export const ATMOSPHERE_STRUCTURAL_KEYS = ['enabled'] as const;

export const ATMOSPHERE_DEFAULTS = {
  enabled: true,
  turbidity: 2,
  rayleigh: 1,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  exposure: 0.714,
  sunIntensity: 1,
  nightSkyColor: 'AUTO',
  twilightLength: 1,
  horizonTint: '#ffffff',
  zenithTint: '#ffffff',
};

// SkyMesh's constants

/** Total Rayleigh scattering of the primaries (SkyMesh.js:166). */
const TOTAL_RAYLEIGH = new THREE.Vector3(
  5.804542996261093e-6,
  1.3562911419845635e-5,
  3.0265902468824876e-5
);
/** Mie constant of the primaries (:173). */
const MIE_CONST = new THREE.Vector3(
  1.8399918514433978e14,
  2.7798023919660528e14,
  4.0790479543861094e14
);
/** Earth shadow: pi / 1.95 and its steepness (:177-178); twilightLength scales both. */
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
/** Optical length at the zenith (:227-228). */
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;
/** SkyMesh's output scale (:278). */
const SKY_SCALE = 0.04;
/** SkyMesh's floor: `L0 = 0.1 · Fex` and a faint blue (:272, :278). */
const NIGHT_L0 = 0.1;
const NIGHT_OFFSET = new THREE.Vector3(0, 0.0003, 0.00075);

export type AtmosphereUniforms = {
  sunE: THREE.UniformNode<'float', number>;
  betaR: THREE.UniformNode<'vec3', THREE.Vector3>;
  betaM: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** The Mie phase's (1 - g², 1 + g², 2g). */
  miePhase: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** SkyMesh's low-sun blend of the inscatter (:268). */
  linMix: THREE.UniformNode<'float', number>;
  exposure: THREE.UniformNode<'float', number>;
  nightColor: THREE.UniformNode<'color', THREE.Color>;
  /** 1: nightColor is the floor. 0: SkyMesh's own. */
  isNightCustom: THREE.UniformNode<'float', number>;
  horizonTint: THREE.UniformNode<'color', THREE.Color>;
  zenithTint: THREE.UniformNode<'color', THREE.Color>;
  /** CPU only: the extinction along the sun direction (the sun disc's and light's colour). */
  extinctionAtSun: THREE.Vector3;
};

export const createAtmosphereUniforms = (): AtmosphereUniforms => ({
  sunE: uniform(0),
  betaR: uniform(new THREE.Vector3()),
  betaM: uniform(new THREE.Vector3()),
  miePhase: uniform(new THREE.Vector3()),
  linMix: uniform(0),
  exposure: uniform(ATMOSPHERE_DEFAULTS.exposure),
  nightColor: uniform(new THREE.Color()),
  isNightCustom: uniform(0),
  horizonTint: uniform(new THREE.Color(1, 1, 1)),
  zenithTint: uniform(new THREE.Color(1, 1, 1)),
  extinctionAtSun: new THREE.Vector3(1, 1, 1),
});

/** SkyMesh's optical length factor for a direction's height (:243-244). */
const opticalLengthFactor = (dirY: number) => {
  const zenithAngle = Math.acos(Math.max(0, dirY));
  return 1 / (Math.cos(zenithAngle) + 0.15 * (93.885 - (zenithAngle * 180) / Math.PI) ** -1.253);
};

/** The extinction (Fex) along a direction of height `dirY`, into `out` (:249). */
export const computeExtinction = (
  dirY: number,
  betaR: THREE.Vector3,
  betaM: THREE.Vector3,
  out: THREE.Vector3
) => {
  const inverse = opticalLengthFactor(dirY);
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  return out.set(
    Math.exp(-(betaR.x * sR + betaM.x * sM)),
    Math.exp(-(betaR.y * sR + betaM.y * sM)),
    Math.exp(-(betaR.z * sR + betaM.z * sM))
  );
};

/**
 * Writes the atmosphere's uniforms, including SkyMesh's vertex-stage terms, for the primary
 * sun's (unit) direction.
 */
export const applyAtmosphereUniforms = (
  u: AtmosphereUniforms,
  def: SkyBoxAtmosphereDef | undefined,
  sunDirection: THREE.Vector3
) => {
  const turbidity = def?.turbidity ?? ATMOSPHERE_DEFAULTS.turbidity;
  const rayleigh = def?.rayleigh ?? ATMOSPHERE_DEFAULTS.rayleigh;
  const mieCoefficient = def?.mieCoefficient ?? ATMOSPHERE_DEFAULTS.mieCoefficient;
  const g = def?.mieDirectionalG ?? ATMOSPHERE_DEFAULTS.mieDirectionalG;
  const sunIntensity = def?.sunIntensity ?? ATMOSPHERE_DEFAULTS.sunIntensity;
  const twilight = Math.max(0.05, def?.twilightLength ?? ATMOSPHERE_DEFAULTS.twilightLength);
  const y = sunDirection.y;

  // sunE (:188-190): twilightLength moves the cutoff below the horizon, and softens the fade
  const cutoffAngle = Math.PI / 2 + (CUTOFF_ANGLE - Math.PI / 2) * twilight;
  const steepness = STEEPNESS * twilight;
  const zenithAngle = Math.acos(THREE.MathUtils.clamp(y, -1, 1));
  u.sunE.value =
    EE * sunIntensity * Math.max(0, 1 - Math.exp(-(cutoffAngle - zenithAngle) / steepness));

  // sunfade and betaR (:195-203). SkyMesh's 450000 is from the older Sky's sun distance: with
  // a unit direction, sunfade stays ~1 (kept as is, for parity)
  const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(y / 450000), 0, 1);
  u.betaR.value.copy(TOTAL_RAYLEIGH).multiplyScalar(rayleigh - (1 - sunfade));

  // betaM (:207-210)
  const c = 0.2 * turbidity * 10e-18;
  u.betaM.value.copy(MIE_CONST).multiplyScalar(0.434 * c * mieCoefficient);

  u.miePhase.value.set(1 - g * g, 1 + g * g, 2 * g);
  u.linMix.value = THREE.MathUtils.clamp((1 - y) ** 5, 0, 1);
  u.exposure.value = def?.exposure ?? ATMOSPHERE_DEFAULTS.exposure;

  const night = def?.nightSkyColor ?? ATMOSPHERE_DEFAULTS.nightSkyColor;
  u.isNightCustom.value = night === 'AUTO' ? 0 : 1;
  if (night !== 'AUTO') u.nightColor.value.copy(toSkyColor(night));
  u.horizonTint.value.copy(toSkyColor(def?.horizonTint ?? ATMOSPHERE_DEFAULTS.horizonTint));
  u.zenithTint.value.copy(toSkyColor(def?.zenithTint ?? ATMOSPHERE_DEFAULTS.zenithTint));

  computeExtinction(y, u.betaR.value, u.betaM.value, u.extinctionAtSun);
};

/** The atmosphere's per-direction terms (the clouds reuse them, p112 Phase 5). */
export type AtmosphereTerms = {
  /** Extinction: what reaches the eye of the light behind. */
  fex: THREE.Node;
  /** SkyMesh's in-scattered light (before its output scale). */
  lin: THREE.Node;
  /** Cosine of the angle to the sun. */
  cosTheta: THREE.Node;
};

/** SkyMesh's fragment stage (:239-268) for direction `dir`. */
export const atmosphereTerms = (
  dir: THREE.Node<'vec3'>,
  u: AtmosphereUniforms,
  sunDirection: THREE.Node<'vec3'>
): AtmosphereTerms => {
  // Optical length; the zenith angle is capped at 90° to avoid the singularity
  const zenithAngle = acos(max(0.0, dir.y));
  const inverse = float(1.0).div(
    cos(zenithAngle).add(
      float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0 / Math.PI)), -1.253))
    )
  );
  const sR = inverse.mul(RAYLEIGH_ZENITH_LENGTH);
  const sM = inverse.mul(MIE_ZENITH_LENGTH);
  const fex = exp(u.betaR.mul(sR).add(u.betaM.mul(sM)).negate());

  // In scattering
  const cosTheta = dot(dir, sunDirection);
  const c = cosTheta.mul(0.5).add(0.5);
  const rPhase = float(THREE_OVER_SIXTEENPI).mul(float(1.0).add(pow(c, 2.0)));
  const betaRTheta = u.betaR.mul(rPhase);
  const inv = float(1.0).div(pow(u.miePhase.y.sub(u.miePhase.z.mul(cosTheta)), 1.5));
  const mPhase = float(ONE_OVER_FOURPI).mul(u.miePhase.x).mul(inv);
  const betaMTheta = u.betaM.mul(mPhase);

  const scatter = u.sunE.mul(betaRTheta.add(betaMTheta).div(u.betaR.add(u.betaM)));
  const lin = pow(scatter.mul(vec3(1.0).sub(fex)), vec3(1.5)).mul(
    mix(vec3(1.0), pow(scatter.mul(fex), vec3(0.5)), u.linMix)
  );
  return { fex, lin, cosTheta };
};

/** The atmosphere over what's behind it, in pieces (the clouds hide some of them). */
export type AtmosphereParts = {
  /** What's behind, seen through the atmosphere: `behind · Fex`. */
  transmitted: THREE.Node<'vec3'>;
  /** The scattered light (SkyMesh's `Lin · 0.04`, tinted), plus SkyMesh's faint blue when the
   * night floor is 'AUTO'. */
  inscatter: THREE.Node<'vec3'>;
  /** The night floor: SkyMesh's `L0 · 0.04`, or the custom colour through Fex. */
  floor: THREE.Node<'vec3'>;
};

export const atmosphereParts = (
  dir: THREE.Node<'vec3'>,
  behind: THREE.Node,
  u: AtmosphereUniforms,
  terms: AtmosphereTerms
): AtmosphereParts => {
  const fex = terms.fex as THREE.Node<'vec3'>;
  const tint = mix(u.horizonTint, u.zenithTint, dir.y.clamp(0.0, 1.0));
  const offset = vec3(NIGHT_OFFSET.x, NIGHT_OFFSET.y, NIGHT_OFFSET.z).mul(
    float(1.0).sub(u.isNightCustom)
  );
  return {
    transmitted: (behind as THREE.Node<'vec3'>).mul(fex),
    inscatter: (terms.lin as THREE.Node<'vec3'>).mul(SKY_SCALE).mul(tint).add(offset),
    floor: mix(fex.mul(NIGHT_L0 * SKY_SCALE), fex.mul(u.nightColor), u.isNightCustom),
  };
};

/** The atmosphere's colour from its parts: `transmitted + (inscatter + floor) · exposure`. */
export const composeAtmosphere = (parts: AtmosphereParts, u: AtmosphereUniforms) =>
  parts.transmitted.add(parts.inscatter.add(parts.floor).mul(u.exposure));

const _fex = new THREE.Vector3();

/**
 * The atmosphere's scattered light seen in direction `dir` (unit), on the CPU: the same maths
 * as atmosphereTerms' `lin`, with SkyMesh's output scale, into `out` (linear RGB). Used for the
 * ambient light's AUTO sky colour. Uses the uniforms' current values.
 */
export const computeInscatter = (
  dir: THREE.Vector3,
  u: AtmosphereUniforms,
  sunDirection: THREE.Vector3,
  out: THREE.Vector3
) => {
  const betaR = u.betaR.value;
  const betaM = u.betaM.value;
  const miePhase = u.miePhase.value;
  computeExtinction(dir.y, betaR, betaM, _fex);
  const cosTheta = dir.dot(sunDirection);
  const c = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + c ** 2);
  const mPhase = (ONE_OVER_FOURPI * miePhase.x) / (miePhase.y - miePhase.z * cosTheta) ** 1.5;
  const channel = (r: number, m: number, fex: number) => {
    const scatter = (u.sunE.value * (r * rPhase + m * mPhase)) / (r + m);
    const lin =
      (scatter * (1 - fex)) ** 1.5 *
      THREE.MathUtils.lerp(1, (scatter * fex) ** 0.5, u.linMix.value);
    return lin * SKY_SCALE;
  };
  return out.set(
    channel(betaR.x, betaM.x, _fex.x),
    channel(betaR.y, betaM.y, _fex.y),
    channel(betaR.z, betaM.z, _fex.z)
  );
};
