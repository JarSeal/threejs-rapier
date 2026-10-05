import { z } from 'zod';
import type { LodDef } from '../core/Lod/LodTypes';

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
  })
  .describe(
    'Levels of detail (p348): each frame the mesh shows the level its screen size reaches, swapping its geometry, material and castShadow.'
  ) satisfies z.ZodType<LodDef>;
