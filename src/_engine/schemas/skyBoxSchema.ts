import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { ColorJSONSchema, ColorSpaceSchema, DebugDataSchema } from './_helperSchemas';
import {
  fromLegacySkyBoxOverrides,
  fromLegacySkyBoxProps,
  isLegacySkyBoxProps,
} from '../core/SkyBox/legacySkyBox';

// A sky box definition is a set of layers. p111 has the base and env layers; later plans add
// their own layers (atmosphere, suns, clouds, ...) as optional keys.

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

export const SkyBoxOverridesSchema = z.object({
  base: SkyBoxBaseOverridesSchema.optional(),
  env: SkyBoxEnvSchema.partial().optional(),
  __meta: MetaSchema.optional(),
});

export type SkyBoxOverrides = z.infer<typeof SkyBoxOverridesSchema>;

// Definition

/** A sky box definition as authored (JSON or code). `SkyBoxDef` (SkyBox/SkyBoxTypes.ts) is its runtime type. */
export const SkyBoxDefSchema = z.object({
  id: z.string(),
  /** Whether this is the sky box its scene starts with. Without one, the first registered is. */
  isDefault: z.boolean().optional(),
  /** A preset to start from (p114). Accepted, but not used yet. */
  preset: z.string().optional(),
  base: SkyBoxBaseSchema,
  env: SkyBoxEnvSchema.optional(),
  debugData: DebugDataSchema.optional(),

  // Meta
  $schema: z.string().optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(
    z.preprocess((entry) => fromLegacySkyBoxOverrides(entry) ?? entry, SkyBoxOverridesSchema)
  ),
});

/** A sky box asset file (or an inline sky box in scene JSON): the definition, with the legacy
 * `{ type, params }` shape converted to it first. */
export const SkyBoxAssetSchema = z.preprocess(
  (input) => (isLegacySkyBoxProps(input) ? fromLegacySkyBoxProps(input) ?? input : input),
  SkyBoxDefSchema
);

export type SkyBoxAsset = z.infer<typeof SkyBoxAssetSchema>;
