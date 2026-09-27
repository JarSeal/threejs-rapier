import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { DebugDataSchema, UserDataSchema } from './_helperSchemas';

/** Raw JSON values handed to the pass's `fxNode` function as-is (not TSL uniform nodes), see docs/plans/_DONE_p070_post-fx-system.md, Design decision 2. */
const PostFxParamsSchema = z.record(z.string(), z.unknown());

const PostFxOverridesSchema = z.object({
  __meta: MetaSchema.optional(),
  /** Whether the pass is part of the chain. Default true. */
  enabled: z.boolean().optional(),
  params: PostFxParamsSchema.optional(),
  staticDefines: z.record(z.string(), z.unknown()).optional(),
  debugData: DebugDataSchema.optional(),
  userData: UserDataSchema.optional(),
});

export type PostFxOverrides = z.infer<typeof PostFxOverridesSchema>;

export const PostFxAssetSchema = z.object({
  id: z.string({ error: "PostFX pass 'id' key is required." }),
  /** Path to the pass's TS file (exporting `fxNode`), relative to the first folder under `src/` (eg. "postFx/ambientOcclusion.tsl.ts"). */
  tslFile: z.string({ error: "PostFX pass 'tslFile' key is required." }),
  /** Whether the pass is part of the chain. Default true. */
  enabled: z.boolean().optional(),
  /** Flat pass params, passed to `fxNode` as raw JSON values. */
  params: PostFxParamsSchema.optional(),
  /** Passed to `fxNode` as its third argument. */
  staticDefines: z.record(z.string(), z.unknown()).optional(),
  debugData: DebugDataSchema.optional(),
  userData: UserDataSchema.optional(),

  // Meta
  $schema: z.string().optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(PostFxOverridesSchema),
});

export type PostFxAsset = z.infer<typeof PostFxAssetSchema>;
