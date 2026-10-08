import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { CameraAssetSchema } from './cameraSchema';
import { LightAssetSchema } from './lightSchema';
import { GeoPropsSchema } from './geometrySchema';
import { InlineTextureOverridesSchema, InlineTextureSchema } from './textureSchema';
import { MaterialAssetSchema } from './materialSchema';
import { PostFxAssetSchema } from './postFxSchema';
import { SkyBoxAssetSchema } from './skyBoxSchema';
import { ColorJSONSchema } from './_helperSchemas';
import { SceneSpatialDomainsSchema } from './spatialDomainSchema';

const AssetReferenceOrInline = z.union([z.string(), z.record(z.string(), z.unknown())]);

const SceneOverridesSchema = z.object({
  $schema: z.string().optional(),
  __meta: MetaSchema.optional(),

  isDebugScene: z.boolean().optional(),

  // Optional Metadata (Stripped during production bundling)
  name: z.string().optional(),
  description: z.string().optional(),
  comments: z.any().optional(),
  todo: z.any().optional(),

  backgroundColor: ColorJSONSchema.optional(),
  backgroundTexture: z.union([InlineTextureOverridesSchema, z.string()]).optional(),

  // Scene Asset Registries Map arrays
  cameras: z.array(z.union([z.string(), CameraAssetSchema])).optional(),
  lights: z.array(z.union([z.string(), LightAssetSchema])).optional(),
  geometries: z.array(z.union([z.string(), GeoPropsSchema])).optional(),
  textures: z.array(z.union([z.string(), InlineTextureSchema])).optional(),
  materials: z.array(z.union([z.string(), MaterialAssetSchema])).optional(),
  meshes: z.array(AssetReferenceOrInline).optional(),
  importedAssets: z.array(AssetReferenceOrInline).optional(),
  skyboxes: z.array(z.union([z.string(), SkyBoxAssetSchema])).optional(),
  /** Ordered PostFX pass chain: unlike the other registries, array order is execution order (each pass builds on the previous pass's output). */
  postFx: z.array(z.union([z.string(), PostFxAssetSchema])).optional(),
  /** Whether the scene's PostFX chain starts switched on. Default true when `postFx` is non-empty. */
  postFxEnabled: z.boolean().optional(),
  /** Spatial domains this scene registers for itself, before any of its entities join one; dropped on its exit (`DEFAULT`: partial, merged over its world settings). */
  spatialDomains: SceneSpatialDomainsSchema.optional(),
  impostors: z
    .array(z.string())
    .optional()
    .describe(
      "Exported impostors (`*.impostor.json` ids): their atlases load with the scene's textures, and generateOctahedralImpostor / generateCrossQuads called with one's id builds from it instead of baking."
    ),
});

export type SceneOverrides = z.infer<typeof SceneOverridesSchema>;

export const SceneAssetSchema = SceneOverridesSchema.omit({ __meta: true }).extend({
  id: z.string({
    error: "Scene 'id' is required for index parsing.",
  }),
  sceneFile: z.string({
    error: "Property 'sceneFile' is required to route your stage execution script.",
  }),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(SceneOverridesSchema),
});

export type SceneAsset = z.infer<typeof SceneAssetSchema>;
