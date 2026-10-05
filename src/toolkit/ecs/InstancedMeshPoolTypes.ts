import type { InstancedMeshSlotData } from '../../_engine/core/Instancing/InstancedMeshPoolTypes';

// --- src/toolkit/ecs/InstancedMeshPoolTypes.ts ---
//
// Deprecated: the pool's component is the core `ComponentType.INSTANCED_MESH_SLOT` now
// (`_engine/core/Instancing/`). Kept, with the core key, so an `AppECSRegistry.ts` that still
// spreads it into `AppComponentType` compiles and names the same component. Goes at the
// toolkit's next major version. Types only (no local value imports).

export type { InstancedMeshSlotData };

/** @deprecated Use `ComponentType.INSTANCED_MESH_SLOT`. */
export enum InstancedMeshPoolComponentType {
  INSTANCED_MESH_SLOT = 'CORE_INSTANCED_MESH_SLOT',
}

/** @deprecated The core component data has it. */
export interface InstancedMeshPoolComponentData {
  [InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT]: InstancedMeshSlotData;
}
