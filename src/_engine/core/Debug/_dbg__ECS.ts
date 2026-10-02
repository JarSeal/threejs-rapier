import { Pane } from 'tweakpane';
import {
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
} from '../../debug/DebuggerGUI';
import {
  DEFAULT_ECS_WORLD_ID,
  deleteECSWorld,
  ECSWorld,
  getAllECSWorlds,
  getECSWorld,
  onECSEntityCountChange,
  onECSWorldRegistryChange,
} from '../ECS';
import {
  clearECSStorageLSOverride,
  ECS_LS_KEY,
  getECSStorageLSOverride,
  setECSStorageLSOverride,
} from '../ECS/ECSComponentStorage';
import { lsRemoveItem } from '../../utils/LocalAndSessionStorage';
import { createClearListLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { resetECSStressTest, spawnECSStressTestBatch } from '../../utils/ECSStressTest';
import { CMP } from '../../utils/CMP';
import {
  closeDraggableWindow,
  getDraggableWindowsOfKind,
  getKindWindowId,
  registerDraggableWindowKind,
  toggleDraggableWindow,
} from '../UI/DraggableWindow';
import { isCurrentlyLoading } from '../SceneLoader';

/** The edit windows' kind: one window per world, keyed by its id */
export const EDIT_ECS_WORLD_WIN_ID = 'ecsWorldEditorWindow';
const TAB_ID = 'ecsControls';
let worldRegistryListenerRegistered = false;
const refreshECSTab = () => updateDebuggerTab(TAB_ID);

// Coalesces list refreshes to at most once per animation frame. Entity
// creation/deletion can happen thousands of times in one stress-test batch
// (ECSStressTest.ts) — rebuilding the whole list's HTML on every single one
// would be a real cost, unlike the rare world create/delete case (which
// still refreshes synchronously via updateECSWorldsDebuggerGUI below).
let listRefreshScheduled = false;
const scheduleListRefresh = () => {
  if (listRefreshScheduled) return;
  listRefreshScheduled = true;
  requestAnimationFrame(() => {
    listRefreshScheduled = false;
    refreshECSTab();
  });
};

// Each open edit window's cheap entity-count refresh, by world id — set by
// createEditECSWorldContent, removed when its container is torn down.
// Deliberately NOT routed through updateDraggableWindow (that disposes and
// rebuilds the entire Tweakpane pane), since this can also fire at
// stress-test frequency.
const openWorldEditRefreshes = new Map<string, () => void>();

/** Logic for the Edit ECS World Draggable Window */
export const createEditECSWorldContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string };
  const world = ECSWorld.getWorld(d.id);
  if (!world)
    return CMP({
      style: { padding: '10px' },
      text: 'ECS World no longer exists',
    });

  // The content is built before the window state is open: refresh the list selection after it
  queueMicrotask(refreshECSTab);

  const isDefault = world.id === DEFAULT_ECS_WORLD_ID;
  const container = CMP({
    onRemoveCmp: () => {
      pane.dispose();
      if (openWorldEditRefreshes.get(world.id) === refresh) openWorldEditRefreshes.delete(world.id);
    },
  });
  const pane = new Pane({ container: container.elem });

  // Header info
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Id:</span> ${world.id}</div>
      <div><span class="winSmallLabel">Name:</span> ${world.name}</div>
      ${world.description ? `<div><span class="winSmallLabel">Description:</span> ${world.description}</div>` : ''}
    </div>`,
  });

  const readout = { entities: world.getEntityCount() };
  pane.addBinding(readout, 'entities', {
    label: 'Entity count',
    readonly: true,
    format: (v) => v.toFixed(0),
  });

  // Kept live by the onECSEntityCountChange listener registered in
  // _initECSDebugGUI — a cheap pane.refresh() rather than tearing down and
  // rebuilding this whole window on every entity add/remove.
  const refresh = () => {
    readout.entities = world.getEntityCount();
    pane.refresh();
  };
  openWorldEditRefreshes.set(world.id, refresh);

  // --- Storage (moved here from the tab-level list so it's per world) ---
  const storageFolder = pane.addFolder({
    title: 'Storage (reloads the app)',
    expanded: true,
  });
  const storageConfig = { storageMode: world.storageMode, maxEntities: world.maxEntities };

  storageFolder
    .addBinding(storageConfig, 'storageMode', {
      label: 'Storage mode',
      options: { Map: 'MAP', 'Typed Array': 'TYPED_ARRAY' },
    })
    .on('change', () => {
      setECSStorageLSOverride(world.id, storageConfig);
      location.reload();
    });

  // Both MAP and TYPED_ARRAY now enforce maxEntities as a real cap, so this is always
  // editable — it used to be disabled exactly when TYPED_ARRAY (its one
  // working mode at the time) was selected, which was backwards.
  storageFolder
    .addBinding(storageConfig, 'maxEntities', {
      label: 'Max entities',
      step: 1000,
      min: 1,
    })
    .on('change', () => {
      setECSStorageLSOverride(world.id, storageConfig);
      location.reload();
    });

  storageFolder
    .addButton({
      title: 'Clear local storage',
      disabled: !getECSStorageLSOverride(world.id),
    })
    .on('click', () => {
      clearECSStorageLSOverride(world.id);
      location.reload();
    });

  if (!isDefault) {
    pane.addButton({ title: 'Delete world' }).on('click', () => {
      // Close first so the registry-change notification (fired from inside
      // deleteECSWorld) doesn't try to refresh a window whose world is
      // already gone.
      closeDraggableWindow(getKindWindowId(EDIT_ECS_WORLD_WIN_ID, world.id));
      deleteECSWorld(world.id);
    });
  }

  return container;
};

registerDraggableWindowKind(EDIT_ECS_WORLD_WIN_ID, {
  content: createEditECSWorldContent,
  onClose: refreshECSTab,
  // Kept open on a scene change when the world still exists (secondary worlds are scene-scoped)
  sceneTargetResolver: (data) => Boolean(ECSWorld.getWorld(String(data?.id))),
});

/** The default world's TRANSFORM entity count (and capacity), for the benchmark readout. */
const benchmarkReadout = { entities: '' };
const updateBenchmarkReadout = () => {
  const world = getECSWorld();
  const entityCount = world.getStorage(ComponentType.TRANSFORM).size;
  const capacity = world.getTypedTransformStore()?.capacity;
  benchmarkReadout.entities =
    capacity !== undefined ? `${entityCount} / ${capacity}` : `${entityCount} (Map, uncapped)`;
};
const benchmarkConfig = { batchSize: 1000 };

/** Creates the Tab in the Debug Drawer */
export const _initECSDebugGUI = () => {
  // Registered once (not per tab-open): refreshes the live list (and closes
  // a deleted world's edit window) whenever any world is created or deleted
  // anywhere in the app.
  if (!worldRegistryListenerRegistered) {
    worldRegistryListenerRegistered = true;
    onECSWorldRegistryChange(onWorldRegistryChange);

    // Entity add/remove in any world — keeps list entity counts and the
    // open edit window's count correct. Routed through the rAF-coalesced
    // scheduleListRefresh (not updateECSWorldsDebuggerGUI's synchronous
    // path), since this can fire thousands of times per stress-test batch.
    onECSEntityCountChange((world) => {
      scheduleListRefresh();
      openWorldEditRefreshes.get(world.id)?.();
    });
  }

  createDebuggerTab({
    id: TAB_ID,
    title: 'ECS',
    icon: 'ecs',
    // The whole 'AEK_ecs' key IS the per-world-id list (see ECSComponentStorage.ts) - there is
    // no separate tab-only field, so the tab button stays disabled (kept for consistency)
    clearLSButton: true,
    headerButtons: () => [
      createClearListLSButton({
        hasData: () => lsKeyHasData(ECS_LS_KEY),
        watchKey: ECS_LS_KEY,
        // Keyed by world id, not scene id - no scope ambiguity, so no confirm dialog.
        onClear: () => lsRemoveItem(ECS_LS_KEY),
      }),
    ],
    // The benchmark readout (only while the tab is visible)
    refreshIntervalMs: 1000,
    onRefresh: updateBenchmarkReadout,
    content: () => [
      debuggerListCMP({
        id: 'ecsWorlds',
        emptyText: 'No ECS worlds found.',
        data: getECSWorldsListData,
        selectedItemId: () =>
          getDraggableWindowsOfKind(EDIT_ECS_WORLD_WIN_ID).map((win) => String(win.data?.id)),
        perItemConfig: { onClick: openEditECSWorldWindow },
      }),
      // --- Benchmark ---
      // Always targets the default world — reuses ECSStressTest.ts's spawn logic so Map vs
      // Typed Array can be compared live: pick a mode in a world's edit window (reloads), then
      // spawn a batch here and watch the Stats tab's FPS/frame-time panel.
      {
        pane: true,
        content: [
          {
            type: 'folder',
            id: 'benchmark',
            title: 'Stress Test Benchmark (default world)',
            content: [
              {
                key: 'entities',
                target: benchmarkReadout,
                label: 'TRANSFORM entities',
                readonly: true,
              },
              {
                key: 'batchSize',
                target: benchmarkConfig,
                label: 'Batch size',
                step: 100,
                min: 1,
                max: 20000,
              },
              {
                type: 'button',
                title: 'Spawn individual meshes',
                onClick: () => {
                  spawnECSStressTestBatch(getECSWorld(), benchmarkConfig.batchSize, false);
                  refreshECSTab();
                },
              },
              {
                type: 'button',
                title: 'Spawn instanced meshes',
                onClick: () => {
                  spawnECSStressTestBatch(getECSWorld(), benchmarkConfig.batchSize, true);
                  refreshECSTab();
                },
              },
              {
                type: 'button',
                title: 'Clear stress-test entities',
                onClick: () => {
                  resetECSStressTest(getECSWorld());
                  refreshECSTab();
                },
              },
            ],
          },
        ],
      },
    ],
  });
};

const getECSWorldsListData = (): DebuggerListItem[] =>
  getAllECSWorlds().map((world) => ({
    itemId: world.id,
    title: world.name,
    subTitle: world.id === DEFAULT_ECS_WORLD_ID ? world.id : `[${world.id}]`,
    suffix: `(${world.getEntityCount()} ent.)`,
  }));

/** List row click: opens the world's window, brings it to the front, or closes it when on top. */
const openEditECSWorldWindow = (worldId: string) => {
  const world = ECSWorld.getWorld(worldId);
  if (!world) return;
  toggleDraggableWindow({
    id: getKindWindowId(EDIT_ECS_WORLD_WIN_ID, world.id),
    kind: EDIT_ECS_WORLD_WIN_ID,
    title: `Edit ECS World: ${world.name}`,
    isDebugWindow: true,
    data: { id: world.id },
    closeOnSceneChange: true,
    saveToLS: true,
  });
};

/** A world was created or deleted: refreshes the list and closes the deleted worlds' windows. A
 * scene change leaves the windows to the scene change handling (kept when the next scene has the
 * world). */
const onWorldRegistryChange = () => {
  refreshECSTab();
  if (isCurrentlyLoading()) return;
  const wins = getDraggableWindowsOfKind(EDIT_ECS_WORLD_WIN_ID);
  for (let i = 0; i < wins.length; i++) {
    if (!ECSWorld.getWorld(String(wins[i].data?.id))) closeDraggableWindow(wins[i].id);
  }
};
