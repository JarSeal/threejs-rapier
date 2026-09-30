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
// and suns, p113 the day-night cycle and p114 the nebulae; later plans add their own layers as
// optional keys. A procedural layer is on when its key is there, unless it says `enabled: false`.

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
  /** The bake's cube face size, fixed per activation. Default 256, or 128 with day-night. 512
   * gives sharper mirror reflections for 4× the memory (a 1536×2048 half-float target); the
   * bake's GPU cost is per pass, so it barely changes with size (p110 spike). */
  size: SkyBoxEnvSizeSchema.optional(),
  /** Whether value changes and the day-night cycle re-bake the environment. False: only
   * activation, a rebuild and `bakeEnvironment()` do (reflections lag, the rest animates).
   * Default true. */
  dynamic: z.boolean().optional(),
  /** Day-night: re-bake once the sun has turned this many degrees since the last bake.
   * Default 1. */
  updateAngleDeg: z.number().min(0).optional(),
  /** Day-night: at most this many re-bakes per second while the cycle moves (0: only when it
   * stops or reverses). A bake is ~2 ms of GPU at any size (p110 spike). Default 1. */
  maxUpdatesPerSec: z.number().min(0).optional(),
  /** The nebula cube's face size (the nebulae are baked into a HalfFloat cube, re-baked only
   * when they change): 12.6 MB at 512, 50.3 MB at 1024. Default 512. */
  nebulaSize: z.union([z.literal(256), z.literal(512), z.literal(1024)]).optional(),
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
   * toggles it to fade. Every shadow-casting light is a full extra scene render. Default true for
   * suns[0], false for the others. */
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

// Sun layer (the disc and its halo; suns[0] also drives the atmosphere). Up to 4 suns.

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
  /** suns[1..3] with day-night (suns[0] follows the time of day either way). true: the
   * elevation and azimuth are where it stands at dayNight.timeOfDay (the start time), and it
   * turns with the sky from there, keeping its place among the stars and next to suns[0].
   * false: it stays at its elevation and azimuth. Default true. */
  rotateWithSky: z.boolean().optional(),
  /** A directional light that follows the sun. Default: none. */
  light: SkyBoxSunLightSchema.optional(),
});

// Moon light: a managed directional light aimed like the moon (the sun light's settings)

export const SkyBoxMoonLightSchema = SkyBoxSunLightSchema.extend({
  /** Scaled by the moon's lit fraction, its horizon fade and the night (it's off by day).
   * Default 0.3. */
  intensity: z.number().min(0).optional(),
  /** 'AUTO': a cool white (#b8c6ff) through the atmosphere's extinction along the moon.
   * Default 'AUTO'. */
  color: AutoOrColorSchema.optional(),
  /** Changing it re-creates the light (one rebuild of every lit material). Default false: one
   * shadow-casting sky light by default. */
  castShadow: z.boolean().optional(),
});

// Moon layer (the disc, lit by the sun into its phase). Up to 2 moons, each on its own orbit
// with day-night.

const SkyBoxMoonTextureSchema = z
  .object({
    file: z.string().optional(),
    path: z.string().optional(),
    textureId: z.string().optional(),
    /** Default 'srgb'. */
    colorSpace: ColorSpaceSchema.optional(),
    /** 'DISC': a picture of the moon's face as seen. 'EQUIRECTANGULAR': a map of the whole
     * sphere, its centre facing the viewer. Default 'DISC'. */
    projection: z.enum(['DISC', 'EQUIRECTANGULAR']).optional(),
  })
  .refine((texture) => Boolean(texture.file || texture.textureId), {
    error: 'A moon texture needs a file or a textureId.',
    path: ['file'],
  });

export const SkyBoxMoonSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Degrees above the horizon, without day-night (with it, the time and phase place the moon).
   * Default 30. */
  elevation: z.number().min(-90).max(90).optional(),
  /** Degrees, as the sun's (0 = +z, 90 = +x, 180 = -z), without day-night. Default 0. */
  azimuth: z.number().optional(),
  /** Multiplier on the disc's angular radius (the sun disc's, 0.533°). Default 1. */
  discSize: z.number().min(0).optional(),
  /** The lit disc's radiance. Default 2. */
  intensity: z.number().min(0).optional(),
  /** Multiplies the disc (and its texture). Default white. */
  color: ColorJSONSchema.optional(),
  /** How much the disc darkens toward its rim, 0-1. Default 0.2. */
  limbDarkening: z.number().min(0).max(1).optional(),
  /** The unlit side's brightness, relative to the lit side. Default 0.02. */
  earthshine: z.number().min(0).max(1).optional(),
  /** Changing it reloads the sky box. Default: none (a plain disc). */
  texture: SkyBoxMoonTextureSchema.optional(),
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. Default 0.5. */
  phase: z.number().min(0).lt(1).optional(),
  /** 'CYCLE': with day-night, the phase advances by 1 / lunarCycleDays per in-game day.
   * Default 'FIXED'. */
  phaseMode: z.enum(['FIXED', 'CYCLE']).optional(),
  /** In-game days per lunar cycle. Default 29.53. */
  lunarCycleDays: z.number().positive().optional(),
  /** Degrees the moon's path is tilted from the sun's, with day-night. Default 5. */
  inclination: z.number().min(0).max(90).optional(),
  /** A directional light that follows the moon, at night. Default: none. */
  light: SkyBoxMoonLightSchema.optional(),
});

// Stars layer (procedural; behind the atmosphere, which dims them near the horizon and hides
// them by day; never in the env bake)

const SkyBoxStarsTwinkleSchema = z.object({
  /** How much a star's brightness varies, 0-1. Default 0.2. */
  amount: z.number().min(0).max(1).optional(),
  /** Roughly how many times a second a star twinkles. Default 1. */
  frequency: z.number().min(0).optional(),
});

const SkyBoxMilkyWaySchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Default 0.15. */
  intensity: z.number().min(0).optional(),
  /** The band's pole: the band is the great circle around it (in the stars' frame, which turns
   * with the sky). Default [-0.87, 0.46, 0.18]. */
  direction: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** The band's half-width in degrees. Default 12. */
  width: z.number().min(0.1).max(90).optional(),
});

export const SkyBoxStarsSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** How many stars, 0-1. Default 0.5. */
  density: z.number().min(0).max(1).optional(),
  /** Default 1. */
  brightness: z.number().min(0).optional(),
  /** Multiplier on a star's angular size (never under ~1 pixel). Default 1. */
  size: z.number().min(0).optional(),
  /** How far star colours spread from white (blue to orange), 0-1. Default 0.5. */
  colorVariance: z.number().min(0).max(1).optional(),
  /** Default: amount 0.2, frequency 1. */
  twinkle: SkyBoxStarsTwinkleSchema.optional(),
  /** Sun elevations (degrees) where the stars start to show and where they are full.
   * Default [-4, -12]. */
  fadeRange: z.tuple([z.number(), z.number()]).optional(),
  /** Whether they turn with the sky (day-night: about the celestial pole). Default true. */
  rotateWithSky: z.boolean().optional(),
  /** Another pattern of stars. Default 0. */
  seed: z.number().int().min(0).optional(),
  /** A band of faint light along a great circle. Default: none. */
  milkyWay: SkyBoxMilkyWaySchema.optional(),
});

// Nebula layer (p114: procedural, baked into a cube once per change; behind the stars, and
// behind the atmosphere when there is one)

const Vec3TupleSchema = z.tuple([z.number(), z.number(), z.number()]);

export const SkyBoxNebulaSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** Another cloud pattern. Default 0. */
  seed: z.number().int().min(0).optional(),
  /** The centre (in the sky's frame, which turns with the day-night cycle). Default
   * [0, 0.2, -1]. */
  direction: Vec3TupleSchema.optional(),
  /** Angular radius in degrees. Default 25. */
  size: z.number().min(1).max(180).optional(),
  /** Edge softness, 0-1 (0: a hard edge; 1: fades from the centre). Default 0.6. */
  falloff: z.number().min(0).max(1).optional(),
  /** Length ÷ width (1: round). Default 1. */
  stretch: z.number().min(1).max(10).optional(),
  /** Degrees the long axis is turned about the centre, from the sky's up. Default 0. */
  orientation: z.number().optional(),
  /** 2-3 colours, from the thin edges to the dense core. Default ['#1c1450', '#b0307a',
   * '#ffc49a']. */
  colors: z.array(ColorJSONSchema).min(2).max(3).optional(),
  /** How much of the shape the cloud fills, 0-1. Default 0.5. */
  density: z.number().min(0).max(1).optional(),
  /** The cloud noise's detail (changing it rebuilds the bake's shader). Default 5. */
  octaves: z.number().int().min(2).max(6).optional(),
  /** Domain-warp strength (swirls), 0-2. Default 0.6. */
  warp: z.number().min(0).max(2).optional(),
  /** Dark dust lanes, 0-1. Default 0.4. */
  dust: z.number().min(0).max(1).optional(),
  /** HDR emission multiplier. Default 1. */
  brightness: z.number().min(0).optional(),
  /** Extra live stars inside the cloud, 0-1 (up to 3× as many). Default 0. */
  starBoost: z.number().min(0).max(1).optional(),
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

// Day-night cycle (p113): places the sun and moon from a time of day. Games drive it at runtime
// (setTimeOfDay, playDayNight, ...); these are its values on activation.

export const SkyBoxDayNightSchema = z.object({
  /** Default true. */
  enabled: z.boolean().optional(),
  /** The time on activation, in hours [0, 24). Default 12. */
  timeOfDay: z.number().min(0).lt(24).optional(),
  /** Real seconds per 24 in-game hours. Default 1200. */
  cycleDurationSec: z.number().positive().optional(),
  /** Time multiplier: negative runs it backwards, 0 freezes it. Default 1. */
  speed: z.number().optional(),
  /** Whether the cycle runs on activation. Default true. */
  playing: z.boolean().optional(),
  /** 'APP': runs while the app loop plays (a game pause pauses the sky). 'MAIN': runs with the
   * master loop, also while the app is paused. 'MANUAL': only setTimeOfDay changes it.
   * Default 'APP'. */
  timeSource: z.enum(['APP', 'MAIN', 'MANUAL']).optional(),
  /** Degrees north (negative: south). Default 45. */
  latitude: z.number().min(-90).max(90).optional(),
  /** Day of the year (1-365), for the sun's declination. Default 172 (the June solstice). */
  dayOfYear: z.number().min(0).max(366).optional(),
  /** Degrees. Default 23.44 (the Earth's). */
  axialTilt: z.number().min(0).max(90).optional(),
  /** Where north is: degrees clockwise seen from above, from -z (0) toward +x (90). Default 0. */
  northOffset: z.number().optional(),
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

const SkyBoxMoonOverridesSchema = SkyBoxMoonSchema.extend({
  light: SkyBoxMoonLightSchema.partial().optional(),
}).partial();

/** An array replaces the definition's entries; an index object (`{ "0": { ... } }`) changes
 * those entries only. */
const indexedOverrides = <T extends z.ZodType>(entry: T, max: number) =>
  z
    .union([z.array(entry).max(max), z.record(z.string().regex(/^(0|[1-9]\d*)$/), entry)])
    .optional();

export const SkyBoxOverridesSchema = z.object({
  base: SkyBoxBaseOverridesSchema.optional(),
  env: SkyBoxEnvSchema.partial().optional(),
  atmosphere: SkyBoxAtmosphereSchema.partial().optional(),
  /** An array replaces the definition's suns; an index object (`{ "0": { ... } }`) changes
   * those entries only. */
  suns: indexedOverrides(SkyBoxSunOverridesSchema, 4),
  /** As `suns`. */
  moons: indexedOverrides(SkyBoxMoonOverridesSchema, 2),
  /** As `suns`. */
  nebulae: indexedOverrides(SkyBoxNebulaSchema.partial(), 8),
  stars: SkyBoxStarsSchema.extend({
    twinkle: SkyBoxStarsTwinkleSchema.partial().optional(),
    milkyWay: SkyBoxMilkyWaySchema.partial().optional(),
  })
    .partial()
    .optional(),
  ambientLight: SkyBoxAmbientLightSchema.partial().optional(),
  clouds: SkyBoxCloudsSchema.partial().optional(),
  ground: SkyBoxGroundSchema.partial().optional(),
  dayNight: SkyBoxDayNightSchema.partial().optional(),
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
    /** Up to 4. suns[0] is the primary: it drives the atmosphere, the clouds' light and the
     * stars' fade. */
    suns: z.array(SkyBoxSunSchema).max(4).optional(),
    /** Up to 2. moons[0] lights the clouds at night. */
    moons: z.array(SkyBoxMoonSchema).max(2).optional(),
    stars: SkyBoxStarsSchema.optional(),
    /** Up to 8, baked into a cube (env.nebulaSize) once per change. */
    nebulae: z.array(SkyBoxNebulaSchema).max(8).optional(),
    ambientLight: SkyBoxAmbientLightSchema.optional(),
    /** Needs an enabled atmosphere. */
    clouds: SkyBoxCloudsSchema.optional(),
    ground: SkyBoxGroundSchema.optional(),
    /** While on, suns[0]'s and every moon's positions are derived from the time of day (and
     * the extra suns turn with the sky, see `rotateWithSky`). */
    dayNight: SkyBoxDayNightSchema.optional(),
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
