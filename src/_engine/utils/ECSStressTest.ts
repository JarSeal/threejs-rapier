import * as THREE from 'three/webgpu';

import { createKeyInputControl } from '../core/InputControls';
import { getLogger } from './Logger';
import { createMeshEntity } from '../core/_MeshManager'; // Assuming this is the path
import { ECSSystemStage, ECSWorld, getECSWorld } from '../core/ECS';
import { ComponentType } from '../core/ECS/ECSCoreEntities';
import { isDebugEnvironment } from '../core/Config';
import { getRootScene } from '../core/Scene';

let instancedMesh: THREE.InstancedMesh | null = null;
const MAX_INSTANCES = 50000; // High ceiling for the stress test
let totalCount = 0;

export const initECSStressTest = (batchSize: number = 100) => {
  if (!isDebugEnvironment()) return;

  const world = getECSWorld();
  const scene = getRootScene()!;

  // Shared asset definitions
  const geoProps = {
    type: 'SPHERE' as const,
    params: { radius: 0.2, widthSegments: 8, heightSegments: 8 },
  };
  const matProps = { type: 'BASIC' as const, params: { color: 0x00ff88 } };

  const spawnBatch = (isInstanced: boolean) => {
    // 1. Setup the Instancing Container if needed
    if (isInstanced && !instancedMesh) {
      const geo = new THREE.SphereGeometry(0.2, 8, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
      instancedMesh = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES);
      scene.add(instancedMesh);

      // Inject the specialized sync system for instancing
      world.addSystem(ECSSystemStage.APP_RENDER_SYNC, 'instancedSync', instancedSyncSystem);
      getLogger().log('ECS Stress: InstancedMesh Container Initialized.');
    }

    for (let i = 0; i < batchSize; i++) {
      totalCount++;
      const x = (Math.random() - 0.5) * 50;
      const y = Math.random() * 5;
      const z = (Math.random() - 0.5) * 50;

      let entityId: number;

      if (isInstanced) {
        // --- MODE A: LIGHT ENTITY (INSTANCED) ---
        entityId = world.createEntity(); // Just a raw ID
        world.addComponent(entityId, ComponentType.INSTANCED_STRESS_TEST_DATA, {
          mesh: instancedMesh!,
          index: totalCount % MAX_INSTANCES, // Simple index allocation
        });
      } else {
        // --- MODE B: HEAVY ENTITY (UNIQUE MESH) ---
        entityId = createMeshEntity({ geo: geoProps, mat: matProps });
      }

      // Both modes use the same Hover and Transform logic!
      world.setTransform(entityId, { pos: { x, y, z } });
      world.addComponent(entityId, ComponentType.HOVER, {
        speed: 1.0 + Math.random() * 2.0,
        amplitude: 0.5,
        baseY: y,
        time: Math.random() * 10,
      });
    }

    const mode = isInstanced ? 'INSTANCED' : 'INDIVIDUAL';
    getLogger().log(`ECS Stress: Spawned ${batchSize} ${mode} entities. Total: ${totalCount}`);
  };

  // Bind 'K' for Individual Meshes (Draw Call stress)
  createKeyInputControl({
    id: 'spawn_individual',
    key: 'k',
    type: 'KEY_DOWN',
    fn: () => spawnBatch(false),
  });

  // Bind 'L' for Instanced Meshes (Pure ECS stress)
  createKeyInputControl({
    id: 'spawn_instanced',
    key: 'l',
    type: 'KEY_DOWN',
    fn: () => spawnBatch(true),
  });

  getLogger().log(
    `ECS Stress Test Initialized. Press 'K' (individual meshes) or 'L' (instanced meshes) to spawn ${batchSize} hovering spheres.`
  );
};

const _tempMatrix = new THREE.Matrix4();

export const instancedSyncSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.INSTANCED_STRESS_TEST_DATA);
  if (storage.size === 0) return;

  let needsUpdate = false;
  let masterMesh: THREE.InstancedMesh | null = null;

  for (const [entityId, data] of storage) {
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) continue;

    // Only update if the ECS Transform version has changed
    // (Optimization: the hover system calls setDirty() every frame anyway)
    _tempMatrix.compose(transform.position, transform.quaternion, transform.scale);
    data.mesh.setMatrixAt(data.index, _tempMatrix);

    masterMesh = data.mesh;
    needsUpdate = true;
  }

  if (needsUpdate && masterMesh) {
    masterMesh.instanceMatrix.needsUpdate = true;
  }
};
