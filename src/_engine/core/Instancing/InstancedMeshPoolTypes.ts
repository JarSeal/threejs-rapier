import type * as THREE from 'three/webgpu';

// --- src/_engine/core/Instancing/InstancedMeshPoolTypes.ts ---
//
// InstancedMeshPool.ts's component data, apart from it so `ECSCoreComponents.ts` can import it
// without pulling the pool in. Types only.

/** The `INSTANCED_MESH_SLOT` component's data: where a pool instance is drawn. */
export interface InstancedMeshSlotData {
  /** The mesh the instance is in (an instanced LOD pool: its applied level's mesh). */
  mesh: THREE.InstancedMesh;
  /** Its slot in `mesh`, -1 while it's in no mesh (LOD culled). Changes when another instance is
   * removed from the mesh: read it from the component, never keep it. */
  index: number;
  /** Last `Transform.version` baked into `mesh`'s instance matrix — skips the write once a
   * (typically static, e.g. foliage) instance's transform stops changing. */
  _lastVersion: number;
}

/** Where `spawn()` puts an instance. The toolkit's `ScatterPlacement` is one. */
export interface InstancePlacement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}
