import { z } from 'zod';

/** generateLodChain's options (LodChainOptions in core/Lod/LodSimplify.ts, p347 §2.2). */
export const LodChainOptionsSchema = z
  .strictObject({
    ratios: z
      .array(z.number().gt(0).lt(1))
      .optional()
      .describe(
        "Target triangle counts, as ratios of the base's, one per level. Default [0.5, 0.25, 0.1]."
      ),
    maxError: z
      .number()
      .gt(0)
      .max(1)
      .optional()
      .describe(
        "meshoptimizer's target error cap, relative to the mesh's extent (its largest bounding box side). Default 0.05."
      ),
    attributeWeights: z
      .strictObject({
        normal: z.number().min(0).optional(),
        uv: z.number().min(0).optional(),
      })
      .optional()
      .describe(
        'How much normal and uv deviation count against a collapse. Default 0.5 each (0 ignores it).'
      ),
    compactVertices: z
      .boolean()
      .optional()
      .describe(
        "Each level gets its own trimmed vertex arrays instead of sharing the base's. Better for large meshes whose far levels use few vertices. Default false."
      ),
    lockBorder: z
      .boolean()
      .optional()
      .describe(
        "Keeps the mesh's open borders in place, so tiling geometry still meets its neighbours. Default false."
      ),
    permissive: z
      .boolean()
      .optional()
      .describe(
        "Lets collapses cross attribute seams. Flat-shaded geometry (a normal per face) doesn't simplify without it. Default false."
      ),
  })
  .describe('generateLodChain options.');

export const LodChainSchema = z
  .union([z.boolean(), LodChainOptionsSchema])
  .describe(
    "Generate a LOD chain (p347) for every rendered geometry of the import after it loads: true for the default options, or the options. Nothing selects a level until p348's `lod` on a mesh. Skinned and morph-target geometry is skipped."
  );
