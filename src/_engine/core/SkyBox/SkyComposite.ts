import type * as THREE from 'three/webgpu';
import type { SkyBoxDef } from './SkyBoxTypes';
import {
  applyBaseUniforms,
  baseNode,
  createBaseUniforms,
  ENV_DEFAULTS,
  type BaseUniforms,
} from './layers/base';
import {
  applyAtmosphereUniforms,
  atmosphereNode,
  atmosphereTerms,
  createAtmosphereUniforms,
  type AtmosphereUniforms,
} from './layers/atmosphere';
import {
  applySunUniforms,
  createSunUniforms,
  getSunDirection,
  sunNode,
  type SunUniforms,
} from './layers/sun';

/**
 * The composite path: every layer of a sky box composited into one node, used as the
 * background (VIEW) and as what the env bake renders (ENV_BAKE). A sky box uses it whenever a
 * procedural layer is enabled; a texture-only or colour-only one keeps the direct path
 * (buildBaseLayer), which needs no bake.
 *
 * Layer order, back to front (p110 "Composite order"): base, space layers (p113/p114), discs,
 * atmosphere, clouds, ground. Each layer takes the colour behind it and returns the new colour;
 * an absent or disabled layer is left out of the graph (changing which layers exist is a
 * rebuild, anything else is a uniform write).
 */

/** VIEW: the background the camera sees. ENV_BAKE: what the environment is baked from (a
 * wider, clamped sun disc; later also no disc where a sun light gives the specular, frozen
 * clouds, no stars). */
export type SkyCompositeMode = 'VIEW' | 'ENV_BAKE';

/** Every layer's uniforms, created once per activation (whether the layer is on or not, so
 * turning one on only rebuilds nodes) and shared by both modes' nodes. */
export type SkyUniforms = {
  base: BaseUniforms;
  sun: SunUniforms;
  atmosphere: AtmosphereUniforms;
};

/** What the composite samples that isn't a uniform. */
export type SkyCompositeSources = {
  /** The base texture's PMREM (getPMREMTexture), null for a COLOR base or a failed load. */
  basePMREM: THREE.Texture | null;
};

/** A procedural layer is on when its key is there, unless it says `enabled: false`. */
export const isOn = (layer: { enabled?: boolean } | undefined) =>
  Boolean(layer && layer.enabled !== false);

export const isAtmosphereEnabled = (def: SkyBoxDef) => isOn(def.atmosphere);
/** suns[0]'s disc (its direction drives the atmosphere either way). */
export const isSunEnabled = (def: SkyBoxDef) => isOn(def.suns?.[0]);
/** Whether suns[0] has a light: then the env bake leaves its disc out (the light gives that
 * highlight already). */
export const isSunLightEnabled = (def: SkyBoxDef) => isOn(def.suns?.[0]?.light);

export const createSkyUniforms = (def: SkyBoxDef): SkyUniforms => {
  const u = {
    base: createBaseUniforms(def.base, def.env),
    sun: createSunUniforms(),
    atmosphere: createAtmosphereUniforms(),
  };
  applySkyUniforms(u, def);
  return u;
};

/** Writes every layer's non-structural values to its uniforms. The primary sun's direction
 * comes first: the atmosphere's terms depend on it, and the disc on the atmosphere's. */
export const applySkyUniforms = (u: SkyUniforms, def: SkyBoxDef) => {
  applyBaseUniforms(u.base, def.base, def.env);
  const sun = def.suns?.[0];
  getSunDirection(sun, u.sun.direction.value);
  applyAtmosphereUniforms(u.atmosphere, def.atmosphere, u.sun.direction.value);
  applySunUniforms(
    u.sun,
    sun,
    isAtmosphereEnabled(def)
      ? { sunE: u.atmosphere.sunE.value, extinctionAtSun: u.atmosphere.extinctionAtSun }
      : null,
    def.env?.size ?? ENV_DEFAULTS.size
  );
};

/** Whether a definition has an enabled procedural layer (then it's on the composite path). */
export const hasProceduralLayer = (def: SkyBoxDef) => isAtmosphereEnabled(def) || isSunEnabled(def);

/** Which layers exist: a change to it is a rebuild. */
export const getCompositeSignature = (def: SkyBoxDef) =>
  `${isSunEnabled(def)}|${isSunLightEnabled(def)}|${isAtmosphereEnabled(def)}`;

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
  // Space layers (p113/p114)
  if (isSunEnabled(def)) color = sunNode(dir, color, u.sun, mode, isSunLightEnabled(def));
  if (isAtmosphereEnabled(def)) {
    color = atmosphereNode(
      dir,
      color,
      u.atmosphere,
      atmosphereTerms(dir, u.atmosphere, u.sun.direction)
    );
  }
  // Clouds, ground (p112 Phase 5)
  return color;
};
