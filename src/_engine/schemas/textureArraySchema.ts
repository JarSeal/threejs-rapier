import { z } from 'zod';
import { DebugDataSchema, UserDataSchema } from './_helperSchemas';
import {
  GeneratedAssetFieldsSchema,
  isJsonRelativeFileName,
  TextureArrayOptimizeSchema,
} from './assetsConfigSchema';
import { TexOptsSchema } from './textureSchema';

/**
 * A texture array built by the asset pipeline (p299 D2): its layers resized to one size and
 * encoded as one KTX2 array (`ktx create --layers`). The runtime loads it like any texture
 * (`loadTextureAsync` returns a `CompressedArrayTexture`); a scene lists it in its `textures`.
 */

/** A layer naming a source file (`./`, `../` or a src/public URL path), not a texture asset */
export const isTextureArrayLayerFile = (layer: string) =>
  isJsonRelativeFileName(layer) || layer.startsWith('/');

export const TextureArrayAssetSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().optional(),
  layers: z
    .array(
      z
        .string()
        .min(1)
        .describe(
          'A texture asset\'s id (its source file or pack, not its output), or a source image relative to this JSON ("./source/moss.png") or served from src/public ("/textures/moss.png").'
        )
    )
    .min(1)
    .describe('The layers, in layer index order.'),
  size: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .optional()
    .describe(
      "Width and height every layer is resized to (default: the layers' size, which must then agree). The optimize step fits it into its maxSize."
    ),
  /** The array's sampler state and colour space (`colorSpace` decides how the layers are read) */
  texOpts: TexOptsSchema.omit({ image: true }).optional(),
  /** Build time only: never read by the runtime */
  optimize: TextureArrayOptimizeSchema.optional(),
  throwOnError: z.boolean().optional(),
  userData: UserDataSchema.optional(),
  debugData: DebugDataSchema.optional(),
  __sourcePath: z.string().optional(),
  /** Baked in by gatherAppData: each layer's name (a texture's id, a file's name without its
   * extension), by layer index */
  __layers: z.array(z.string()).optional(),
  ...GeneratedAssetFieldsSchema.omit({ __lodChain: true, __sourceUrl: true }).shape,
});

export type TextureArrayAsset = z.infer<typeof TextureArrayAssetSchema>;
