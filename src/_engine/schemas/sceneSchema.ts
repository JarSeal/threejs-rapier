/* eslint-disable camelcase */
import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { CameraAssetSchema } from './cameraSchema';
import { LightAssetSchema } from './lightSchema';
import { GeoAssetSchema } from './geometrySchema';
import { TextureAssetSchema } from './textureSchema';
import { MaterialAssetSchema } from './materialSchema';

const AssetReferenceOrInline = z.union([z.string(), z.record(z.string(), z.unknown())]);

const SceneSavebleFieldsSchema = z.object({
  $schema: z.string().optional(),
  __meta: MetaSchema.optional(),

  isDebugScene: z.boolean().optional(),

  // Optional Metadata (Stripped during production bundling)
  name: z.string().optional(),
  description: z.string().optional(),
  comments: z.any().optional(),
  todo: z.any().optional(),

  // Scene Asset Registries Map arrays
  cameras: z.array(z.union([z.string(), CameraAssetSchema])).optional(),
  lights: z.array(z.union([z.string(), LightAssetSchema])).optional(),
  geometries: z.array(z.union([z.string(), GeoAssetSchema])).optional(),
  textures: z.array(z.union([z.string(), TextureAssetSchema])).optional(),
  materials: z.array(z.union([z.string(), MaterialAssetSchema])).optional(),
  meshes: z.array(AssetReferenceOrInline).optional(),
  importedMeshes: z.array(AssetReferenceOrInline).optional(),
  skyboxes: z.array(AssetReferenceOrInline).optional(),
});

export const SceneAssetSchema = SceneSavebleFieldsSchema.omit({ __meta: true }).extend({
  id: z.string({
    error: "Scene 'id' is required for index parsing.",
  }),
  sceneFile: z.string({
    error: "Property 'sceneFile' is required to route your stage execution script.",
  }),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(SceneSavebleFieldsSchema),
});

export type SceneAsset = z.infer<typeof SceneAssetSchema>;
