import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { DebugDataSchema } from './_helperSchemas';
import { TexOptsSchema } from './textureSchema';
import { AssetFileNameSchema, ImportedAssetOptimizeSchema } from './assetsConfigSchema';

/** A GLTF/GLB import: only assets (geometries + opt-in textures) are registered, no entities.
 * Scene `meshes` reference the imported geometries by id (`${id}/${nodeName}`). */
export const ImportedAssetOverridesSchema = z.object({
  __meta: MetaSchema.optional(),

  /** Import id, also the prefix of the imported geometry/texture ids. Default: the JSON file's
   * basename (without `.importedAsset.json`). */
  id: z.string().optional(),
  fileName: AssetFileNameSchema.optional(),
  /** Also register the textures of the glTF material slots (default false). */
  importTextures: z
    .union([
      z.boolean(),
      z.object({ texOpts: TexOptsSchema.optional(), isPersistent: z.boolean().optional() }),
    ])
    .optional(),
  /** Only import one node, by child index (or nested index path) of the glTF root. */
  meshIndex: z.union([z.number(), z.array(z.number())]).optional(),
  isPersistent: z.boolean().optional(),
  throwOnError: z.boolean().optional(),
  debugData: DebugDataSchema.optional(),
});

export type ImportedAssetOverrides = z.infer<typeof ImportedAssetOverridesSchema>;

export const ImportedAssetSchema = z.object({
  $schema: z.string().optional(),
  ...ImportedAssetOverridesSchema.omit({ __meta: true }).shape,
  fileName: AssetFileNameSchema,
  /** Build time only (p300): not per scene, and never read by the runtime */
  optimize: ImportedAssetOptimizeSchema.optional(),
  __sourcePath: z.string().optional(),
  /** Bytes on disk of the .glb/.gltf (not a .gltf's external buffers), baked in by gatherAppData. */
  __fileSize: z.number().optional(),
  __saveData: createSaveDataSchema(ImportedAssetOverridesSchema),
});

export type ImportedAsset = z.infer<typeof ImportedAssetSchema>;
