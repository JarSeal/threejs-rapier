import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { CoreEntityOptsSchema, Vector3Schema, Vector4Schema } from './_helperSchemas';
import { GeoPropsSchema } from './geometrySchema';
import { MaterialAssetSchema } from './materialSchema';

const MeshPropsSchema = z.object({
  geo: z.union([GeoPropsSchema, z.string()]),
  mat: z.union([MaterialAssetSchema, z.string()]),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
  preWarm: z.boolean().optional(),
  position: Vector3Schema.optional(),
  rotation: Vector3Schema.optional(),
  quaternion: Vector4Schema.optional(),
  appId: z.string().optional(),
});

const PartialGeoProps = z.union(GeoPropsSchema.options.map((variant) => variant.partial()));
const PartialMatProps = z.union(MaterialAssetSchema.options.map((variant) => variant.partial()));

const MeshOverrides = z.object({
  geo: z.union([PartialGeoProps, z.string()]).optional(),
  mat: z.union([PartialMatProps, z.string()]).optional(),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
  preWarm: z.boolean().optional(),
  position: Vector3Schema.optional(),
  rotation: Vector3Schema.optional(),
  quaternion: Vector4Schema.optional(),
  __meta: MetaSchema.optional(),
});

export type MeshOverrides = z.infer<typeof MeshOverrides>;

export const MeshAssetSchema = z.object({
  $schema: z.string().optional(),
  props: MeshPropsSchema,
  entityOpts: CoreEntityOptsSchema.optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(MeshOverrides),
});

export type MeshAsset = z.infer<typeof MeshAssetSchema>;
