import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import {
  ColorJSONSchema,
  ColorSpaceSchema,
  DebugDataSchema,
  ShadowQualitySchema,
} from './_helperSchemas';
import {
  fromLegacySkyBoxOverrides,
  fromLegacySkyBoxProps,
  isLegacySkyBoxProps,
} from '../core/SkyBox/legacySkyBox';

// A sky box definition is a set of layers. p111 has the base and env layers, p112 the atmosphere
// and suns; later plans add their own layers (clouds, moons, stars, ...) as optional keys. A
// procedural layer is on when its key is there, unless it says `enabled: false`.

// Base layer

const SkyBoxColorBaseSchema = z.object({
  type: z.literal('COLOR'),
  color: ColorJSONSchema,
});

const SkyBoxEquirectBaseSchema = z
  .object({
    type: z.literal('EQUIRECTANGULAR'),
    file: z.string().optional(),
    path: z.string().optional(),
    textureId: z.string().optional(),
    /** Default: 'srgb', or 'srgb-linear' for .hdr files. An empty string is unset. */
    colorSpace: ColorSpaceSchema.optional(),
    /** Rotation around the Y axis, in radians. */
    rotate: z.number().optional(),
    intensity: z.number().min(0).optional(),
  })
  .refine((base) => Boolean(base.file || base.textureId), {
    error: 'An EQUIRECTANGULAR base needs a file or a textureId.',
    path: ['file'],
  });

const SkyBoxCubeBaseSchema = z.object({
  type: z.literal('CUBE_TEXTURE'),
  /** In the order +x, -x, +y, -y, +z, -z. */
  fileNames: z.array(z.string()).length(6),
  path: z.string().optional(),
  textureId: z.string().optional(),
  /** Default: 'srgb', or 'srgb-linear' for .hdr files. An empty string is unset. */
  colorSpace: ColorSpaceSchema.optional(),
  /** Rotation around the Y axis, in radians. */
  rotate: z.number().optional(),
  /** Turns the cube upside down (a half turn about the X axis). */
  flipY: z.boolean().optional(),
  intensity: z.number().min(0).optional(),
});

export const SkyBoxBaseSchema = z.discriminatedUnion('type', [
  SkyBoxColorBaseSchema,
  SkyBoxEquirectBaseSchema,
  SkyBoxCubeBaseSchema,
]);

// Env layer

export const SkyBoxEnvSizeSchema = z.union([
  z.literal(64),
  z.literal(128),
  z.literal(256),
  z.literal(512),
]);

export const SkyBoxEnvSchema = z.object({
  /** Blur of the background (PMREM roughness, 0-1). Materials' own roughness drives the environment. */
  backgroundRoughness: z.number().min(0).max(1).optional(),
  backgroundIntensity: z.number().min(0).optional(),
  environmentIntensity: z.number().min(0).optional(),

  // Environment bake settings: used by sky boxes on the composite path (procedural layers),
  // which bake their environment. A texture-only or colour-only sky box has no bake.
  /** The bake's cube face size, fixed per activation. Default 256. 512 gives sharper mirror
   * reflections for 4× the memory (a 1536×2048 half-float target); the bake's GPU cost is per
   * pass, so it barely changes with size (p110 spike). */
  size: SkyBoxEnvSizeSchema.optional(),
  /** Whether value changes re-bake the environment. False: only activation, a rebuild and
   * `bakeEnvironment()` do. Default true. */
  dynamic: z.boolean().optional(),
  /** Day-night re-bake rules (p113). Accepted, but not used yet. */
  updateAngleDeg: z.number().min(0).optional(),
  maxUpdatesPerSec: z.number().min(0).optional(),
});

// Atmosphere layer (Preetham scattering, a port of three's SkyMesh; driven by suns[0])

/** 'AUTO', or a colour. */
const AutoOrColorSchema = z.union([z.literal('AUTO'), ColorJSONSchema]);

export const SkyBoxAtmosphereSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Haze (Mie scattering amount). Default 2. */
  turbidity: z.number().min(0).optional(),
  /** Rayleigh scattering amount (the blue). Default 1. */
  rayleigh: z.number().min(0).optional(),
  /** Default 0.005. */
  mieCoefficient: z.number().min(0).optional(),
  /** Forward scattering of the sun's halo, 0-1. Default 0.8. */
  mieDirectionalG: z.number().min(0).max(0.999).optional(),
  /** Sky-only radiance multiplier (the renderer's tone mapping exposure stays global). Default
   * 0.714: at the renderer's 0.7 with ACES, the look of three's sky example at its 0.5. */
  exposure: z.number().min(0).optional(),
  /** Scales the sun's energy (SkyMesh's EE) without changing the turbidity. Default 1. */
  sunIntensity: z.number().min(0).optional(),
  /** The sky's floor, what's left with the sun down: 'AUTO' (SkyMesh's own faint floor), or
   * a colour (seen through the extinction). Default 'AUTO'. */
  nightSkyColor: AutoOrColorSchema.optional(),
  /** Stretches (> 1) or shortens (< 1) dusk: how far below the horizon the sun still lights
   * the sky, and how softly it fades. Default 1. */
  twilightLength: z.number().min(0.05).optional(),
  /** Colour grading of the scattered light at the horizon and the zenith (multiplied, blended by
   * height). Default white. */
  horizonTint: ColorJSONSchema.optional(),
  zenithTint: ColorJSONSchema.optional(),
});

// Sun light: a managed directional light (MANAGED_BY) aimed like the sun

export const SkyBoxSunLightSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Default 3. */
  intensity: z.number().min(0).optional(),
  /** 'AUTO': the atmosphere's extinction along the sun (warms toward the horizon; white without
   * an atmosphere). Default 'AUTO'. */
  color: AutoOrColorSchema.optional(),
  /** Changing it re-creates the light (one rebuild of every lit material); the sky never
   * toggles it to fade. Default true. */
  castShadow: z.boolean().optional(),
  /** Default 'MEDIUM'. The bias, normal bias and map size below override it. */
  shadowPreset: ShadowQualitySchema.optional(),
  shadowBias: z.number().optional(),
  shadowNormalBias: z.number().optional(),
  /** The (square) shadow map's size in texels. */
  shadowMapSize: z.number().int().positive().optional(),
  /** Half the shadow camera's width and height, in world units. Default 30. */
  shadowFrustumSize: z.number().positive().optional(),
  /** The light's distance from the point it follows. Default 100. */
  distance: z.number().positive().optional(),
  /** What the shadow frustum centres on (snapped to shadow texels). Default 'ACTIVE_CAMERA'. */
  shadowFollow: z.enum(['ACTIVE_CAMERA', 'ORIGIN']).optional(),
  /** Sun elevations (degrees) where the light starts fading out and where it is out.
   * Default [6, -3]. */
  horizonFade: z.tuple([z.number(), z.number()]).optional(),
});

// Sun layer (the disc and its halo; suns[0] also drives the atmosphere)

export const SkyBoxSunSchema = z.object({
  /** Whether the disc is drawn. The atmosphere follows the sun either way. Default true. */
  enabled: z.boolean().optional(),
  /** Degrees above the horizon. Default 30. */
  elevation: z.number().min(-90).max(90).optional(),
  /** Degrees clockwise seen from above: 0 = +z, 90 = +x, 180 = -z. Default 180. */
  azimuth: z.number().optional(),
  /** Multiplier on the disc's angular radius (0.533°, SkyMesh's). Default 1. */
  discSize: z.number().min(0).optional(),
  /** The disc's peak radiance (SkyMesh's is ~60,800, which blows out bloom). Default 40. */
  discIntensity: z.number().min(0).optional(),
  /** A halo around the disc. Default 0 (none). */
  glowIntensity: z.number().min(0).optional(),
  /** The halo's half-brightness radius in degrees. Default 10. */
  glowSize: z.number().min(0.1).max(90).optional(),
  /** 'AUTO': white, coloured by the atmosphere's extinction (reddens at the horizon). A
   * colour: the disc's colour as seen. Default 'AUTO'. */
  color: AutoOrColorSchema.optional(),
  /** A directional light that follows the sun. Default: none. */
  light: SkyBoxSunLightSchema.optional(),
});

// Ambient light: a managed hemisphere or ambient light that follows the sun. Off by default:
// the environment bake already lights PBR materials (a hemisphere light adds to it); it's for
// non-PBR materials (Lambert/Phong don't sample the environment) and stylized looks.

export const SkyBoxAmbientLightSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Default 'HEMISPHERE'. */
  type: z.enum(['HEMISPHERE', 'AMBIENT']).optional(),
  /** Default 0.5. */
  intensity: z.number().min(0).optional(),
  /** 'AUTO': the sky's colour at the zenith, faded with the sun. Default 'AUTO'. */
  skyColor: AutoOrColorSchema.optional(),
  /** HEMISPHERE only. 'AUTO': a ground colour, faded with the sun. Default 'AUTO'. */
  groundColor: AutoOrColorSchema.optional(),
});

// Clouds layer (a port of SkyMesh's; needs the atmosphere)

export const SkyBoxCloudsSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** How much of the sky they cover, 0-1. Default 0.4. */
  coverage: z.number().min(0).max(1).optional(),
  /** How opaque they get. Default 0.4. */
  density: z.number().min(0).optional(),
  /** Noise scale (smaller: bigger clouds). Default 0.0002. */
  scale: z.number().min(0).optional(),
  /** Drift speed. Default 0.00002. */
  speed: z.number().min(0).optional(),
  /** Cloud layer height, 0-1 (higher: lower and closer). Default 0.5. */
  elevation: z.number().min(0).max(1).optional(),
  /** Multiplies their colour. Default white. */
  color: ColorJSONSchema.optional(),
  /** Drift direction on the xz plane (its length scales the speed). Default [1, 1] (SkyMesh's). */
  windDirection: z.tuple([z.number(), z.number()]).optional(),
});

// Ground layer (the sky's lower hemisphere colour; a physical ground is the game's job)

export const SkyBoxGroundSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Default '#3b3a36'. It's also the ambient light's AUTO ground colour. */
  color: ColorJSONSchema.optional(),
  /** Width of the blend band below the horizon line (in view direction height). Default 0.05. */
  horizonBlend: z.number().min(0).optional(),
  /** Degrees the ground's horizon line sits below the horizon (eg. above a sea of clouds).
   * Default 0. */
  height: z.number().min(-90).max(90).optional(),
  /** Fade toward the sky's horizon colour near the horizon (aerial perspective), with an
   * atmosphere. Default true. */
  useAtmosphereHorizon: z.boolean().optional(),
});

// Overrides (scene save data, and the debugger's changed values): a deep partial of the layers.
// Zod 4 has no .deepPartial(), so each layer is spelled out. The base override is flat across
// the base types, and can't change `type`: a type change is a different definition.

const SkyBoxBaseOverridesSchema = z.object({
  color: ColorJSONSchema.optional(),
  file: z.string().optional(),
  fileNames: z.array(z.string()).length(6).optional(),
  path: z.string().optional(),
  textureId: z.string().optional(),
  colorSpace: ColorSpaceSchema.optional(),
  rotate: z.number().optional(),
  flipY: z.boolean().optional(),
  intensity: z.number().min(0).optional(),
});

const SkyBoxSunOverridesSchema = SkyBoxSunSchema.extend({
  light: SkyBoxSunLightSchema.partial().optional(),
}).partial();

export const SkyBoxOverridesSchema = z.object({
  base: SkyBoxBaseOverridesSchema.optional(),
  env: SkyBoxEnvSchema.partial().optional(),
  atmosphere: SkyBoxAtmosphereSchema.partial().optional(),
  /** An array replaces the definition's suns; an index object (`{ "0": { ... } }`) changes
   * those entries only. */
  suns: z
    .union([
      z.array(SkyBoxSunOverridesSchema),
      z.record(z.string().regex(/^(0|[1-9]\d*)$/), SkyBoxSunOverridesSchema),
    ])
    .optional(),
  ambientLight: SkyBoxAmbientLightSchema.partial().optional(),
  clouds: SkyBoxCloudsSchema.partial().optional(),
  ground: SkyBoxGroundSchema.partial().optional(),
  __meta: MetaSchema.optional(),
});

export type SkyBoxOverrides = z.infer<typeof SkyBoxOverridesSchema>;

// Definition

const isLayerOn = (layer: { enabled?: boolean } | undefined) =>
  Boolean(layer && layer.enabled !== false);

/** A sky box definition as authored (JSON or code). `SkyBoxDef` (SkyBox/SkyBoxTypes.ts) is its runtime type. */
export const SkyBoxDefSchema = z
  .object({
    id: z.string(),
    /** Whether this is the sky box its scene starts with. Without one, the first registered is. */
    isDefault: z.boolean().optional(),
    /** A preset to start from (p114). Accepted, but not used yet. */
    preset: z.string().optional(),
    base: SkyBoxBaseSchema,
    env: SkyBoxEnvSchema.optional(),
    atmosphere: SkyBoxAtmosphereSchema.optional(),
    /** Only suns[0] is drawn until p114 (multiple suns); it also drives the atmosphere. */
    suns: z.array(SkyBoxSunSchema).optional(),
    ambientLight: SkyBoxAmbientLightSchema.optional(),
    /** Needs an enabled atmosphere. */
    clouds: SkyBoxCloudsSchema.optional(),
    ground: SkyBoxGroundSchema.optional(),
    debugData: DebugDataSchema.optional(),

    // Meta
    $schema: z.string().optional(),
    __sourcePath: z.string().optional(),
    __saveData: createSaveDataSchema(
      z.preprocess((entry) => fromLegacySkyBoxOverrides(entry) ?? entry, SkyBoxOverridesSchema)
    ),
  })
  .refine(
    // A layer is on when its key is there, unless it says `enabled: false`
    (def) => !isLayerOn(def.clouds) || isLayerOn(def.atmosphere),
    {
      error: 'Clouds need an enabled atmosphere (they are lit and seen through it).',
      path: ['clouds'],
    }
  );

/** A sky box asset file (or an inline sky box in scene JSON): the definition, with the legacy
 * `{ type, params }` shape converted to it first. */
export const SkyBoxAssetSchema = z.preprocess(
  (input) => (isLegacySkyBoxProps(input) ? fromLegacySkyBoxProps(input) ?? input : input),
  SkyBoxDefSchema
);

export type SkyBoxAsset = z.infer<typeof SkyBoxAssetSchema>;
