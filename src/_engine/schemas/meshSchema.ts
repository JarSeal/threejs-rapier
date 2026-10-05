import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { CoreEntityOptsSchema, Vector3Schema, Vector4Schema } from './_helperSchemas';
import { GeoPropsSchema } from './geometrySchema';
import { MaterialAssetSchema, MaterialVariantOverridesSchema } from './materialSchema';
import { MeshLodDefSchema } from './lodSchema';

export const MeshPropsSchema = z.object({
  geo: z.union([GeoPropsSchema, z.string()]),
  mat: z.union([MaterialAssetSchema, z.string()]),
  matOverrides: MaterialVariantOverridesSchema.optional(),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
  preWarm: z.boolean().optional(),
  position: Vector3Schema.optional(),
  rotation: Vector3Schema.optional(),
  quaternion: Vector4Schema.optional(),
  appId: z.string().optional(),
  /** Native Object3D.frustumCulled (Three.js's own per-mesh render-list culling). Defaults to Three's own default (true). */
  frustumCullingEnabled: z.boolean().optional(),
  /** Levels of detail (p348), or `AUTO` from the geometry's LOD chain, see setMeshLod. */
  lod: MeshLodDefSchema.optional(),
  // physicsParams: z.union([]),
});

const PartialGeoProps = z.union(GeoPropsSchema.options.map((variant) => variant.partial()));
const PartialMatProps = z.union(MaterialAssetSchema.options.map((variant) => variant.partial()));

const MeshOverridesSchema = z.object({
  geo: z.union([PartialGeoProps, z.string()]).optional(),
  mat: z.union([PartialMatProps, z.string()]).optional(),
  matOverrides: MaterialVariantOverridesSchema.optional(),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
  preWarm: z.boolean().optional(),
  position: Vector3Schema.optional(),
  rotation: Vector3Schema.optional(),
  quaternion: Vector4Schema.optional(),
  frustumCullingEnabled: z.boolean().optional(),
  /** Replaces the mesh's whole `lod` in this scene (the save entry merges shallowly). */
  lod: MeshLodDefSchema.optional(),
  __meta: MetaSchema.optional(),
});

export type MeshOverrides = z.infer<typeof MeshOverridesSchema>;

export const MeshAssetSchema = z.object({
  $schema: z.string().optional(),
  props: MeshPropsSchema,
  entityOpts: CoreEntityOptsSchema.optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(MeshOverridesSchema),
});

export type MeshAsset = z.infer<typeof MeshAssetSchema>;
