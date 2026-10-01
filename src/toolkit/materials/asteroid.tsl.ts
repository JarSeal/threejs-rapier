import {
  cross,
  dFdx,
  dFdy,
  dot,
  faceDirection,
  float,
  fract,
  max,
  mix,
  mx_fractal_noise_float as fractalNoise,
  mx_noise_float as perlinNoise,
  mx_worley_noise_float as worleyNoise,
  oneMinus,
  positionLocal,
  positionView,
  normalView,
  sin,
  smoothstep,
  vec3,
} from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import { type Node, type NodeMaterial } from 'three/webgpu';

// ─── Static defines ───
// Set them in the material JSON `staticDefines`, or per mesh with `matOverrides.staticDefines`.
const DEFAULT_OCTAVES = 4;

// Fixed offsets between the noise channels, so the pits and speckles don't line up with the mottling
const PIT_OFFSET = vec3(17.3, -5.9, 9.1);
const SPECKLE_OFFSET = vec3(-11.7, 3.3, 27.9);

// Seed → noise-domain offset in [0, 100)^3: a sine hash, so any seed (and nearby seeds) lands on
// an unrelated part of the noise, without the float precision loss of a large raw offset
const seedOffset = (seed: Node<'float'>) =>
  fract(sin(seed.mul(vec3(12.9898, 78.233, 37.719))).mul(43758.5453)).mul(100);

// Bump mapping from a procedural height (Mikkelsen, "Bump Mapping Unparametrized Surfaces on the
// GPU", listing 2 with forward differences). three's bumpMap() can't be used: it offsets a texture
// node's UVs to get the height differences, which does nothing to a node without UVs. The surface
// derivatives are left unnormalized, so `height` is in object units and the bump looks the same at
// any distance (the normalized variant weakens as the camera gets closer).
const bumpNormal = (height: Node<'float'>) => {
  const sigmaX = dFdx(positionView);
  const sigmaY = dFdy(positionView);
  const n = normalView;
  const r1 = cross(sigmaY, n);
  const r2 = cross(n, sigmaX);
  const det = dot(sigmaX, r1).mul(faceDirection);
  const grad = det.sign().mul(r1.mul(dFdx(height)).add(r2.mul(dFdy(height))));
  return det.abs().mul(n).sub(grad).normalize();
};

/**
 * Procedural rock surface in object space (`positionLocal`), so it needs no UVs, has no seams and
 * turns with the rock: two rock colours mottled by fbm, darker Worley pits and light mineral
 * speckles. Roughness and a bump normal come from the same field, so this one socket also sets
 * the material's `roughnessNode` and `normalNode`: every input lives here, and one `seed` (eg. in
 * `matOverrides.nodes.colorNode`) gives a different-looking rock for all three.
 *
 * Inputs arrive pre-wrapped by createMaterial (numbers as float uniforms, hex strings as colour
 * uniforms):
 * - `seed`: noise-domain offset, any number;
 * - `noiseScale`: mottling features per object unit;
 * - `colorA`, `colorB`: the two rock colours;
 * - `pitColor`, `pitScale` (pit cells per mottling feature), `pitSize` (0-1 of a cell),
 *   `pitStrength` (0-1, colour and depth);
 * - `speckleColor`, `speckleScale` (per mottling feature), `speckleAmount` (0-1 coverage);
 * - `roughnessMin`, `roughnessMax`: the range the mottling maps to (speckles go below it, pits to max);
 * - `bumpStrength`: bump height in object units.
 */
export const colorNode = (
  inputs: {
    seed: Node<'float'>;
    noiseScale: Node<'float'>;
    colorA: Node<'color'>;
    colorB: Node<'color'>;
    pitColor: Node<'color'>;
    pitScale: Node<'float'>;
    pitSize: Node<'float'>;
    pitStrength: Node<'float'>;
    speckleColor: Node<'color'>;
    speckleScale: Node<'float'>;
    speckleAmount: Node<'float'>;
    roughnessMin: Node<'float'>;
    roughnessMax: Node<'float'>;
    bumpStrength: Node<'float'>;
  },
  material: NodeMaterial,
  staticDefines?: Record<string, unknown>
) => {
  const missing = (
    [
      'seed',
      'noiseScale',
      'colorA',
      'colorB',
      'pitColor',
      'pitScale',
      'pitSize',
      'pitStrength',
      'speckleColor',
      'speckleScale',
      'speckleAmount',
      'roughnessMin',
      'roughnessMax',
      'bumpStrength',
    ] as const
  ).filter((key) => !inputs[key]);
  if (missing.length) {
    throw new Error(
      `[asteroid] Missing colorNode input(s) ${missing.map((key) => `"${key}"`).join(', ')}.`
    );
  }
  const octaves =
    typeof staticDefines?.octaves === 'number'
      ? Math.round(staticDefines.octaves)
      : DEFAULT_OCTAVES;

  const p = positionLocal.mul(inputs.noiseScale).add(seedOffset(inputs.seed));

  // Mottling: fbm around 0, mapped to 0-1 between the two rock colours
  const body = fractalNoise(p, octaves);
  const mottling = smoothstep(-0.35, 0.35, body);

  // Pits: 1 at a Worley cell's feature point, 0 beyond pitSize of it
  const cellDistance = worleyNoise(p.mul(inputs.pitScale).add(PIT_OFFSET));
  const pit = oneMinus(smoothstep(float(0), inputs.pitSize, cellDistance)).mul(inputs.pitStrength);

  // Speckles: the peaks of a finer Perlin noise above a coverage threshold
  const speckleNoise = perlinNoise(p.mul(inputs.speckleScale).add(SPECKLE_OFFSET));
  const threshold = float(0.7).sub(inputs.speckleAmount.mul(0.5));
  const speckle = smoothstep(threshold, threshold.add(0.08), speckleNoise);

  const rock = mix(inputs.colorA, inputs.colorB, mottling);
  const pitted = mix(rock, inputs.pitColor, pit);
  const color = mix(pitted, inputs.speckleColor, speckle);

  const roughness = max(
    mix(inputs.roughnessMin, inputs.roughnessMax, mottling).sub(speckle.mul(0.35)),
    mix(float(0), inputs.roughnessMax, pit)
  ).clamp(0.02, 1);
  material.roughnessNode = roughness;

  // Height: the mottling's lumps, pressed in by the pits (the speckles are flat inclusions)
  const height = body.mul(0.5).sub(pit).mul(inputs.bumpStrength);
  material.normalNode = bumpNormal(height);

  return color;
};
