import { z } from 'zod';

/**
 * Asset optimization settings (docs/plans/_DONE_p300_asset-optimization-pipeline-plan.md, DD2): the
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

const BudgetMBSchema = z.number().positive().nullable().optional();

/**
 * Limits an optimized asset must stay within (p300 Phase 4), or the production build fails for an
 * asset that a shipped scene uses and `yarn assets` exits 1. MB are 10^6 bytes.
 */
export const AssetBudgetSchema = z
  .strictObject({
    vramMB: BudgetMBSchema.describe(
      "Estimated GPU memory of the whole asset in MB: its textures (KTX2 at 1 B/px, the most it takes on any device) plus a GLB's geometry (null: no limit)."
    ),
    downloadMB: BudgetMBSchema.describe("The output file's size in MB (null: no limit)."),
  })
  .describe(
    "Per-asset limits. Set in an asset JSON's own optimize, it also replaces the per-texture ceiling (each texture's VRAM must fit its slot's maxSize and codec as set without the asset JSON's overrides)."
  );

export type AssetBudget = z.infer<typeof AssetBudgetSchema>;

/** One level of settings: the defaults, a profile, a rule's or an asset's own overrides. */
export const OptimizeLevelSchema = z.strictObject({
  textures: TexturesSettingsSchema.optional(),
  mesh: MeshSettingsSchema.optional(),
  budget: AssetBudgetSchema.optional(),
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
  budget: AssetBudgetSchema.optional(),
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

const PackFileSchema = z
  .string()
  .describe(
    'A source image relative to this JSON ("./source/ao.png"), or a URL path served from src/public. 8 or 16 bits.'
  );

const PackMultiplySchema = z
  .union([
    z.number().describe('A constant factor.'),
    z.strictObject({
      src: PackFileSchema,
      channel: z
        .enum(['r', 'g', 'b', 'a'])
        .optional()
        .describe('The channel of `src` (default r).'),
      strength: z
        .number()
        .min(0)
        .optional()
        .describe('value × (1 + (factor − 1) × strength), eg. 0.8 for AO into albedo (default 1).'),
    }),
  ])
  .describe('Multiplied in after remap and invert (linear values), eg. AO into the albedo.');

export const PACK_TARGETS = ['r', 'g', 'b', 'a', 'rg', 'rgb', 'rgba'] as const;

export type PackTarget = (typeof PACK_TARGETS)[number];

const PackChannelSchema = z.union([
  z.number().describe('A constant (0..1, linear) in every channel of the target.'),
  z.strictObject({
    src: PackFileSchema,
    channel: z
      .string()
      .regex(/^[rgba]{1,4}$/)
      .optional()
      .describe(
        'The channels of `src`, one per target channel (default: the target\'s own, eg. "rgb"). A greyscale image has its grey in r, g and b.'
      ),
    colorSpace: z
      .enum(['srgb', 'linear'])
      .optional()
      .describe(
        'How `src` is encoded (alpha is always linear). Default: srgb for the colour channels of an sRGB texture (texOpts.colorSpace), else linear.'
      ),
    normal: z
      .boolean()
      .optional()
      .describe(
        '`src` is a normal map: it is resized as unit vectors, before its channels are taken. Only `invert` applies.'
      ),
    remap: z
      .union([z.literal('auto'), z.tuple([z.number(), z.number()])])
      .optional()
      .describe('Maps [min, max] to 0..1; auto: the full range of the channels taken.'),
    invert: z.boolean().optional().describe("1 − value, after remap (eg. a DirectX normal's G)."),
    multiply: PackMultiplySchema.optional(),
  }),
]);

/**
 * A texture built from several source images (p300 DD5), in place of `fileName`. The output has
 * the channels its targets cover: r, rg, rgb or rgba (two channels are written as RGB, B = 0).
 */
export const TexturePackSchema = z
  .strictObject({
    size: z
      .tuple([z.number().int().min(1), z.number().int().min(1)])
      .optional()
      .describe(
        "Width and height the channels are combined at (default: the sources' size, which must then agree). The optimize step resizes the result to its maxSize."
      ),
    channels: z
      .strictObject(
        Object.fromEntries(
          PACK_TARGETS.map((target) => [target, PackChannelSchema.optional()])
        ) as {
          [target in PackTarget]: z.ZodOptional<typeof PackChannelSchema>;
        }
      )
      .describe('Per output channel or channel group: a source channel, or a constant.'),
  })
  .superRefine((pack, ctx) => {
    const covered = new Map<string, PackTarget>();
    for (const target of PACK_TARGETS) {
      const spec = pack.channels[target];
      if (spec === undefined) continue;
      for (const letter of target) {
        const other = covered.get(letter);
        if (other) {
          ctx.addIssue({
            code: 'custom',
            path: ['channels', target],
            message: `"${other}" and "${target}" both set ${letter}`,
          });
        }
        covered.set(letter, target);
      }
      if (typeof spec === 'number') continue;
      if (spec.channel && spec.channel.length !== target.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['channels', target, 'channel'],
          message: `"${target}" takes ${target.length} channel(s), "${spec.channel}" names ${spec.channel.length}`,
        });
      }
      if (spec.normal && (spec.remap || spec.multiply || spec.colorSpace)) {
        ctx.addIssue({
          code: 'custom',
          path: ['channels', target],
          message: 'a normal map source takes `invert` only (no remap, multiply or colorSpace)',
        });
      }
      if (spec.normal && (spec.channel ?? target).includes('a')) {
        ctx.addIssue({
          code: 'custom',
          path: ['channels', target],
          message: "a normal map's channels are r, g and b",
        });
      }
    }
    const letters = ['r', 'g', 'b', 'a'];
    const last = Math.max(...[...covered.keys()].map((letter) => letters.indexOf(letter)));
    const missing = letters.slice(0, last + 1).filter((letter) => !covered.has(letter));
    if (!covered.size) {
      ctx.addIssue({ code: 'custom', path: ['channels'], message: 'no channels' });
    } else if (missing.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message: `the output channels are r, rg, rgb or rgba: set ${missing.map((l) => `"${l}"`).join(', ')} too (eg. to 0)`,
      });
    }
  })
  .describe(
    'Build time only (p300 DD5): the texture packed from source images, in place of `fileName`.'
  );

export type TexturePack = z.infer<typeof TexturePackSchema>;

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

const BytesInOutSchema = z.object({ in: z.number(), out: z.number() });

/**
 * Baked into the generated data by gatherAppData from a pipeline run (p300 §5), never written by
 * hand. Every key is unset without a run.
 */
export const GeneratedAssetFieldsSchema = z.object({
  /** The pipeline's output, what the runtime loads. Unset when there's none (encoder missing, a
   * failed encode, a remote file): the runtime loads the source. */
  __url: z.string().optional(),
  /** The source as the dev server serves it (DD8 level 3's override). Not in production data,
   * which ships no relative sources; none for a pack. */
  __sourceUrl: z.string().optional(),
  /** Download: the source files vs the output */
  __bytes: BytesInOutSchema.optional(),
  /** Estimated GPU memory (optimized only): the source as RGBA8 vs the output */
  __vramBytes: BytesInOutSchema.optional(),
  /** A standalone texture's codec (optimized only) */
  __codec: TextureCodecSchema.optional(),
  /** An imported asset's LOD chains built into its GLB (p347 Phase 3), for tooling: per glTF mesh
   * primitive, its extent (in its own, possibly quantized, units) and each level's triangles and
   * error (levels[0] is the base). The runtime reads the GLB's own. */
  __lodChain: z
    .array(
      z.object({
        mesh: z.string(),
        primitive: z.number(),
        extent: z.number(),
        vertices: z.enum(['BASE', 'WELDED', 'OWN']),
        levels: z.array(z.object({ triangles: z.number(), error: z.number() })),
      })
    )
    .optional(),
});

export type GeneratedAssetFields = z.infer<typeof GeneratedAssetFieldsSchema>;
