import { z } from 'zod';
import type { LodAutoDef, LodDef, MeshLodDef } from '../core/Lod/LodTypes';

/** One level of a mesh's `lod` (LodLevelDef in core/Lod/LodTypes.ts, p348 §2.2). */
export const LodLevelDefSchema = z
  .strictObject({
    screenSize: z
      .number()
      .min(0)
      .describe(
        'Smallest screen size (bounding-sphere diameter / viewport height) this level is used at. Coarser levels need smaller values. Moving to a coarser level waits for `hysteresis` below it.'
      ),
    geo: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Registered geometry id (the scene must load it). Omitted = the previous level's (level 0: the mesh's own)."
      ),
    mat: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Registered material id (the scene must load it). Omitted = the previous level's (level 0: the mesh's own)."
      ),
    castShadow: z
      .boolean()
      .optional()
      .describe("Omitted = the previous level's (level 0: the mesh's own)."),
  })
  .describe('A level of detail.');

/** A mesh's `lod` (LodDef in core/Lod/LodTypes.ts, p348 §2.2). The type is hand-written there (the
 * documented API); `satisfies` keeps this schema's output assignable to it. */
export const LodDefSchema = z
  .strictObject({
    levels: z
      .array(LodLevelDefSchema)
      .min(1)
      .superRefine((levels, ctx) => {
        for (let i = 1; i < levels.length; i++) {
          if (levels[i].screenSize < levels[i - 1].screenSize) continue;
          ctx.addIssue({
            code: 'custom',
            path: [i, 'screenSize'],
            message: `Level ${i}'s screenSize (${levels[i].screenSize}) must be below level ${i - 1}'s (${levels[i - 1].screenSize}): levels go from level 0 down, screenSize descending.`,
          });
        }
      })
      .describe('Level 0 (the finest) first, screenSize descending.'),
    cullScreenSize: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Below this screen size the mesh is hidden (with hysteresis, like the levels). 0 = never hidden. Default 0.'
      ),
    hysteresis: z
      .number()
      .min(0)
      .lt(1)
      .optional()
      .describe(
        'Moving to a coarser level (or hiding) waits until the screen size is this fraction below the threshold, so a mesh on a boundary does not flip every frame. Default 0.1.'
      ),
    bias: z
      .number()
      .gt(0)
      .optional()
      .describe(
        'Multiplies the screen size: >1 keeps detail longer. Default 1. The global bias (AppConfig.lod.bias, setLodBias) applies on top.'
      ),
    fadeSeconds: z
      .number()
      .min(0)
      .optional()
      .describe(
        'How long a level change (or hiding and showing) cross-fades with a dither, in seconds; 0 switches at once and leaves the level materials undithered. Default AppConfig.lod.fadeSeconds (0.25, setLodFadeSeconds).'
      ),
  })
  .describe(
    'Levels of detail (p348): each frame the mesh shows the level its screen size reaches, swapping its geometry, material and castShadow, cross-faded over fadeSeconds.'
  ) satisfies z.ZodType<LodDef>;

/** A mesh's `lod: { auto: true, ... }` (LodAutoDef in core/Lod/LodTypes.ts, p348 §5). */
export const LodAutoDefSchema = z
  .strictObject({
    auto: z.literal(true),
    maxPixelError: z
      .number()
      .gt(0)
      .optional()
      .describe(
        'The largest simplification error, in pixels at a viewport height of 1080, a level may show. Smaller keeps detail longer. Default 1.'
      ),
    cullScreenSize: LodDefSchema.shape.cullScreenSize,
    hysteresis: LodDefSchema.shape.hysteresis,
    bias: LodDefSchema.shape.bias,
    fadeSeconds: LodDefSchema.shape.fadeSeconds,
  })
  .describe(
    "Levels of detail (p348) from the geometry's LOD chain (p347: `lodChain` in its *.importedAsset.json): each level is used while its simplification error stays within maxPixelError pixels. Without a chain the mesh stays on level 0 (warned)."
  ) satisfies z.ZodType<LodAutoDef>;

/** A mesh's `lod`: its levels, or `AUTO` for its geometry's LOD chain (MeshLodDef). */
export const MeshLodDefSchema = z.union([
  LodDefSchema,
  LodAutoDefSchema,
  z
    .literal('AUTO')
    .describe(
      "Levels of detail (p348) from the geometry's LOD chain, with the defaults: `{ auto: true }`."
    ),
]) satisfies z.ZodType<MeshLodDef>;
