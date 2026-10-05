import type { ECSWorld } from '../../_engine/core/ECS';

// --- src/toolkit/ecs/InstancedMeshPool.ts ---
//
// Deprecated: the pool is an engine system now (`_engine/core/Instancing/InstancedMeshPool.ts`,
// docs/plans/_DONE_p348_ecs-lod-selection.md Phase 3). This re-export keeps old imports working until
// the toolkit's next major version.

/** @deprecated Import from `_engine/core/Instancing/InstancedMeshPool` instead. */
export * from '../../_engine/core/Instancing/InstancedMeshPool';
/** @deprecated The pool's component is the core `ComponentType.INSTANCED_MESH_SLOT` now. */
export * from './InstancedMeshPoolTypes';

/** @deprecated Does nothing: the engine registers the pool's sync system itself. */
export const registerInstancedMeshPoolEffect = (world: ECSWorld) => world;
