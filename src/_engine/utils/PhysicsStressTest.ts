import * as THREE from 'three';
import { createKeyInputControl } from '../core/InputControls';
import { getLogger } from './Logger';
import { createPhysicsObjectWithMesh } from '../core/PhysicsRapier';
import { createGeometry } from '../core/Geometry';
import { createMaterial } from '../core/Material';
import { createMesh } from '../core/Mesh';

let stressTestCount = 0;

export const initPhysicsStressTest = (scene: THREE.Scene | THREE.Group, batchSize: number = 50) => {
  // 1. Pre-create assets to minimize GC during the test
  // We want to test Physics CPU load, not Three.js Geometry creation load.
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

      const mesh = createMesh({
        id: `stress-mesh-${stressTestCount}`,
        geo: isBox ? geoBox : geoSphere,
        mat: mat,
        castShadow: true,
        receiveShadow: true,
      });

      // Position mesh initially
      mesh.position.set(x, y, z);
      scene.add(mesh);

      createPhysicsObjectWithMesh({
        id: `stress-phys-${stressTestCount}`,
        meshOrMeshId: mesh,
        physicsParams: {
          rigidBody: {
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
          collider: {
            type: isBox ? 'BOX' : 'BALL',
            radius: 0.3, // For ball
            ...(isBox ? { halfHeight: 0.25 } : {}), // For box (approx)
            friction: 0.5,
            restitution: 0.5, // Bounciness makes them settle slower (more CPU usage)
            density: 1.0,
          },
        },
      });
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
