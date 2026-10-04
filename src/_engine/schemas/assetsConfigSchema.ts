import { z } from 'zod';

/**
 * Asset optimization settings (docs/plans/p300_asset-optimization-pipeline-plan.md, DD2): the
 * `assets.config.json` at the repo root (defaults, profiles, glob rules) and the per-asset
 * `optimize` key of `*.texture.json` / `*.importedAsset.json`. Build time only: the runtime never
 * reads these. Strict objects, so a misspelt key is an error instead of a silently ignored one.
 */

export const TextureCodecSchema = z
  .enum(['uastc', 'etc1s', 'none'])
  .describe(
    'uastc: 1 B/px on every device (BC7 / ASTC 4×4), the default. etc1s: smallest download, colour slots only. none: not encoded (exact data, CPU readback).'
  );

export type TextureCodec = z.infer<typeof TextureCodecSchema>;

export const TextureSettingsSchema = z.strictObject({
  codec: TextureCodecSchema.optional(),
  maxSize: z
    .number()
    .int()
    .min(4)
    .nullable()
    .optional()
    .describe('Largest side in px, downscaled to fit (null: the source size).'),
  mipmaps: z.boolean().optional().describe('Write the full mip chain (default true).'),
  level: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe('UASTC only: --uastc-quality, 0 (fastest) to 4 (slowest).'),
  rdo: z
    .number()
    .min(0)
    .optional()
    .describe('UASTC only: RDO lambda (0: off). 2 for colour, 1 for normal / ORM / data.'),
  zstd: z
    .number()
    .int()
    .min(0)
    .max(22)
    .optional()
    .describe('UASTC only: Zstandard supercompression level (0: off).'),
  quality: z.number().int().min(1).max(255).optional().describe('ETC1S only: --qlevel, 1 to 255.'),
  normalMode: z
    .boolean()
    .optional()
    .describe('Two-channel normal map (X in RGB, Y in A). Needs a material that unpacks it.'),
});

export type TextureSettings = z.infer<typeof TextureSettingsSchema>;

export const TEXTURE_SLOTS = [
  'default',
  'baseColor',
  'normal',
  'metallicRoughness',
  'occlusion',
  'emissive',
  'orm',
  'data',
] as const;

export const TextureSlotSchema = z
  .enum(TEXTURE_SLOTS)
  .describe(
    'glTF slots, orm (packed occlusion / roughness / metalness), data (splat maps, masks, LUTs, height) or default.'
  );

export type TextureSlot = z.infer<typeof TextureSlotSchema>;

/** Per-slot settings; at each level a slot's entry merges over that level's `default`. */
export const TexturesSettingsSchema = z.strictObject({
  default: TextureSettingsSchema.optional(),
  baseColor: TextureSettingsSchema.optional(),
  normal: TextureSettingsSchema.optional(),
  metallicRoughness: TextureSettingsSchema.optional(),
  occlusion: TextureSettingsSchema.optional(),
  emissive: TextureSettingsSchema.optional(),
  orm: TextureSettingsSchema.optional(),
  data: TextureSettingsSchema.optional(),
});

export type TexturesSettings = z.infer<typeof TexturesSettingsSchema>;

export const MeshSettingsSchema = z.strictObject({
  codec: z
    .enum(['meshopt', 'draco', 'none'])
    .optional()
    .describe('Geometry compression. meshopt (default) also shrinks VRAM when quantized.'),
  quantize: z
    .boolean()
    .optional()
    .describe(
      'Quantize, reorder and filter the vertices. false: lossless (EXT_meshopt_compression alone), the collider default.'
    ),
  simplify: z
    .number()
    .gt(0)
    .max(1)
    .nullable()
    .optional()
    .describe('Target triangle ratio (null: off).'),
});

export type MeshSettings = z.infer<typeof MeshSettingsSchema>;

/** One level of settings: the defaults, a profile, a rule's or an asset's own overrides. */
export const OptimizeLevelSchema = z.strictObject({
  textures: TexturesSettingsSchema.optional(),
  mesh: MeshSettingsSchema.optional(),
});

export type OptimizeLevel = z.infer<typeof OptimizeLevelSchema>;

const OptimizeObjectShape = {
  profile: z.string().optional().describe('A profile of assets.config.json.'),
  slot: TextureSlotSchema.optional().describe(
    "A standalone texture's slot (default: default). A GLB's textures are classified by their material slot."
  ),
  textures: z
    .union([z.literal(false), TexturesSettingsSchema])
    .optional()
    .describe('Per-slot overrides, or false to keep the textures as they are.'),
  mesh: z
    .union([z.literal(false), MeshSettingsSchema])
    .optional()
    .describe('Overrides, or false to keep the geometry as it is.'),
};

/** The `optimize` key of an asset JSON: false passes the asset through as it is. */
export const AssetOptimizeSchema = z
  .union([z.literal(false), z.strictObject(OptimizeObjectShape)])
  .describe('Asset optimization (p300): a profile plus overrides, or false to pass it through.');

export type AssetOptimize = z.infer<typeof AssetOptimizeSchema>;

/** A `*.texture.json`'s `optimize`: it names its slot and has no geometry. */
export const TextureOptimizeSchema = z
  .union([z.literal(false), z.strictObject(OptimizeObjectShape).omit({ mesh: true })])
  .describe(
    'Asset optimization (p300): a profile, the slot and per-slot overrides, or false to keep the file as it is.'
  );

/** A `*.importedAsset.json`'s `optimize`: its textures are classified by their material slot. */
export const ImportedAssetOptimizeSchema = z
  .union([z.literal(false), z.strictObject(OptimizeObjectShape).omit({ slot: true })])
  .describe(
    'Asset optimization (p300): a profile plus texture / mesh overrides, or false to keep the file as it is.'
  );

/** `./` or `../`: a source file relative to its asset JSON (p300 DD3). */
export const isJsonRelativeFileName = (fileName: string) => /^\.\.?\//.test(fileName);

export const AssetFileNameSchema = z
  .string()
  .describe(
    'Relative to this JSON file ("./source/rock.png", optimized into src/public/aek-assets/), or a URL path served from src/public ("/textures/rock.png", optionally after `path`).'
  );

/** For assets declared inline in a scene JSON: the pipeline doesn't see those, so no `./` sources. */
export const PublicFileNameSchema = z
  .string()
  .refine((fileName) => !isJsonRelativeFileName(fileName), {
    message:
      'A file relative to the JSON ("./", "../") needs its own *.texture.json / *.importedAsset.json, not an inline asset.',
  })
  .describe('A URL path served from src/public ("/textures/rock.png", optionally after `path`).');

export const AssetsConfigRuleSchema = z.strictObject({
  glob: z
    .string()
    .describe(
      'Matched against the source file path relative to the repo root (eg. "src/app/props/**/*.glb"). Supports **, *, ? and {a,b}.'
    ),
  optimize: z
    .literal(false)
    .optional()
    .describe('Pass the matched assets through as they are. Wins over everything else.'),
  ...OptimizeObjectShape,
});

export type AssetsConfigRule = z.infer<typeof AssetsConfigRuleSchema>;

export const AssetsConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  defaults: OptimizeLevelSchema.optional().describe(
    "Merged over the engine's built-in defaults (devTools/assetPipeline/settings.ts)."
  ),
  profiles: z.record(z.string(), OptimizeLevelSchema).optional(),
  rules: z
    .array(AssetsConfigRuleSchema)
    .optional()
    .describe('Applied in order (later wins) to every asset whose source path matches.'),
});

export type AssetsConfig = z.infer<typeof AssetsConfigSchema>;
