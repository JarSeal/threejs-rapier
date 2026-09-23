import { createKeyInputControl } from '../core/InputControls';
import { getLogger } from './Logger';
import { createPhysicsEntity } from '../core/PhysicsManager';
import { createGeometry } from '../core/Geometry';
import { createMaterial } from '../core/Material';
import { createMeshEntity } from '../core/MeshManager';
import { IS_DEBUG_ENV } from '../core/Config';

let stressTestCount = 0;

export const initPhysicsStressTest = (batchSize: number = 50) => {
  if (!IS_DEBUG_ENV) return;

  // 1. Pre-create assets to minimize GC during the test
  const geoBox = createGeometry({
    id: 'stress-box-geo',
    type: 'BOX',
    params: { width: 0.5, height: 0.5, depth: 0.5 },
  });
  const geoSphere = createGeometry({
    id: 'stress-sphere-geo',
    type: 'SPHERE',
    params: { radius: 0.3 },
  });

  const mat = createMaterial({
    id: 'stress-mat',
    type: 'PHONG',
    params: { color: '#ff4400' },
  });

  // 2. The Spawner Function
  const spawnBatch = () => {
    for (let i = 0; i < batchSize; i++) {
      stressTestCount++;
      const isBox = Math.random() > 0.5;

      // Random position above the map
      const x = (Math.random() - 0.5) * 20;
      const y = 10 + Math.random() * 20; // Height 10 to 30
      const z = (Math.random() - 0.5) * 20;

      const appId = `stress-mesh-${stressTestCount}`;

      const entityId = createMeshEntity(
        {
          geo: isBox ? geoBox : geoSphere,
          mat: mat,
          castShadow: true,
          receiveShadow: true,
          position: { x, y, z },
        },
        { appId }
      );

      // Fire-and-forget: createPhysicsEntity is async (WORKER_THREAD round-trips to the
      // physics worker), and this spawns up to `batchSize` per keypress — awaiting each one
      // in sequence would serialize the whole batch instead of letting them settle in
      // parallel, same as the legacy synchronous spawner effectively did.
      void createPhysicsEntity(
        {
          // hx/hy/hz explicit at 0.5 each: this matches the legacy PhysicsRapier system's
          // actual behavior, not the box geometry's own half-extents (0.25) — the old
          // colliderParams here set `halfHeight`, a CAPSULE/CONE/CYLINDER-only field the BOX
          // case ignored, so it silently fell back to hx/hy/hz's own 0.5 default. Preserving
          // that exact (oversized) collider size rather than "fixing" it to match the mesh,
          // since this is a perf stress test, not a visual-accuracy one.
          type: isBox ? 'BOX' : 'BALL',
          radius: 0.3, // For ball
          ...(isBox ? { hx: 0.5, hy: 0.5, hz: 0.5 } : {}),
          friction: 0.5,
          restitution: 0.5, // Bounciness makes them settle slower (more CPU usage)
          density: 1.0,
        },
        {
          rigidType: 'DYNAMIC',
          translation: { x, y, z },
          // Random rotation to make collisions complex
          rotation: {
            x: Math.random(),
            y: Math.random(),
            z: Math.random(),
            w: 1,
          },
        },
        entityId
      );
    }

    getLogger().log(`Stress Test: Spawned ${batchSize} objects. Total: ${stressTestCount}`);
  };

  // 3. Bind to Key 'J' (for "Junk")
  createKeyInputControl({
    id: 'spawn_stress_objects',
    key: 'j',
    type: 'KEY_DOWN',
    fn: () => spawnBatch(),
  });

  getLogger().log(`Physics Stress Test Initialized. Press 'J' to spawn ${batchSize} objects.`);
};
