import { Pane } from 'tweakpane';
import { createNewDebuggerContainer, createDebuggerTab } from '../../debug/DebuggerGUI';
import { getSvgIcon } from '../../core/UI/icons/SvgIcon';
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
import {
  createClearListLSButton,
  createClearTabLSButton,
  lsKeyHasData,
} from './_dbg__ClearLSButtons';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { resetECSStressTest, spawnECSStressTestBatch } from '../../utils/ECSStressTest';
import { CMP, getCmpById, type TCMP } from '../../utils/CMP';
import {
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowContentFn,
  updateDraggableWindow,
} from '../UI/DraggableWindow';

export const EDIT_ECS_WORLD_WIN_ID = 'ecsWorldEditorWindow';
const DEBUGGER_ECS_WORLDS_LIST_ID = 'debuggerECSWorldsList';
let debuggerListCmp: TCMP | null = null;
let worldRegistryListenerRegistered = false;

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
    debuggerListCmp?.update();
  });
};

// The currently-open edit window's cheap entity-count refresh — set by
// createEditECSWorldContent, cleared when its container is torn down.
// Deliberately NOT routed through updateDraggableWindow (that disposes and
// rebuilds the entire Tweakpane pane), since this can also fire at
// stress-test frequency.
let openWorldEditRefresh: { worldId: string; refresh: () => void } | null = null;

/** Logic for the Edit ECS World Draggable Window */
export const createEditECSWorldContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string };
  const world = ECSWorld.getWorld(d.id);
  openWorldEditRefresh = null;
  if (!world)
    return CMP({
      style: { padding: '10px' },
      text: 'ECS World no longer exists',
    });

  const isDefault = world.id === DEFAULT_ECS_WORLD_ID;
  const container = CMP({
    onRemoveCmp: () => {
      pane.dispose();
      if (openWorldEditRefresh?.worldId === world.id) openWorldEditRefresh = null;
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
  openWorldEditRefresh = {
    worldId: world.id,
    refresh: () => {
      readout.entities = world.getEntityCount();
      pane.refresh();
    },
  };

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

  // Both MAP and TYPED_ARRAY now enforce maxEntities as a real cap
  // (docs/plans/_DONE-ecs-multiple-worlds.md §5.3), so this is always
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
      closeDraggableWindow(EDIT_ECS_WORLD_WIN_ID);
      deleteECSWorld(world.id);
    });
  }

  return container;
};

registerDraggableWindowContentFn(EDIT_ECS_WORLD_WIN_ID, createEditECSWorldContent);

/** Creates the Tab in the Debug Drawer */
export const _initECSDebugGUI = () => {
  const icon = getSvgIcon('ecs');

  // Registered once (not per tab-open): refreshes the live list (and the
  // edit window, if open) whenever any world is created or deleted anywhere
  // in the app — mirrors LightManager's TAG_IS_LIGHT onAddComponent hook
  // triggering updateLightsDebuggerGUI().
  if (!worldRegistryListenerRegistered) {
    worldRegistryListenerRegistered = true;
    onECSWorldRegistryChange(() => updateECSWorldsDebuggerGUI());

    // Entity add/remove in any world — keeps list entity counts and the
    // open edit window's count correct. Routed through the rAF-coalesced
    // scheduleListRefresh (not updateECSWorldsDebuggerGUI's synchronous
    // path), since this can fire thousands of times per stress-test batch.
    onECSEntityCountChange((world) => {
      scheduleListRefresh();
      if (openWorldEditRefresh?.worldId === world.id) openWorldEditRefresh.refresh();
    });
  }

  createDebuggerTab({
    id: 'ecsControls',
    buttonText: icon,
    title: 'ECS',
    orderNr: 15,
    container: () => {
      let pane: Pane | undefined = undefined;
      const clearTabBtn = createClearTabLSButton({
        // The whole 'AEK_ecs' key IS the per-world-id list (see ECSComponentStorage.ts) -
        // there is no separate tab-only field for this button to clear.
        hasData: () => false,
        onClear: () => {},
      });
      const clearListBtn = createClearListLSButton({
        hasData: () => lsKeyHasData(ECS_LS_KEY),
        // Keyed by world id, not scene id - no scope ambiguity, so no confirm dialog.
        onClear: () => lsRemoveItem(ECS_LS_KEY),
      });
      const container = createNewDebuggerContainer('ecs', `${icon} ECS`, [
        clearTabBtn,
        clearListBtn,
      ]);
      container.update({ onRemoveCmp: () => pane?.dispose() });

      debuggerListCmp = CMP({
        id: DEBUGGER_ECS_WORLDS_LIST_ID,
        html: () => createECSWorldsDebuggerList(),
        style: { marginBottom: '16px' },
      });
      container.add(debuggerListCmp);

      const winState = getDraggableWindow(EDIT_ECS_WORLD_WIN_ID);
      if (winState?.isOpen && winState.data?.id) {
        updateECSWorldsDebuggerListSelectedClass((winState.data as { id: string }).id);
      }

      // --- Benchmark (Phase 3, docs/plans/ecs-typed-arrays-feature.md) ---
      // Always targets the default world — reuses ECSStressTest.ts's spawn
      // logic so Map vs Typed Array can be compared live: pick a mode in a
      // world's edit window (reloads), then spawn a batch here and watch
      // the Stats tab's FPS/frame-time panel.
      pane = new Pane({ container: container.elem });

      const benchmarkFolder = pane.addFolder({
        title: 'Stress Test Benchmark (default world)',
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
        pane.refresh();
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
        pane.refresh();
      });
      benchmarkFolder.addButton({ title: 'Spawn instanced meshes' }).on('click', () => {
        spawnECSStressTestBatch(getECSWorld(), benchmarkConfig.batchSize, true);
        updateReadout();
        pane.refresh();
      });
      benchmarkFolder.addButton({ title: 'Clear stress-test entities' }).on('click', () => {
        resetECSStressTest(getECSWorld());
        updateReadout();
        pane.refresh();
      });

      return container;
    },
  });
};

const createECSWorldsDebuggerList = () => {
  const worlds = getAllECSWorlds();
  let html = '<ul class="ulList">';

  for (const world of worlds) {
    const isDefault = world.id === DEFAULT_ECS_WORLD_ID;

    const button = CMP({
      onClick: () => {
        openDraggableWindow({
          id: EDIT_ECS_WORLD_WIN_ID,
          title: `Edit ECS World: ${world.name}`,
          isDebugWindow: true,
          content: createEditECSWorldContent,
          data: { id: world.id },
          closeOnSceneChange: true,
          saveToLS: true,
          onClose: () => updateECSWorldsDebuggerListSelectedClass(null),
        });
        updateECSWorldsDebuggerListSelectedClass(world.id);
      },
      html: `<button class="listItemWithId">
        <span class="itemId">${isDefault ? world.id : `[${world.id}]`}</span>
        <h4>${world.name}</h4>
        <span>(${world.getEntityCount()} ent.)</span>
      </button>`,
    });

    html += `<li data-id="${world.id}">${button}</li>`;
  }

  if (worlds.length === 0) html += `<li class="emptyState">No ECS worlds found.</li>`;
  html += '</ul>';
  return html;
};

export const updateECSWorldsDebuggerListSelectedClass = (id: string | null) => {
  const listElem = getCmpById(DEBUGGER_ECS_WORLDS_LIST_ID)?.elem;
  if (!listElem) return;
  for (const child of listElem.children) {
    child.classList.remove('selected');
    if (id === null) continue;
    if (child.getAttribute('data-id') === id) {
      child.classList.add('selected');
    }
  }
};

export const updateECSWorldsDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (only !== 'WINDOW') debuggerListCmp?.update();
  const winState = getDraggableWindow(EDIT_ECS_WORLD_WIN_ID);
  const worldId = winState?.data?.id as string;
  if (worldId) updateECSWorldsDebuggerListSelectedClass(worldId);
  if (only === 'LIST') return;
  if (winState?.isOpen) updateDraggableWindow(EDIT_ECS_WORLD_WIN_ID);
};
