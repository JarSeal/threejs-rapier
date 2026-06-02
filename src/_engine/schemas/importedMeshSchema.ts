import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { CoreEntityOptsSchema } from './_helperSchemas';

const ImportedMeshPropsSchema = z.object({
  fileName: z.string(),
  appId: z.string().optional(),
  importGroup: z.boolean().optional(),
  allMeshesVisible: z.boolean().optional(),
  groupId: z.string().optional(),
  groupName: z.string().optional(),
  meshIndex: z.union([z.number(), z.array(z.number())]).optional(),
  throwOnError: z.boolean().optional(),
  saveMaterial: z.boolean().optional(),
  // physicsParams: z.union([]),
});

const ImportedMeshOverrides = z.object({
  ...ImportedMeshPropsSchema.partial().shape,
  __meta: MetaSchema.optional(),
});

export const ImportedMeshAssetSchema = z.object({
  $schema: z.string().optional(),
  props: ImportedMeshPropsSchema,
  entityOpts: CoreEntityOptsSchema.optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(ImportedMeshOverrides),
});

export type ImportedMeshAsset = z.infer<typeof ImportedMeshAssetSchema>;
