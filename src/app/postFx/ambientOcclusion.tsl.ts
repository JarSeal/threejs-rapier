import type { PostFxPassFn } from '../../_engine/core/PostFX/PostFXTypes';

// @TODO: Phase 1 stub (docs/plans/p070_post-fx-system.md), a pure pass-through. Phase 4 replaces it with the GTAONode pass.
export const fxNode: PostFxPassFn = (_params, ctx) => ctx.colorNode;
