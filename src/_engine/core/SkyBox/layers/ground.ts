/**
 * Ground layer: the sky's lower hemisphere as a colour (a physical ground plane is the game's
 * job), blended in over a band below its horizon line. `height` lowers that line (sitting above
 * a sea of clouds), and with `useAtmosphereHorizon` the ground fades toward the sky's own
 * horizon colour near it (aerial perspective). It also gives the ambient light's AUTO ground
 * colour.
 */
import * as THREE from 'three/webgpu';
import { float, mix, smoothstep, uniform } from 'three/tsl';
import type { SkyBoxGroundDef } from '../SkyBoxTypes';
import { toSkyColor } from '../skyColor';

export const GROUND_STRUCTURAL_KEYS = ['enabled'] as const;

export const GROUND_DEFAULTS = {
  enabled: true,
  color: '#3b3a36',
  horizonBlend: 0.05,
  height: 0,
  useAtmosphereHorizon: true,
};

/** How far below the horizon line (in view direction height) the aerial fade reaches. */
const AERIAL_DEPTH = 0.3;
/** Keeps the blend band's smoothstep defined. */
const MIN_BLEND = 1e-4;

export type GroundUniforms = {
  color: THREE.UniformNode<'color', THREE.Color>;
  /** The view direction's height of the ground's horizon line: -sin(height). */
  horizonY: THREE.UniformNode<'float', number>;
  blend: THREE.UniformNode<'float', number>;
  /** 1 with useAtmosphereHorizon (and an atmosphere), else 0. */
  aerial: THREE.UniformNode<'float', number>;
  /** The ground's light: the clouds' day factor (floored) with an atmosphere, else 1. */
  light: THREE.UniformNode<'float', number>;
};

export const createGroundUniforms = (): GroundUniforms => ({
  color: uniform(new THREE.Color()),
  horizonY: uniform(0),
  blend: uniform(GROUND_DEFAULTS.horizonBlend),
  aerial: uniform(1),
  light: uniform(1),
});

export const applyGroundUniforms = (
  u: GroundUniforms,
  def: SkyBoxGroundDef | undefined,
  hasAtmosphere: boolean,
  sunDirection: THREE.Vector3
) => {
  u.color.value.copy(toSkyColor(def?.color ?? GROUND_DEFAULTS.color));
  u.horizonY.value = -Math.sin(THREE.MathUtils.degToRad(def?.height ?? GROUND_DEFAULTS.height));
  u.blend.value = Math.max(MIN_BLEND, def?.horizonBlend ?? GROUND_DEFAULTS.horizonBlend);
  const useHorizon = def?.useAtmosphereHorizon ?? GROUND_DEFAULTS.useAtmosphereHorizon;
  u.aerial.value = useHorizon && hasAtmosphere ? 1 : 0;
  u.light.value = hasAtmosphere
    ? Math.max(THREE.MathUtils.smoothstep(sunDirection.y, -0.08, 0.3), 0.03)
    : 1;
};

/** The ground over `behind` (everything above it, seen below the horizon too). */
export const groundNode = (
  dir: THREE.Node<'vec3'>,
  behind: THREE.Node,
  u: GroundUniforms
): THREE.Node => {
  const back = behind as THREE.Node<'vec3'>;
  const below = u.horizonY.sub(dir.y);
  const mask = smoothstep(0.0, u.blend, below);
  const aerial = float(1.0)
    .sub(smoothstep(0.0, AERIAL_DEPTH, below))
    .mul(u.aerial);
  const ground = mix(u.color.mul(u.light), back, aerial);
  return mix(back, ground, mask);
};
