import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { llog } from '../../utils/Logger';
import { CMP, type TCMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowCmp,
} from '../UI/DraggableWindow';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { type ListBladeApi } from 'tweakpane';
import type { BladeController, View } from '@tweakpane/core';
import {
  getPhysicsState,
  getPhysicsWorld,
  getResolvedTransportMode,
  isPhysicsWorldEnabled,
} from '../PhysicsAPI';
import { setBootOverride } from './_dbg__PhysicsBootOverrides';
import {
  ShapeType,
  type PhysicsInterpolationMode,
  type PhysicsState,
  type PhysicsWorkerTarget,
} from '../Physics/PhysicsAPITypes';
import {
  getEntityWireframeColor,
  getGlobalWireframeColorOverrides,
  getWireframeColorDefault,
  getWireframeColors,
  getWireframeLineThickness,
  getWireframeLineThicknessDefault,
  isWireframePersistable,
  isWireframeVisible,
  PHYSICS_WIREFRAME_ENTITY_LS_KEY,
  resetEntityWireframeColors,
  setEntityWireframeColor,
  setGlobalWireframeColor,
  setGlobalWireframeColors,
  setGlobalWireframeLineThickness,
  getWireframePoseSource,
  setWireframePoseSource,
  DEFAULT_WIREFRAME_POSE_SOURCE,
  type WireframePoseSource,
  setWireframeVisible,
  WIREFRAME_COLOR_STATES,
  type WireframeColorState,
} from './_dbg__PhysicsDebugDraw';
import { getECSWorld } from '../ECS';
import { getPhysicsInterpolationReadout } from '../PhysicsManager';
import { ComponentType } from '../ECS/ECSCoreComponents';

const LS_KEY = 'AEK_debugPhysicsApi';
/** Wireframe colors/thickness get their own key so "Clear tab LS" on the main physics
 * settings doesn't silently wipe the user's palette, and vice versa. */
const WIREFRAME_LS_KEY = 'AEK_debugPhysicsApiWireframe';
/** Pure UI state (which folders are open), kept apart from the settings keys so
 * "Reset all wireframe settings" doesn't also collapse the folder you're working in —
 * the same split _dbg__SkyBox.ts makes with its own AEK_debugSkyBoxUI key. */
const UI_LS_KEY = 'AEK_debugPhysicsApiUI';

let physicsApiUIState = {
  wireframeFolderExpanded: false,
  entityWireframeFolderExpanded: false,
};

const persistUIState = () => lsSetItem(UI_LS_KEY, physicsApiUIState);
const EDIT_PHYS_ENTITY_WIN_ID = 'physicsApiEntityEditorWindow';
const PHYSICS_ENTITY_COMPONENT_TYPES = [
  ComponentType.BODY_STATIC,
  ComponentType.BODY_DYNAMIC_VISUAL,
  ComponentType.BODY_DYNAMIC_HEADLESS,
] as const;

let debuggerEntityListCmp: TCMP | null = null;
let lastEntityListSignature = '';
let entityWindowCmp: TCMP | null = null;
let entityWindowPane: Pane | null = null;

type PersistedWireframeState = {
  colors?: Partial<Record<WireframeColorState, number>>;
  lineThickness?: number;
  poseSource?: WireframePoseSource;
};

/** The "Wireframe pose" dropdown, when the tab is open — so the wireframe folder's reset can
 * move it back to the default. */
let wireframePoseDropDown: ListBladeApi<WireframePoseSource> | null = null;

/** Human-readable labels for the color pickers, phrased as the condition each one paints. */
const WIREFRAME_STATE_LABELS: Record<WireframeColorState, string> = {
  disabled: 'Disabled (collider or its body)',
  sensor: 'Sensor',
  sleeping: 'Sleeping',
  kinematic: 'Kinematic',
  fixed: 'Fixed / static',
  awake: 'Awake / active',
};

/** Pushes any persisted palette into the draw module. Runs at boot rather than when the
 * tab is first opened, so wireframes come up in the user's colors even if they never
 * click into this tab. */
const restoreWireframeState = () => {
  const saved = lsGetItem(WIREFRAME_LS_KEY, {}) as PersistedWireframeState;
  if (saved.colors) setGlobalWireframeColors(saved.colors);
  if (typeof saved.lineThickness === 'number') {
    setGlobalWireframeLineThickness(saved.lineThickness);
  }
  if (saved.poseSource === 'PHYSICS' || saved.poseSource === 'RENDERED') {
    setWireframePoseSource(saved.poseSource);
  }
};

/** Persists only what the user actually overrode — an untouched state stays absent, so it
 * keeps tracking the CONFIG.ts default if that changes later. */
const persistWireframeState = () => {
  const colors = getGlobalWireframeColorOverrides();
  const lineThickness = getWireframeLineThickness();
  const isDefaultThickness = lineThickness === getWireframeLineThicknessDefault();
  const payload: PersistedWireframeState = {};
  if (Object.keys(colors).length) payload.colors = colors;
  if (!isDefaultThickness) payload.lineThickness = lineThickness;
  const poseSource = getWireframePoseSource();
  if (poseSource !== DEFAULT_WIREFRAME_POSE_SOURCE) payload.poseSource = poseSource;
  if (!Object.keys(payload).length) {
    lsRemoveItem(WIREFRAME_LS_KEY);
    return;
  }
  lsSetItem(WIREFRAME_LS_KEY, payload);
};

// Only these fields persist under LS_KEY. workerTarget/useSAB/maxBodies/stepStatsEnabled
// live under their own boot-override key (DEBUG_PHYSICS_API_BOOT_LS_KEY, see
// setBootOverride) and applying via config on the next reload — persisting the whole
// PhysicsState blob here would let a stale in-memory copy of those four fields clobber the
// boot-override-derived values the moment any live field changes.
type LivePhysicsApiState = Pick<
  PhysicsState,
  | 'timestep'
  | 'worldStepEnabled'
  | 'gravity'
  | 'solverIterations'
  | 'internalPgsIterations'
  | 'backgroundBehavior'
  | 'minDeltaTime'
  | 'maxDeltaTime'
  | 'maxSubSteps'
  | 'interpolationMode'
>;

const getLiveState = (state: PhysicsState): LivePhysicsApiState => ({
  timestep: state.timestep,
  worldStepEnabled: state.worldStepEnabled,
  gravity: state.gravity,
  solverIterations: state.solverIterations,
  internalPgsIterations: state.internalPgsIterations,
  backgroundBehavior: state.backgroundBehavior,
  minDeltaTime: state.minDeltaTime,
  maxDeltaTime: state.maxDeltaTime,
  maxSubSteps: state.maxSubSteps,
  interpolationMode: state.interpolationMode,
});

const persistLiveState = (state: PhysicsState) => lsSetItem(LS_KEY, getLiveState(state));

/** gravity/solverIterations/internalPgsIterations/timestep are baked into the Rapier
 * world once at createPhysicsWorld() time, which runs before this debug tab's LS
 * restore — so a restored custom value has to be re-pushed into the already-running
 * world explicitly, the same way each field's own live on('change') handler does. */
const applyLiveStateToWorld = (state: PhysicsState) => {
  if (!isPhysicsWorldEnabled()) return;
  const world = getPhysicsWorld();
  world.setGravity(state.gravity);
  world.setNumSolverIterations(state.solverIterations);
  world.setNumInternalPgsIterations(state.internalPgsIterations);
  world.setTimestep(state.timestepRatio);
};

const getAllPhysicsEntityIds = (): number[] => {
  const world = getECSWorld();
  const ids = new Set<number>();
  for (const type of PHYSICS_ENTITY_COMPONENT_TYPES) {
    for (const [entityId] of world.getStorage(type)) {
      ids.add(entityId);
    }
  }
  return [...ids];
};

const getPhysicsEntityRigidBody = (entityId: number) => {
  const world = getECSWorld();
  for (const type of PHYSICS_ENTITY_COMPONENT_TYPES) {
    const rigidBody = world.getComponent(entityId, type);
    if (rigidBody) return rigidBody;
  }
  return undefined;
};

const getPhysicsEntityLabel = (entityId: number): string => {
  const world = getECSWorld();
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  if (appId) return appId;
  const obj3D = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  if (obj3D?.name) return obj3D.name;
  return `[${entityId}]`;
};

const updateDebuggerEntityListSelectedClass = (entityId: number | null) => {
  const ulElem = debuggerEntityListCmp?.elem.getElementsByTagName('ul')[0];
  if (!ulElem) return;
  for (const child of ulElem.children) {
    child.classList.remove('selected');
    if (entityId === null) continue;
    if (child.getAttribute('data-id') === String(entityId)) child.classList.add('selected');
  }
};

const createPhysicsEntitiesDebugList = () => {
  const entityIds = getAllPhysicsEntityIds();
  let html = `<div><h3 class="listItemCount">${entityIds.length} physics entities:</h3>`;
  html += '<ul class="ulList">';
  for (let i = 0; i < entityIds.length; i++) {
    const entityId = entityIds[i];
    const label = getPhysicsEntityLabel(entityId);
    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(EDIT_PHYS_ENTITY_WIN_ID);
        if (winState?.isOpen && winState?.data?.entityId === entityId) {
          closeDraggableWindow(EDIT_PHYS_ENTITY_WIN_ID);
          return;
        }
        openDraggableWindow({
          id: EDIT_PHYS_ENTITY_WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit physics entity: ${label}`,
          isDebugWindow: true,
          content: createEditPhysicsEntityContent,
          data: { entityId },
          closeOnSceneChange: true,
          onClose: () => updateDebuggerEntityListSelectedClass(null),
        });
        updateDebuggerEntityListSelectedClass(entityId);
      },
      html: `<button class="listItemWithId">
  <span class="itemId">[${entityId}]</span>
  <h4>${label}</h4>
</button>`,
    });
    html += `<li data-id="${entityId}">${button}</li>`;
  }
  if (!entityIds.length) html += `<li class="emptyState">No physics entities registered..</li>`;
  html += '</ul></div>';
  return html;
};

/**
 * Per-entity wireframe controls for the edit window (p025 Design decision 7c / Phase 5):
 * the visibility toggle, plus one color picker per state that overrides the global
 * palette for this entity only.
 *
 * The pickers always show a color, since Tweakpane has no "unset" state — an untouched
 * one simply mirrors the current global value, and its "Reset to default" clears the
 * override so it goes back to tracking the global.
 */
const addEntityWireframeControls = (
  pane: Pane,
  entityId: number,
  world: ReturnType<typeof getECSWorld>
) => {
  const folder = pane
    .addFolder({
      title: 'Debug wireframe',
      expanded: physicsApiUIState.entityWireframeFolderExpanded,
    })
    .on('fold', (foldState) => {
      physicsApiUIState.entityWireframeFolderExpanded = foldState.expanded;
      persistUIState();
    });

  const visibilityProxy = { visible: isWireframeVisible(entityId, world) };
  folder
    .addBinding(visibilityProxy, 'visible', { label: 'Show wireframe' })
    .on('change', (e) => setWireframeVisible(entityId, world, e.value));

  // Without an app-supplied appId an entity's id is a fresh UUID every load, so nothing
  // below can be keyed to it across reloads. Say so rather than letting the settings look
  // like they silently failed to save.
  if (!isWireframePersistable(entityId, world)) {
    folder.addBinding({ note: 'Session only (entity has no appId)' }, 'note', {
      label: 'Persistence',
      readonly: true,
    });
  }

  const globals = getWireframeColors();
  // Seeded with this entity's override where it has one, and the global value otherwise.
  const colorProxy = {} as Record<WireframeColorState, number>;
  for (const state of WIREFRAME_COLOR_STATES) {
    colorProxy[state] = getEntityWireframeColor(entityId, state) ?? globals[state];
  }

  for (const state of WIREFRAME_COLOR_STATES) {
    folder
      .addBinding(colorProxy, state, {
        label: WIREFRAME_STATE_LABELS[state],
        view: 'color',
      })
      .on('change', (e) => setEntityWireframeColor(entityId, world, state, e.value));
    folder.addButton({ title: 'Reset to default' }).on('click', () => {
      setEntityWireframeColor(entityId, world, state, undefined);
      colorProxy[state] = getWireframeColors()[state];
      folder.refresh();
    });
  }

  folder.addButton({ title: 'Reset all to default' }).on('click', () => {
    resetEntityWireframeColors(entityId, world);
    const current = getWireframeColors();
    for (const state of WIREFRAME_COLOR_STATES) colorProxy[state] = current[state];
    folder.refresh();
  });
};

const createEditPhysicsEntityContent = (data?: { [key: string]: unknown }) => {
  const d = data as { entityId: number };
  const world = getECSWorld();

  if (entityWindowPane) {
    entityWindowPane.dispose();
    entityWindowPane = null;
  }
  if (entityWindowCmp) {
    entityWindowCmp.remove();
    entityWindowCmp = null;
  }

  const rigidBody = getPhysicsEntityRigidBody(d.entityId);
  if (!rigidBody) {
    // We want to close the window when no entity is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => closeDraggableWindow(EDIT_PHYS_ENTITY_WIN_ID), 0);
    return CMP();
  }

  addOnCloseToWindow(EDIT_PHYS_ENTITY_WIN_ID, () => updateDebuggerEntityListSelectedClass(null));
  updateDebuggerEntityListSelectedClass(d.entityId);

  const label = getPhysicsEntityLabel(d.entityId);
  const colliders = world.getComponent(d.entityId, ComponentType.COLLIDER);

  let isClosed = false;
  entityWindowCmp = CMP({
    onRemoveCmp: () => {
      entityWindowPane = null;
      isClosed = true;
    },
  });
  entityWindowPane = new Pane({ container: entityWindowCmp.elem });

  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this physics entity to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('PHYSICS ENTITY:***************', { entityId: d.entityId, rigidBody, colliders });
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Delete this physics entity (removes the ECS entity and its rigid body/colliders)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      world.deleteEntity(d.entityId);
      closeDraggableWindow(EDIT_PHYS_ENTITY_WIN_ID);
    },
  });

  // The shape name resolves asynchronously (ColliderAPI.shapeType()) — it gets its own leaf
  // CMP (no nested child CMPs) so only it needs to re-render once resolved. headerCmp itself
  // is never updated after creation: CMP.update() fully destroys and deregisters any
  // isTemplateCmp children (like logButton/deleteButton, interpolated into its html via
  // `${cmp}`) rather than preserving them, so re-running headerCmp's html function on a
  // later update would reference already-destroyed CMP ids and throw.
  const shapeLabel = colliders && colliders.length > 1 ? 'Colliders' : 'Collider';
  const shapeCmp = CMP({ text: 'Loading…' });
  entityWindowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Name:</span> ${label}</div>
  <div><span class="winSmallLabel">Id:</span> ${d.entityId}</div>
  <div><span class="winSmallLabel">${shapeLabel}:</span> ${shapeCmp}</div>
</div>
<div style="text-align:right">${logButton}${deleteButton}</div>
</div>`,
  });
  if (colliders && colliders.length) {
    Promise.all(colliders.map((collider) => collider.shapeType())).then((shapeTypes) => {
      if (isClosed) return;
      shapeCmp.updateText(
        shapeTypes.map((shapeType) => ShapeType[shapeType] ?? '[UNKNOWN]').join(', ')
      );
    });
  } else {
    shapeCmp.updateText('[No collider]');
  }

  const transform = {
    position: rigidBody.translation(),
    rotation: new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(
        rigidBody.rotation().x,
        rigidBody.rotation().y,
        rigidBody.rotation().z,
        rigidBody.rotation().w
      )
    ),
  };

  const positionInput = entityWindowPane.addBinding(transform, 'position', { label: 'Position' });
  entityWindowPane.addButton({ title: 'Set position' }).on('click', () => {
    rigidBody.setTranslation(
      { x: transform.position.x, y: transform.position.y, z: transform.position.z },
      true
    );
  });
  entityWindowPane.addButton({ title: 'Update position input' }).on('click', () => {
    transform.position = rigidBody.translation();
    positionInput.refresh();
  });
  entityWindowPane.addBlade({ view: 'separator' });

  const rotationInput = entityWindowPane.addBinding(transform, 'rotation', {
    label: 'Rotation',
    step: Math.PI / 8,
  });
  entityWindowPane.addButton({ title: 'Set rotation' }).on('click', () => {
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)
    );
    rigidBody.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
  });
  entityWindowPane.addButton({ title: 'Update rotation input' }).on('click', () => {
    const rot = rigidBody.rotation();
    transform.rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w)
    );
    rotationInput.refresh();
  });

  entityWindowPane.addBlade({ view: 'separator' });
  addEntityWireframeControls(entityWindowPane, d.entityId, world);

  return entityWindowCmp;
};

/**
 * "Wireframe" folder: the global palette every per-entity collider wireframe falls back
 * to (docs/plans/_DONE_p025_debug-drawing-in-physics-api.md, Design decision 7b). Visibility
 * itself is never global — it's toggled per entity from the edit window.
 */
const addWireframeFolder = (debugGUI: Pane) => {
  const folder = debugGUI
    .addFolder({ title: 'Wireframe', expanded: physicsApiUIState.wireframeFolderExpanded })
    .on('fold', (foldState) => {
      physicsApiUIState.wireframeFolderExpanded = foldState.expanded;
      persistUIState();
    });

  // Tweakpane binds to object properties, so the live values are mirrored into a plain
  // proxy; each on('change') writes through to the draw module and persists.
  const colorProxy = getWireframeColors() as Record<WireframeColorState, number>;

  for (const state of WIREFRAME_COLOR_STATES) {
    folder
      .addBinding(colorProxy, state, {
        label: WIREFRAME_STATE_LABELS[state],
        view: 'color',
      })
      .on('change', (e) => {
        setGlobalWireframeColor(state, e.value);
        persistWireframeState();
      });
    // A bare "Reset" directly under its own picker, matching _dbg__SkyBox.ts's pattern.
    folder.addButton({ title: 'Reset' }).on('click', () => {
      setGlobalWireframeColor(state, undefined);
      colorProxy[state] = getWireframeColorDefault(state);
      persistWireframeState();
      folder.refresh();
    });
  }

  folder.addBlade({ view: 'separator' });

  const thicknessProxy = { lineThickness: getWireframeLineThickness() };
  folder
    .addBinding(thicknessProxy, 'lineThickness', {
      label: 'Line thickness (px)',
      min: 1,
      max: 10,
      step: 1,
    })
    .on('change', (e) => {
      setGlobalWireframeLineThickness(e.value);
      persistWireframeState();
    });
  folder.addButton({ title: 'Reset' }).on('click', () => {
    setGlobalWireframeLineThickness(undefined);
    thicknessProxy.lineThickness = getWireframeLineThicknessDefault();
    persistWireframeState();
    folder.refresh();
  });

  folder.addButton({ title: 'Reset all wireframe settings' }).on('click', () => {
    for (const state of WIREFRAME_COLOR_STATES) {
      setGlobalWireframeColor(state, undefined);
      colorProxy[state] = getWireframeColorDefault(state);
    }
    setGlobalWireframeLineThickness(undefined);
    thicknessProxy.lineThickness = getWireframeLineThicknessDefault();
    setWireframePoseSource(undefined);
    if (wireframePoseDropDown) wireframePoseDropDown.value = DEFAULT_WIREFRAME_POSE_SOURCE;
    lsRemoveItem(WIREFRAME_LS_KEY);
    folder.refresh();
  });
};

export const _createPhysicsAPIDebugGUI = () => {
  physicsApiUIState = { ...physicsApiUIState, ...lsGetItem(UI_LS_KEY, physicsApiUIState) };
  restoreWireframeState();

  const state = getPhysicsState();
  const savedValues = lsGetItem(LS_KEY, {}) as Partial<LivePhysicsApiState>;
  Object.assign(state, savedValues);
  state.timestepRatio = 1 / (state.timestep || 60);
  applyLiveStateToWorld(state);

  const icon = getSvgIcon('rocketTakeoff');
  createDebuggerTab({
    id: 'physicsApiControls',
    buttonText: icon,
    title: 'Physics API controls',
    orderNr: 6,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        // Every key this tab owns, so one button leaves nothing behind.
        hasData: () =>
          lsKeyHasData(LS_KEY) ||
          lsKeyHasData(WIREFRAME_LS_KEY) ||
          lsKeyHasData(PHYSICS_WIREFRAME_ENTITY_LS_KEY) ||
          lsKeyHasData(UI_LS_KEY),
        onClear: () => {
          lsRemoveItem(LS_KEY);
          lsRemoveItem(WIREFRAME_LS_KEY);
          lsRemoveItem(PHYSICS_WIREFRAME_ENTITY_LS_KEY);
          lsRemoveItem(UI_LS_KEY);
        },
        watchKey: LS_KEY,
      });
      const { container, debugGUI } = createNewDebuggerPane(
        'physicsApi',
        `${icon} Physics API Controls`,
        [clearTabBtn]
      );

      // --- Boot-time settings (require a reload to take effect) ---

      const workerTargetDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Worker target (reloads)',
        options: [
          { value: 'MAIN_THREAD', text: 'Main thread' },
          { value: 'WORKER_THREAD', text: 'Worker thread' },
        ],
        value: state.workerTarget,
      }) as ListBladeApi<BladeController<View>>;
      workerTargetDropDown.on('change', (e) => {
        setBootOverride({ workerTarget: e.value as unknown as PhysicsWorkerTarget });
      });
      debugGUI
        .addBinding(state, 'useSAB', { label: 'Use SharedArrayBuffer (reloads)' })
        .on('change', (e) => {
          setBootOverride({ useSAB: e.value });
        });
      debugGUI
        .addBinding(state, 'maxBodies', { label: 'Max bodies (reloads)', step: 1, min: 1 })
        .on('change', (e) => {
          setBootOverride({ maxBodies: e.value });
        });
      // Feeds the stats "PHY" panel, and getLastPhysicsStepDuration()/
      // getLastPhysicsStepMessagingLatency(). Off by default so the measurement costs
      // nothing — including the risk of the timing overhead skewing the very number it
      // reports — unless someone asks for it. Boot-time, because the SHARED_MEMORY
      // transport's stats buffer is allocated once at world creation.
      debugGUI
        .addBinding(state, 'stepStatsEnabled', { label: 'Track physics step time (reloads)' })
        .on('change', (e) => {
          setBootOverride({ stepStatsEnabled: e.value });
        });

      // Read once: createPhysicsWorld() (which resolves this) always runs before this
      // tab is ever built (see InitApp.ts's boot order), and nothing in the app
      // creates/destroys the physics world again afterward — the value cannot change
      // for the remaining lifetime of this tab, so there's nothing to poll.
      const transportModeReadout = {
        transportMode: getResolvedTransportMode() ?? 'N/A, worker only',
      };
      debugGUI.addBinding(transportModeReadout, 'transportMode', {
        label: 'Resolved transport mode',
        readonly: true,
      });

      debugGUI.addBlade({ view: 'separator' });

      // --- Live settings ---
      // Enable visualizer is still omitted: visualizerEnabled has no debugRender wiring yet.
      // Background behavior / min-max delta time / max sub-steps are live as of Phase 1's
      // fixed-timestep accumulator in stepPhysics(); interpolation mode is live as of
      // Phase 2's physicsInterpolationSystem (PhysicsManager.ts). 'EXTRAPOLATION' isn't
      // offered here yet — reserved, not implemented (Phase 4 feasibility study).

      debugGUI
        .addBinding(state, 'timestep', { label: 'Global timestep (1 / ts)', step: 1, min: 1 })
        .on('change', (e) => {
          state.timestepRatio = 1 / e.value;
          persistLiveState(state);
          if (isPhysicsWorldEnabled()) {
            getPhysicsWorld().setTimestep(state.timestepRatio);
          }
        });
      debugGUI
        .addBinding(state, 'worldStepEnabled', { label: 'Enable world step' })
        .on('change', () => {
          persistLiveState(state);
        });
      debugGUI.addBinding(state, 'gravity', { label: 'Gravity' }).on('change', (e) => {
        state.gravity = { ...e.value };
        persistLiveState(state);
        if (isPhysicsWorldEnabled()) {
          getPhysicsWorld().setGravity(state.gravity);
          // Sleeping bodies don't re-evaluate forces until woken, so they'd keep ignoring
          // the new gravity value until something else disturbs them.
          for (const entityId of getAllPhysicsEntityIds()) {
            getPhysicsEntityRigidBody(entityId)?.wakeUp();
          }
        }
      });
      debugGUI
        .addBinding(state, 'solverIterations', {
          label: 'Solver iterations',
          min: 1,
          step: 1,
        })
        .on('change', (e) => {
          state.solverIterations = e.value;
          persistLiveState(state);
          if (isPhysicsWorldEnabled()) {
            getPhysicsWorld().setNumSolverIterations(e.value);
          }
        });
      debugGUI
        .addBinding(state, 'internalPgsIterations', {
          label: 'Internal PGS iterations (run at each solver iteration)',
          min: 1,
          step: 1,
        })
        .on('change', (e) => {
          state.internalPgsIterations = e.value;
          persistLiveState(state);
          if (isPhysicsWorldEnabled()) {
            getPhysicsWorld().setNumInternalPgsIterations(e.value);
          }
        });

      debugGUI.addBlade({ view: 'separator' });

      const bgBehaviorDropDown = debugGUI.addBlade({
        view: 'list',
        label:
          'Background behavior (while the window is hidden — another tab, another window, minimized)',
        options: [
          { value: 'KEEP_RUNNING', text: 'Keep running' },
          { value: 'KEEP_RUNNING_USE_MIN_DELTA', text: 'Keep running, use minimum delta time' },
          { value: 'PAUSE', text: 'Pause' },
        ],
        value: state.backgroundBehavior,
      }) as ListBladeApi<BladeController<View>>;
      bgBehaviorDropDown.on('change', (e) => {
        state.backgroundBehavior = e.value as unknown as PhysicsState['backgroundBehavior'];
        persistLiveState(state);
      });

      // Displayed as Hz (1 / seconds), matching the 'Global timestep' control above — the
      // underlying state fields are stored as seconds. A local proxy avoids the mismatch
      // legacy's debug tab had, where the field bound directly to the seconds value but
      // its on('change') handler re-interpreted the edited number as Hz.
      const deltaTimeHzProxy = {
        minDeltaTimeHz: state.minDeltaTime > 0 ? 1 / state.minDeltaTime : 0,
        maxDeltaTimeHz: state.maxDeltaTime > 0 ? 1 / state.maxDeltaTime : 0,
      };
      debugGUI
        .addBinding(deltaTimeHzProxy, 'minDeltaTimeHz', {
          label:
            'Minimum delta time (as fps; used by "Keep running, use minimum delta time"), 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', (e) => {
          state.minDeltaTime = e.value > 0 ? 1 / e.value : 0;
          persistLiveState(state);
        });
      debugGUI
        .addBinding(deltaTimeHzProxy, 'maxDeltaTimeHz', {
          label:
            'Maximum delta time (as fps; clamps a single frame’s contribution to the physics accumulator), 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', (e) => {
          state.maxDeltaTime = e.value > 0 ? 1 / e.value : 0;
          persistLiveState(state);
        });
      debugGUI
        .addBinding(state, 'maxSubSteps', {
          label:
            'Max sub-steps per frame (drops backlog beyond this instead of deferring it), 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', (e) => {
          state.maxSubSteps = e.value;
          persistLiveState(state);
        });

      debugGUI.addBlade({ view: 'separator' });

      // 'EXTRAPOLATION' isn't offered here yet — reserved, not implemented (p024 feasibility
      // study). physicsInterpolationSystem (PhysicsManager.ts) returns early for it, so
      // selecting it via AppConfig is safe but inert.
      const interpolationModeDropDown = debugGUI.addBlade({
        view: 'list',
        label:
          'Interpolation mode (render-only smoothing; ECS TRANSFORM always stays the discrete pose)',
        options: [
          { value: 'NONE', text: 'None (latest step pose, judders above the physics rate)' },
          {
            value: 'RENDERER',
            text: 'Renderer (servoed to the received snapshots; use with the worker)',
          },
          {
            value: 'FIXED_PHYSICS',
            text: 'Fixed physics (open-loop from the stepper; MAIN_THREAD only)',
          },
        ],
        value: state.interpolationMode,
      }) as ListBladeApi<BladeController<View>>;
      interpolationModeDropDown.on('change', (e) => {
        state.interpolationMode = e.value as unknown as PhysicsInterpolationMode;
        persistLiveState(state);
      });

      // Which pose moving bodies' collider wireframes follow: the raw physics pose shows the
      // interpolation offset (the mesh trails its wireframe while moving), the rendered pose
      // puts the wireframe on the mesh. Headless bodies have no mesh and always show physics.
      wireframePoseDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Wireframe pose (moving bodies)',
        options: [
          { value: 'PHYSICS', text: 'Physics (raw stepped pose)' },
          { value: 'RENDERED', text: 'Rendered (interpolated mesh pose)' },
        ],
        value: getWireframePoseSource(),
      }) as ListBladeApi<WireframePoseSource>;
      wireframePoseDropDown.on('change', (e) => {
        setWireframePoseSource(e.value);
        persistWireframeState();
      });

      // Live render-clock values (updated by physicsInterpolationSystem, frozen in 'NONE') —
      // the jitter margin and servo can't be tuned without them. Readonly bindings poll.
      const interpolationReadout = getPhysicsInterpolationReadout(getECSWorld());
      const interpolationFolder = debugGUI.addFolder({
        title: 'Interpolation clock (live, simulated ms)',
        expanded: false,
      });
      const formatMs = (v: number) => v.toFixed(2);
      interpolationFolder.addBinding(interpolationReadout, 'lagMs', {
        label: 'Lag behind the stepper',
        readonly: true,
        format: formatMs,
      });
      interpolationFolder.addBinding(interpolationReadout, 'delayMs', {
        label: 'Delay D (max recent interval)',
        readonly: true,
        format: formatMs,
      });
      interpolationFolder.addBinding(interpolationReadout, 'intervalMs', {
        label: 'Last snapshot interval',
        readonly: true,
        format: formatMs,
      });
      interpolationFolder.addBinding(interpolationReadout, 'errorMs', {
        label: 'Servo error (RENDERER)',
        readonly: true,
        format: formatMs,
      });
      interpolationFolder.addBinding(interpolationReadout, 'rate', {
        label: 'Clock rate',
        readonly: true,
        format: (v: number) => v.toFixed(3),
      });
      interpolationFolder.addBinding(interpolationReadout, 'resets', {
        label: 'Clock re-anchors',
        readonly: true,
        format: (v: number) => v.toFixed(0),
      });

      debugGUI.addBlade({ view: 'separator' });

      addWireframeFolder(debugGUI);

      // Switching to another debugger tab rebuilds this container from scratch on
      // return (createDebuggerTab's container() re-runs on every click, it isn't
      // built once and hidden/shown) — an interval started here without teardown
      // would leak a new one on every visit. Clear it in onRemoveCmp, which the CMP
      // framework calls when this tab's content is torn down for the next one.
      // No entity create/delete hook to subscribe to — poll, same tradeoff as the spatial
      // grid debug panel's live readout. Skips the actual rebuild when the entity set
      // hasn't changed, so an open edit window's list selection isn't wiped every tick
      // for no reason.
      const entityListIntervalId = setInterval(() => {
        const signature = getAllPhysicsEntityIds().join(',');
        if (signature === lastEntityListSignature) return;
        lastEntityListSignature = signature;
        debuggerEntityListCmp?.update({ html: createPhysicsEntitiesDebugList });
        const winState = getDraggableWindow(EDIT_PHYS_ENTITY_WIN_ID);
        if (winState?.isOpen && typeof winState.data?.entityId === 'number') {
          updateDebuggerEntityListSelectedClass(winState.data.entityId);
        }
      }, 500);
      // Switching to another debugger tab rebuilds this container from scratch on
      // return (createDebuggerTab's container() re-runs on every click, it isn't built
      // once and hidden/shown) — an interval started here without teardown would leak a
      // new one on every visit. Clear it in onRemoveCmp, which the CMP framework calls
      // when this tab's content is torn down for the next one.
      debuggerEntityListCmp = CMP({
        id: 'debuggerPhysicsApiEntityList',
        html: createPhysicsEntitiesDebugList,
        onRemoveCmp: () => clearInterval(entityListIntervalId),
      });
      container.add(debuggerEntityListCmp);

      return container;
    },
  });

  // The edit window's `content` is a function, which can't survive the JSON
  // serialization DraggableWindow uses to persist open/position state — after a reload,
  // a previously-open window reopens with no content attached. Re-attach it, mirroring
  // _dbg__Character.ts's identical restore pattern. This runs unconditionally at boot
  // (not inside the tab's lazy `container` callback above) because the window can be
  // open on reload whether or not this tab has ever been clicked open this session.
  setTimeout(() => {
    const winState = getDraggableWindow(EDIT_PHYS_ENTITY_WIN_ID);
    if (winState && !winState.content) {
      registerDraggableWindowCmp(EDIT_PHYS_ENTITY_WIN_ID, {
        content: createEditPhysicsEntityContent,
        onClose: () => updateDebuggerEntityListSelectedClass(null),
      });
    }
  }, 0);
};
