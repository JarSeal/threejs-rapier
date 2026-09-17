import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { ColorSpaceSchema, DebugDataSchema, UserDataSchema } from './_helperSchemas';

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
  fileName: z.string().optional(),
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
  __saveData: createSaveDataSchema(TextureOverridesSchema),
  __sourcePath: z.string().optional(),
});

export type TextureAsset = z.infer<typeof TextureAssetSchema>;
