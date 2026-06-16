import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { ColorSpaceSchema, DebugDataSchema } from './_helperSchemas';

const SkyBoxOverridesSchema = z.object({
  file: z.string().optional(),
  path: z.string().optional(),
  textureId: z.string(),
  colorSpace: ColorSpaceSchema.optional(),
  roughness: z.number().optional(),
  cubeTextureRotate: z.number().optional(),
  flipY: z.boolean().optional(),
  __meta: MetaSchema.optional(),
});

export type SkyBoxOverrides = z.infer<typeof SkyBoxOverridesSchema>;

const SkyBoxBasePropsSchema = z.object({
  id: z.string().optional(),
  isCurrent: z.boolean().optional(),
  sceneId: z.string().optional(),
  debugData: DebugDataSchema.optional(),

  // Meta
  $schema: z.string().optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(SkyBoxOverridesSchema),
});

export const SkyBoxAssetSchema = z.union([
  z.object({
    ...SkyBoxBasePropsSchema.shape,
    type: z.literal('EQUIRECTANGULAR'),
    params: z.object({
      file: z.string().optional(),
      path: z.string().optional(),
      textureId: z.string(),
      colorSpace: ColorSpaceSchema.optional(),
      roughness: z.number().optional(),
    }),
  }),
  z.object({
    ...SkyBoxBasePropsSchema.shape,
    type: z.literal('CUBEMAP'),
    params: z.object({
      fileName: z.string().optional(),
      path: z.string().optional(),
      textureId: z.string().optional(),
      colorSpace: ColorSpaceSchema.optional(),
      roughness: z.number().optional(),
      cubeTextureRotate: z.number().optional(),
      flipY: z.boolean().optional(),
    }),
  }),
  z.object({
    ...SkyBoxBasePropsSchema.shape,
    type: z.literal('SKYANDSUN'),
    params: z.null(),
  }),
]);

export type SkyBoxAsset = z.infer<typeof SkyBoxAssetSchema>;
