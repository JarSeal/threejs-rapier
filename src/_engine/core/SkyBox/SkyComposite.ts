import type * as THREE from 'three/webgpu';
import type { SkyBoxDef } from './SkyBoxTypes';
import { applyBaseUniforms, baseNode, createBaseUniforms, type BaseUniforms } from './layers/base';

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

/** VIEW: the background the camera sees. ENV_BAKE: what the environment is baked from (no
 * disc where a sun light already gives the specular, frozen clouds, no stars). */
export type SkyCompositeMode = 'VIEW' | 'ENV_BAKE';

/** Every layer's uniforms, created once per activation and shared by both modes' nodes. */
export type SkyUniforms = {
  base: BaseUniforms;
};

/** What the composite samples that isn't a uniform. */
export type SkyCompositeSources = {
  /** The base texture's PMREM (getPMREMTexture), null for a COLOR base or a failed load. */
  basePMREM: THREE.Texture | null;
};

export const createSkyUniforms = (def: SkyBoxDef): SkyUniforms => ({
  base: createBaseUniforms(def.base, def.env),
});

/** Writes every layer's non-structural values to its uniforms. */
export const applySkyUniforms = (u: SkyUniforms, def: SkyBoxDef) => {
  applyBaseUniforms(u.base, def.base, def.env);
};

/** Whether a definition has an enabled procedural layer (p112 Phase 2 adds the first ones). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const hasProceduralLayer = (_def: SkyBoxDef) => false;

/**
 * The composite colour in direction `dir` (a world direction: normalWorldGeometry of the
 * background sphere, in both modes: the bake scene's background is drawn the same way).
 */
export const buildSkyComposite = (
  def: SkyBoxDef,
  u: SkyUniforms,
  _mode: SkyCompositeMode,
  sources: SkyCompositeSources,
  dir: THREE.Node
): THREE.Node => {
  const color = baseNode(dir, def.base, u.base, sources.basePMREM);
  return color;
};
