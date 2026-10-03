import type * as THREE from 'three/webgpu';

// --- src/toolkit/ecs/InstancedMeshPoolTypes.ts ---
//
// InstancedMeshPool.ts's component keys and data, apart from it so `AppECSRegistry.ts` can
// import them without pulling the pool itself into the ECSCoreComponents ↔ AppECSRegistry import
// cycle. No local imports here (types only).

/** Internal Key (Values) */
export enum InstancedMeshPoolComponentType {
  INSTANCED_MESH_SLOT = 'TOOLKIT_INSTANCED_MESH_SLOT',
}

/** Internal Data Shape (Types) */
export interface InstancedMeshSlotData {
  mesh: THREE.InstancedMesh;
  index: number;
  /** Last `Transform.version` baked into `mesh`'s instance matrix — skips the write once a
   * (typically static, e.g. foliage) instance's transform stops changing. */
  _lastVersion: number;
}

export interface InstancedMeshPoolComponentData {
  [InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT]: InstancedMeshSlotData;
}
