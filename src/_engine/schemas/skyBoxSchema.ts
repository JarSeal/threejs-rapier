import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { DebugDataSchema } from './_helperSchemas';

const SkyOverridesSchema = z.object({
  file: z.string().optional(),
  path: z.string().optional(),
  textureId: z.string(),
  colorSpace: z.number().optional(),
  roughness: z.number().optional(),
  cubeTextureRotate: z.number().optional(),
  flipY: z.boolean().optional(),
  __meta: MetaSchema.optional(),
});

const SkyBasePropsSchema = z.object({
  id: z.string().optional(),
  isCurrent: z.boolean().optional(),
  sceneId: z.string().optional(),
  debugData: DebugDataSchema.optional(),

  // Meta
  $schema: z.string().optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(SkyOverridesSchema),
});

export const SkyAssetSchema = z.union([
  z.object({
    ...SkyBasePropsSchema.shape,
    type: z.literal('EQUIRECTANGULAR'),
    params: z.object({
      file: z.string().optional(),
      path: z.string().optional(),
      textureId: z.string(),
      colorSpace: z.number().optional(),
      roughness: z.number().optional(),
    }),
  }),
  z.object({
    ...SkyBasePropsSchema.shape,
    type: z.literal('CUBEMAP'),
    params: z.object({
      fileName: z.string().optional(),
      path: z.string().optional(),
      textureId: z.string().optional(),
      colorSpace: z.number().optional(),
      roughness: z.number().optional(),
      cubeTextureRotate: z.number().optional(),
      flipY: z.boolean().optional(),
    }),
  }),
  z.object({
    ...SkyBasePropsSchema.shape,
    type: z.literal('SKYANDSUN'),
    params: z.null(),
  }),
]);

export type SkyAsset = z.infer<typeof SkyAssetSchema>;
