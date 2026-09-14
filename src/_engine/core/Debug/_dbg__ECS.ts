import { createNewDebuggerPane, createDebuggerTab } from '../../debug/DebuggerGUI';
import { getSvgIcon } from '../../core/UI/icons/SvgIcon';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { getConfig } from '../Config';
import { ECS_LS_KEY, ECSStorageLSOverride } from '../ECS/ECSComponentStorage';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { resetECSStressTest, spawnECSStressTestBatch } from '../../utils/ECSStressTest';

const shippedEcsConfig = getConfig().ecs;

let ecsStorageConfig: Required<ECSStorageLSOverride> = {
  storageMode: shippedEcsConfig?.storageMode ?? 'MAP',
  maxEntities: shippedEcsConfig?.maxEntities ?? 100_000,
};

export const _initECSDebugGUI = () => {
  ecsStorageConfig = {
    ...ecsStorageConfig,
    ...lsGetItem(ECS_LS_KEY, ecsStorageConfig),
  };

  const icon = getSvgIcon('ecs');
  createDebuggerTab({
    id: 'ecsControls',
    buttonText: icon,
    title: 'ECS',
    orderNr: 15,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('ECS', `${icon} ECS`);

      const storageFolder = debugGUI.addFolder({
        title: 'Component Storage (reloads the app)',
        expanded: true,
      });

      storageFolder
        .addBinding(ecsStorageConfig, 'storageMode', {
          label: 'Storage mode',
          options: { Map: 'MAP', 'Typed Array': 'TYPED_ARRAY' },
        })
        .on('change', () => {
          lsSetItem(ECS_LS_KEY, ecsStorageConfig);
          location.reload();
        });

      const maxEntitiesBinding = storageFolder
        .addBinding(ecsStorageConfig, 'maxEntities', {
          label: 'Max entities (TYPED_ARRAY only)',
          step: 1000,
          min: 1,
        })
        .on('change', () => {
          lsSetItem(ECS_LS_KEY, ecsStorageConfig);
          location.reload();
        });
      maxEntitiesBinding.disabled = ecsStorageConfig.storageMode === 'TYPED_ARRAY';

      // --- Benchmark (Phase 3, docs/plans/ecs-typed-arrays-feature.md) ---
      // Reuses ECSStressTest.ts's spawn logic so Map vs Typed Array can be
      // compared live: pick a mode above (reloads), then spawn a batch here
      // and watch the Stats tab's FPS/frame-time panel.
      const benchmarkFolder = debugGUI.addFolder({
        title: 'Stress Test Benchmark',
        expanded: true,
      });

      const readout = { entities: '' };
      const updateReadout = () => {
        const world = getECSWorld();
        const entityCount = world.getStorage(ComponentType.TRANSFORM).size;
        const capacity = world.getTypedTransformStore()?.capacity;
        readout.entities =
          capacity !== undefined
            ? `${entityCount} / ${capacity}`
            : `${entityCount} (Map, uncapped)`;
      };
      updateReadout();

      benchmarkFolder.addBinding(readout, 'entities', {
        label: 'TRANSFORM entities',
        readonly: true,
      });
      setInterval(() => {
        updateReadout();
        debugGUI.refresh();
      }, 1000);

      const benchmarkConfig = { batchSize: 1000 };
      benchmarkFolder.addBinding(benchmarkConfig, 'batchSize', {
        label: 'Batch size',
        step: 100,
        min: 1,
        max: 20000,
      });

      benchmarkFolder.addButton({ title: 'Spawn individual meshes' }).on('click', () => {
        spawnECSStressTestBatch(getECSWorld(), benchmarkConfig.batchSize, false);
        updateReadout();
        debugGUI.refresh();
      });
      benchmarkFolder.addButton({ title: 'Spawn instanced meshes' }).on('click', () => {
        spawnECSStressTestBatch(getECSWorld(), benchmarkConfig.batchSize, true);
        updateReadout();
        debugGUI.refresh();
      });
      benchmarkFolder.addButton({ title: 'Clear stress-test entities' }).on('click', () => {
        resetECSStressTest(getECSWorld());
        updateReadout();
        debugGUI.refresh();
      });

      return container;
    },
  });
};
