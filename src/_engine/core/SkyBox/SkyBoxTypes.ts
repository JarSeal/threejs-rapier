// Import only types here (`import type ...`), like AppECSRegistry.ts: the schema is the source of
// truth for the definition's shape.
import type * as THREE from 'three/webgpu';
import type { z } from 'zod';
import type {
  SkyBoxAmbientLightSchema,
  SkyBoxAtmosphereSchema,
  SkyBoxBaseSchema,
  SkyBoxCloudsSchema,
  SkyBoxDayNightSchema,
  SkyBoxGroundSchema,
  SkyBoxMoonLightSchema,
  SkyBoxMoonSchema,
  SkyBoxDefSchema,
  SkyBoxEnvSchema,
  SkyBoxEnvSizeSchema,
  SkyBoxOverridesSchema,
  SkyBoxStarsSchema,
  SkyBoxSunLightSchema,
  SkyBoxSunSchema,
} from '../../schemas/skyBoxSchema';

type SkyBoxBaseInput = z.input<typeof SkyBoxBaseSchema>;

/** A sky box's base layer. A texture base can be given an already-loaded texture in code. */
export type SkyBoxBaseDef =
  | Extract<SkyBoxBaseInput, { type: 'COLOR' }>
  | (Exclude<SkyBoxBaseInput, { type: 'COLOR' }> & { texture?: THREE.Texture });

export type SkyBoxBaseType = SkyBoxBaseDef['type'];

/** A sky box's env layer (background blur and intensities, and the env bake settings). */
export type SkyBoxEnvDef = z.input<typeof SkyBoxEnvSchema>;

/** The env bake's cube face size. */
export type SkyBoxEnvSize = z.infer<typeof SkyBoxEnvSizeSchema>;

/** The atmosphere layer (Preetham scattering, driven by suns[0]). */
export type SkyBoxAtmosphereDef = z.input<typeof SkyBoxAtmosphereSchema>;

/** A sun layer: its disc and halo, and (suns[0]) the atmosphere's sun direction. */
export type SkyBoxSunDef = z.input<typeof SkyBoxSunSchema>;

/** A sun's managed directional light. */
export type SkyBoxSunLightDef = z.input<typeof SkyBoxSunLightSchema>;

/** A moon layer: its disc, lit into its phase. */
export type SkyBoxMoonDef = z.input<typeof SkyBoxMoonSchema>;

/** A moon's managed directional light. */
export type SkyBoxMoonLightDef = z.input<typeof SkyBoxMoonLightSchema>;

/** The moon's texture. */
export type SkyBoxMoonTextureDef = NonNullable<SkyBoxMoonDef['texture']>;

/** The stars layer (and its optional Milky Way). */
export type SkyBoxStarsDef = z.input<typeof SkyBoxStarsSchema>;

/** The clouds layer (needs the atmosphere). */
export type SkyBoxCloudsDef = z.input<typeof SkyBoxCloudsSchema>;

/** The ground layer. */
export type SkyBoxGroundDef = z.input<typeof SkyBoxGroundSchema>;

/** The managed ambient (or hemisphere) light. */
export type SkyBoxAmbientLightDef = z.input<typeof SkyBoxAmbientLightSchema>;

/** The day-night cycle's values on activation (the runtime time is SkyTimeState). */
export type SkyBoxDayNightDef = z.input<typeof SkyBoxDayNightSchema>;

/** What advances the day-night time. */
export type SkyTimeSource = NonNullable<SkyBoxDayNightDef['timeSource']>;

/**
 * A sky box definition: the JSON shape (`SkyBoxDefSchema`), plus what only code can give, a
 * loaded texture and the scene to register in.
 */
export type SkyBoxDef = Omit<z.input<typeof SkyBoxDefSchema>, 'base'> & {
  base: SkyBoxBaseDef;
  /** Code only: the scene the sky box belongs to. Default: the loading scene, or else the current one. In JSON, the scene that lists the sky box owns it. */
  sceneId?: string;
};

/** The values changed from a definition (deep partial of its layers), eg. a scene's save data. */
export type SkyBoxOverrides = z.infer<typeof SkyBoxOverridesSchema>;
