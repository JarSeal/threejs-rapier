import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { ColorSpaceSchema, DebugDataSchema, UserDataSchema } from './_helperSchemas';
import {
  AssetFileNameSchema,
  PublicFileNameSchema,
  TextureOptimizeSchema,
} from './assetsConfigSchema';

export const TexOptsSchema = z.object({
  image: z.unknown().optional(), // Can't validate TexImageSource or OffscreenCanvas with zod, so using unknown
  mapping: z.number().optional(),
  wrapS: z.number().optional(),
  wrapT: z.number().optional(),
  magFilter: z.number().optional(),
  minFilter: z.number().optional(),
  type: z.number().optional(),
  anisotropy: z.number().optional(),
  colorSpace: ColorSpaceSchema.optional(),
});

export type TexOpts = z.infer<typeof TexOptsSchema>;

export const TextureOverridesSchema = z.object({
  __meta: MetaSchema.optional(),

  id: z.string().optional(),
  fileName: AssetFileNameSchema.optional(),
  /** URL prefix of a src/public file name; not with a `./` file name */
  path: z.string().optional(),
  useHDRLoader: z.boolean().optional(),
  texOpts: TexOptsSchema.optional(),
  throwOnError: z.boolean().optional(),
  userData: UserDataSchema.optional(),
  debugData: DebugDataSchema.optional(),
});

export type TextureOverrides = z.infer<typeof TextureOverridesSchema>;

export const TextureAssetSchema = z.object({
  $schema: z.string().optional(),
  ...TextureOverridesSchema.omit({ __meta: true }).shape,
  /** Build time only (p300): not per scene, and never read by the runtime */
  optimize: TextureOptimizeSchema.optional(),
  __saveData: createSaveDataSchema(TextureOverridesSchema),
  __sourcePath: z.string().optional(),
  /** Bytes on disk (all six faces for a cube texture), baked in by gatherAppData. */
  __fileSize: z.number().optional(),
});

export type TextureAsset = z.infer<typeof TextureAssetSchema>;

/** A texture declared inline in a scene JSON: the asset pipeline only reads `*.texture.json`s. */
export const InlineTextureSchema = TextureAssetSchema.omit({ optimize: true }).extend({
  fileName: PublicFileNameSchema.optional(),
});

/** A scene's `backgroundTexture` given inline */
export const InlineTextureOverridesSchema = TextureOverridesSchema.omit({ __meta: true }).extend({
  fileName: PublicFileNameSchema.optional(),
});
