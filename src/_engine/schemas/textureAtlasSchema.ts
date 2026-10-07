import { z } from 'zod';
import { DebugDataSchema, UserDataSchema } from './_helperSchemas';
import { GeneratedAssetFieldsSchema, TextureArrayOptimizeSchema } from './assetsConfigSchema';
import { TexOptsSchema } from './textureSchema';

/**
 * A 2D texture atlas built by the asset pipeline (p299 D3): cells of any size packed into one
 * layout, one KTX2 output per map slot (albedo, normal, …), and a cell table. At runtime each slot
 * is an ordinary texture with the id `<atlasId>.<slot>` ({@link getAtlasSlotTextureId}); a scene
 * lists the atlas id in its `textures` for every slot, or a slot's id for that one.
 */

/** A slot's name: it ends its texture's id, so no dots */
export const ATLAS_SLOT_NAME_PATTERN = /^[A-Za-z][A-Za-z\d_-]*$/;

/** A slot's texture id */
export const getAtlasSlotTextureId = (atlasId: string, slot: string) => `${atlasId}.${slot}`;

export const ATLAS_MIP_CHAINS = ['PROTECTED', 'FULL'] as const;
export type AtlasMipChain = (typeof ATLAS_MIP_CHAINS)[number];

/** The mip levels of a full chain of a `width`×`height` image, level 0 included (down to 1×1) */
export const getFullMipLevelCount = (width: number, height: number) =>
  Math.floor(Math.log2(Math.max(width, height))) + 1;

const PxSchema = z.number().int();

export const TextureAtlasSlotSchema = z
  .strictObject({
    /** The slot texture's sampler state and colour space (`colorSpace` decides how its sources
     * are read) */
    texOpts: TexOptsSchema.omit({ image: true }).optional(),
    image: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A ready-made image of the whole layout (the atlas's `size`), relative to this JSON (\"./bake.png\") or served from src/public, or a texture asset's id: the slot isn't composed from its cells (no resize, edge extension or fill), so it holds them where their `rect`s say (every cell needs one) and no cell has a source in it. For an atlas a tool already composed, eg. an exported impostor's."
      ),
    fill: z
      .union([
        z.tuple([z.number(), z.number(), z.number()]),
        z.tuple([z.number(), z.number(), z.number(), z.number()]),
      ])
      .optional()
      .describe(
        'RGB(A), linear 0..1 like a pack constant: the atlas outside the cells, and the cells without a source in this slot (default transparent black; a normal map wants [0.5, 0.5, 1]). Not with `image`.'
      ),
    /** Build time only: never read by the runtime */
    optimize: TextureArrayOptimizeSchema.optional(),
    userData: UserDataSchema.optional(),
    debugData: DebugDataSchema.optional(),
  })
  .refine((slot) => !(slot.image && slot.fill), {
    message: '"image" is the whole slot: it has no "fill"',
  });

export type TextureAtlasSlot = z.infer<typeof TextureAtlasSlotSchema>;

export const TextureAtlasCellSchema = z
  .strictObject({
    id: z.string().min(1),
    rect: z
      .tuple([PxSchema.min(0), PxSchema.min(0), PxSchema.min(1), PxSchema.min(1)])
      .optional()
      .describe(
        "x, y, width and height in the atlas's px (top-left origin), the padding included: multiples of 4, and of the packer's grid (4 · 2^⌊log2 padding⌋) to keep every level the padding protects. Default: placed by the packer."
      ),
    size: z
      .tuple([PxSchema.min(1), PxSchema.min(1)])
      .optional()
      .describe(
        "A packed cell's content width and height in px, the padding not included (default: its first source's size, in the order of `slots`). Not with `rect`."
      ),
    sources: z
      .record(
        z.string(),
        z
          .string()
          .min(1)
          .describe(
            'A texture asset\'s id (its source file or pack, not its output), or a source image relative to this JSON ("./source/crack.png") or served from src/public ("/textures/crack.png").'
          )
      )
      .optional()
      .describe(
        'Per slot: the image resized into the cell. A slot left out gets its fill; a slot with an `image` takes none. Only left out when every slot has an `image`.'
      ),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Free-form, passed through to the cell table (eg. a decal's physical size)."),
  })
  .refine((cell) => !(cell.rect && cell.size), {
    message: '"rect" places the cell and sets its size: "size" is for a packed cell',
  });

export type TextureAtlasCell = z.infer<typeof TextureAtlasCellSchema>;

export const TextureAtlasAssetSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().optional(),
  size: z
    .tuple([PxSchema.min(4).multipleOf(4), PxSchema.min(4).multipleOf(4)])
    .describe(
      "The layout's width and height in px (multiples of 4). A slot over its maxSize drops its top mip levels."
    ),
  padding: PxSchema.min(0)
    .optional()
    .describe(
      "Px of edge extension around each cell's content (default 8). The mip chain stops at the level it protects: 2^level ≤ padding, so 16 keeps levels 0-4. Packed cells go on a grid of 4 · 2^⌊log2 padding⌋ px (64 for 16), so the last level's 4 × 4 compression blocks never hold two cells; an explicit rect off that grid shortens the chain."
    ),
  mipChain: z
    .enum(ATLAS_MIP_CHAINS)
    .optional()
    .describe(
      "PROTECTED (default): the mip chain stops at the last level the padding and the rects keep apart, so a cell never reads its neighbour. FULL: every level down to 1 × 1 (the exact 2 × 2 box, area-filtered past an odd size), so the cells mix below the protected levels: for cells whose neighbours are near-identical (an impostor's neighbouring views), where a short chain would shimmer at distance."
    ),
  slots: z
    .record(
      z
        .string()
        .regex(
          ATLAS_SLOT_NAME_PATTERN,
          "a slot's name is letters, digits, _ and - (it ends its texture's id, after a dot)"
        ),
      TextureAtlasSlotSchema
    )
    .refine((slots) => Object.keys(slots).length > 0, { message: 'no slots' })
    .describe('The map slots by name (letters, digits, _ and -), one output each.'),
  cells: z.array(TextureAtlasCellSchema).min(1),
  throwOnError: z.boolean().optional(),
  userData: UserDataSchema.optional(),
  debugData: DebugDataSchema.optional(),
  __sourcePath: z.string().optional(),
});

export type TextureAtlasAsset = z.infer<typeof TextureAtlasAssetSchema>;

export const DEFAULT_ATLAS_PADDING = 8;

/** One cell in the cell table */
export const TextureAtlasCellInfoSchema = z.object({
  /** The content rect as UVs, [u0, v0, u1, v1] with v up (three's, like a mesh's UVs) */
  uv: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** The content's width and height in the layout's px */
  size: z.tuple([z.number(), z.number()]),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type TextureAtlasCellInfo = z.infer<typeof TextureAtlasCellInfoSchema>;

/** A slot texture's `__atlas`, baked in by gatherAppData */
export const TextureAtlasSlotInfoSchema = z.object({
  /** The atlas's id */
  id: z.string(),
  slot: z.string(),
  /** The layout's size in px */
  size: z.tuple([z.number(), z.number()]),
  padding: z.number(),
  /** Mip levels the layout keeps apart (level 0 included); a slot over its maxSize has fewer */
  levels: z.number(),
  /** Set when the file has every level down to 1 × 1 (`mipChain: "FULL"`): the levels past
   * `levels` mix neighbouring cells */
  mipChain: z.literal('FULL').optional(),
  /** Set when the slot is a ready-made image (`slots.<name>.image`), not composed from its cells */
  fromImage: z.literal(true).optional(),
  cells: z.record(z.string(), TextureAtlasCellInfoSchema),
});

export type TextureAtlasSlotInfo = z.infer<typeof TextureAtlasSlotInfoSchema>;

/** A slot as a texture in the generated data */
export const TextureAtlasSlotTextureSchema = z.object({
  id: z.string(),
  texOpts: TexOptsSchema.omit({ image: true }).optional(),
  throwOnError: z.boolean().optional(),
  userData: UserDataSchema.optional(),
  debugData: DebugDataSchema.optional(),
  __sourcePath: z.string().optional(),
  __atlas: TextureAtlasSlotInfoSchema,
  ...GeneratedAssetFieldsSchema.omit({ __lodChain: true, __sourceUrl: true }).shape,
});

export type TextureAtlasSlotTexture = z.infer<typeof TextureAtlasSlotTextureSchema>;
