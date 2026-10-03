import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import {
  createDebuggerTab,
  debuggerListCMP,
  hydrateDebuggerTabState,
  persistDebuggerTabValue,
  updateDebuggerTab,
  type DebuggerListItem,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { llog, lwarn } from '../../utils/Logger';
import { CMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import {
  closeDraggableWindow,
  getDraggableWindowsOfKind,
  getKindWindowId,
  registerDraggableWindowKind,
  toggleDraggableWindow,
  updateDraggableWindow,
} from '../UI/DraggableWindow';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import {
  getPhysicsState,
  getPhysicsWorld,
  getResolvedTransportMode,
  isPhysicsWorldEnabled,
} from '../PhysicsAPI';
import { setBootOverride } from './_dbg__PhysicsBootOverrides';
import { getConfig } from '../Config';
import { ShapeType, type PhysicsState, type PhysicsWorkerTarget } from '../Physics/PhysicsAPITypes';
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
import {
  armPhysicsDeterminismProbe,
  disarmPhysicsDeterminismProbe,
  getPhysicsDeterminismProbeSteps,
} from './_dbg__PhysicsDeterminism';
import { getECSWorld, getEntityIdByAppId, getStableAppId } from '../ECS';
import { getPhysicsInterpolationReadout } from '../PhysicsManager';
import { registerEntityWindowOpener } from '../../debug/Profiler';
import { ComponentType } from '../ECS/ECSCoreComponents';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from './_dbg__UndoRedo';

const LS_KEY = 'AEK_debugPhysicsApi';
const TAB_ID = 'physicsApiControls';
/** Wireframe colors/thickness get their own key so "Clear tab LS" on the main physics
 * settings doesn't silently wipe the user's palette, and vice versa. */
const WIREFRAME_LS_KEY = 'AEK_debugPhysicsApiWireframe';
/** Pure UI state (which folders are open), kept apart from the settings keys so
 * "Reset all wireframe settings" doesn't also collapse the folder you're working in. It is the
 * tab's UI key (`${LS_KEY}UI`): the tab keeps its folder states under `folders`, the edit window
 * its own field next to them. */
const UI_LS_KEY = 'AEK_debugPhysicsApiUI';

let physicsApiUIState = {
  entityWireframeFolderExpanded: false,
};

/** Merged, so the tab's own folder states in the same key are kept. */
const persistUIState = () =>
  lsSetItem(UI_LS_KEY, { ...(lsGetItem(UI_LS_KEY, {}) as object), ...physicsApiUIState });
/** The edit windows' kind: one window per physics entity, keyed by its stable app id (the entity
 * id without one, see getPhysWinKey) */
const EDIT_PHYS_ENTITY_WIN_ID = 'physicsApiEntityEditorWindow';
const PHYSICS_ENTITY_COMPONENT_TYPES = [
  ComponentType.BODY_STATIC,
  ComponentType.BODY_DYNAMIC_VISUAL,
  ComponentType.BODY_DYNAMIC_HEADLESS,
] as const;

type PersistedWireframeState = {
  colors?: Partial<Record<WireframeColorState, number>>;
  lineThickness?: number;
  poseSource?: WireframePoseSource;
};

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
const LIVE_PERSIST_KEYS = [
  'timestep',
  'worldStepEnabled',
  'gravity',
  'solverIterations',
  'internalPgsIterations',
  'backgroundBehavior',
  'minDeltaTime',
  'maxDeltaTime',
  'maxSubSteps',
  'interpolationMode',
] as const satisfies readonly (keyof PhysicsState)[];

/**
 * Restores the persisted world settings into the physics state, before the first physics world
 * is created (registerPhysicsAPIDebugGUI in InitApp.ts). gravity/solverIterations/
 * internalPgsIterations/timestep are baked into a Rapier world when it's created, and every
 * world (the boot one, and each scene load's fresh one) is built from the physics state. So
 * nothing is pushed into a running world: that would overwrite what the start scene set on its
 * own world (eg. the space scene's zero gravity). The tab hydrates the same values again when it
 * registers, after the start scene.
 */
export const _hydratePhysicsLiveSettings = () => {
  const state = getPhysicsState();
  hydrateDebuggerTabState({ lsKey: LS_KEY, state, persistKeys: LIVE_PERSIST_KEYS });
  state.timestepRatio = 1 / (state.timestep || 60);
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

// Undo/redo

/** Live world settings recorded to the global undo/redo history (the physics world and its
 * settings are shared by every scene). */
type UndoableSetting = 'gravity' | 'solverIterations' | 'internalPgsIterations';
type SettingValues = Pick<PhysicsState, UndoableSetting>;
type SettingUndoPayload<K extends UndoableSetting> = {
  prev: SettingValues[K];
  next: SettingValues[K];
};

const UNDOABLE_SETTING_LABELS: Record<UndoableSetting, string> = {
  gravity: 'Physics: gravity',
  solverIterations: 'Physics: solver iterations',
  internalPgsIterations: 'Physics: internal PGS iterations',
};

/** Pushes a setting from the state into the running world. */
const applySettingToWorld: Record<UndoableSetting, (state: PhysicsState) => void> = {
  gravity: (state) => {
    if (!isPhysicsWorldEnabled()) return;
    getPhysicsWorld().setGravity(state.gravity);
    // Sleeping bodies don't re-evaluate forces until woken, so they'd keep ignoring
    // the new gravity value until something else disturbs them.
    for (const entityId of getAllPhysicsEntityIds()) {
      getPhysicsEntityRigidBody(entityId)?.wakeUp();
    }
  },
  solverIterations: (state) => {
    if (isPhysicsWorldEnabled()) getPhysicsWorld().setNumSolverIterations(state.solverIterations);
  },
  internalPgsIterations: (state) => {
    if (isPhysicsWorldEnabled()) {
      getPhysicsWorld().setNumInternalPgsIterations(state.internalPgsIterations);
    }
  },
};

/** Tweakpane's point binding writes into the bound gravity object in place, so the state and
 * the history payloads must never share one. */
const copySetting = <T>(value: T): T => structuredClone(value);

/** Records a finished or in-progress change; the ticks of one drag merge into one entry
 * (the first `prev`, the latest `next`). */
const recordSettingChange = <K extends UndoableSetting>(
  key: K,
  prev: SettingValues[K],
  next: SettingValues[K]
) => {
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  const payload: SettingUndoPayload<K> = { prev: copySetting(prev), next: copySetting(next) };
  _recordOrCoalesceUndoRedoAction(`physics.${key}`, UNDOABLE_SETTING_LABELS[key], payload, key);
};

const setSetting = <K extends UndoableSetting>(key: K, value: SettingValues[K]) => {
  const state = getPhysicsState();
  (state as SettingValues)[key] = copySetting(value);
  persistDebuggerTabValue(TAB_ID, key);
  applySettingToWorld[key](state);
  updateDebuggerTab(TAB_ID);
};

const registerSettingUndoHandler = <K extends UndoableSetting>(key: K) => {
  _registerUndoRedoActionHandler<SettingUndoPayload<K>>(
    `physics.${key}`,
    {
      undo: ({ prev }) => setSetting(key, prev),
      redo: ({ next }) => setSetting(key, next),
    },
    'global'
  );
};
registerSettingUndoHandler('gravity');
registerSettingUndoHandler('solverIterations');
registerSettingUndoHandler('internalPgsIterations');

/** Physics entity poses set from the edit window, recorded to the scene's history. */
type PhysVec3 = { x: number; y: number; z: number };
type PhysQuat = { x: number; y: number; z: number; w: number };
type PhysicsObjectUndoPayload<T> = { appId: string; prev: T; next: T };

/** Finds the rigid body by app id at undo/redo time (never a captured reference). */
const resolvePhysicsEntityRigidBody = (appId: string) => {
  const entityId = getEntityIdByAppId(appId);
  const rigidBody = entityId !== undefined ? getPhysicsEntityRigidBody(entityId) : undefined;
  if (!rigidBody) lwarn(`Undo/redo: physics entity "${appId}" no longer exists, skipping.`);
  return rigidBody;
};

// Only the pose is restored: the body keeps simulating, so its velocity isn't rolled back.
_registerUndoRedoActionHandler<PhysicsObjectUndoPayload<PhysVec3>>('physicsObject.position', {
  undo: ({ appId, prev }) => resolvePhysicsEntityRigidBody(appId)?.setTranslation(prev, true),
  redo: ({ appId, next }) => resolvePhysicsEntityRigidBody(appId)?.setTranslation(next, true),
});
_registerUndoRedoActionHandler<PhysicsObjectUndoPayload<PhysQuat>>('physicsObject.rotation', {
  undo: ({ appId, prev }) => resolvePhysicsEntityRigidBody(appId)?.setRotation(prev, true),
  redo: ({ appId, next }) => resolvePhysicsEntityRigidBody(appId)?.setRotation(next, true),
});

const getPhysicsEntityLabel = (entityId: number): string => {
  const world = getECSWorld();
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  if (appId) return appId;
  const obj3D = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  if (obj3D?.name) return obj3D.name;
  return `[${entityId}]`;
};

type PhysEntityWinData = { entityId: number; appId?: string };

/** The edit window's entity: by its stable appId first (the raw entity id doesn't survive a scene
 * change), by the raw entity id only when the entity has no stable appId. */
const getPhysWinEntityId = (data?: { [key: string]: unknown }) => {
  const d = (data || {}) as Partial<PhysEntityWinData>;
  return d.appId ? getEntityIdByAppId(d.appId) : d.entityId;
};

/** An entity's edit window key: its stable appId (found again after a scene change or a
 * reload), else its entity id (session only: the resolver never keeps such a window). */
const getPhysWinKey = (data: PhysEntityWinData) => data.appId ?? String(data.entityId);

/** The list's selection follows the edit windows. */
const refreshPhysicsTab = () => updateDebuggerTab(TAB_ID);

const getPhysicsEntitiesListData = (): DebuggerListItem[] => {
  const world = getECSWorld();
  return getAllPhysicsEntityIds().map((entityId) => ({
    itemId: String(entityId),
    title: getPhysicsEntityLabel(entityId),
    subTitle: `[${entityId}]`,
    toggleValues: [isWireframeVisible(entityId, world)],
  }));
};

/** The entity's edit window id (the row id is the entity id). */
const getPhysWinId = (entityId: number) =>
  getKindWindowId(
    EDIT_PHYS_ENTITY_WIN_ID,
    getPhysWinKey({ entityId, appId: getStableAppId(entityId) })
  );

/** List row click: opens the entity's window, brings it to the front, or closes it when on top. */
const toggleEditPhysicsEntityWindow = (itemId: string) => {
  const entityId = Number(itemId);
  const data: PhysEntityWinData = { entityId, appId: getStableAppId(entityId) };
  toggleDraggableWindow({
    id: getKindWindowId(EDIT_PHYS_ENTITY_WIN_ID, getPhysWinKey(data)),
    kind: EDIT_PHYS_ENTITY_WIN_ID,
    position: { x: 110, y: 60 },
    size: { w: 400, h: 400 },
    saveToLS: true,
    title: `Edit physics entity: ${getPhysicsEntityLabel(entityId)}`,
    isDebugWindow: true,
    data,
    closeOnSceneChange: true,
  });
};

// The profiler's heaviest objects open a physics entity's window too
registerEntityWindowOpener({
  id: 'physicsEntity',
  label: 'Edit physics entity',
  canOpen: (world, entityId) =>
    world === getECSWorld() && Boolean(getPhysicsEntityRigidBody(entityId)),
  toggle: (_world, entityId) => toggleEditPhysicsEntityWindow(String(entityId)),
});

/** List toggle: the same setter as the edit window's "Show wireframe" input. */
const togglePhysicsEntityWireframe = (itemId: string, next: boolean) => {
  const entityId = Number(itemId);
  setWireframeVisible(entityId, getECSWorld(), next);
  updateDraggableWindow(getPhysWinId(entityId));
};

/**
 * Per-entity wireframe controls for the edit window:
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
  folder.addBinding(visibilityProxy, 'visible', { label: 'Show wireframe' }).on('change', (e) => {
    setWireframeVisible(entityId, world, e.value);
    refreshPhysicsTab();
  });

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
  const winId = getKindWindowId(EDIT_PHYS_ENTITY_WIN_ID, getPhysWinKey(data as PhysEntityWinData));
  const entityId = getPhysWinEntityId(data);
  const world = getECSWorld();

  const rigidBody = entityId === undefined ? undefined : getPhysicsEntityRigidBody(entityId);
  if (entityId === undefined || !rigidBody) {
    // We want to close the window when no entity is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => closeDraggableWindow(winId), 0);
    return CMP();
  }

  // The content is built before the window state is open: refresh the list selection after it
  queueMicrotask(refreshPhysicsTab);

  const label = getPhysicsEntityLabel(entityId);
  const colliders = world.getComponent(entityId, ComponentType.COLLIDER);

  let isClosed = false;
  const entityWindowCmp = CMP({
    onRemoveCmp: () => {
      entityWindowPane.dispose();
      isClosed = true;
    },
  });
  const entityWindowPane = new Pane({ container: entityWindowCmp.elem });

  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this physics entity to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('PHYSICS ENTITY:***************', { entityId, rigidBody, colliders });
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Delete this physics entity (removes the ECS entity and its rigid body/colliders)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      world.deleteEntity(entityId);
      closeDraggableWindow(winId);
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
  <div><span class="winSmallLabel">Id:</span> ${entityId}</div>
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

  // Generated app ids can't be found again after a reload, so only entities with a stable
  // app id are recorded to the undo/redo history.
  const stableAppId = getStableAppId(entityId, world);
  const recordPose = <T extends PhysVec3 | PhysQuat>(
    field: 'position' | 'rotation',
    prev: T,
    next: T
  ) => {
    if (!stableAppId || JSON.stringify(prev) === JSON.stringify(next)) return;
    _recordUndoRedoAction<PhysicsObjectUndoPayload<T>>(
      `physicsObject.${field}`,
      `Physics entity ${stableAppId}: ${field}`,
      { appId: stableAppId, prev, next }
    );
  };

  const positionInput = entityWindowPane.addBinding(transform, 'position', { label: 'Position' });
  entityWindowPane.addButton({ title: 'Set position' }).on('click', () => {
    const { x, y, z } = rigidBody.translation();
    const next = { x: transform.position.x, y: transform.position.y, z: transform.position.z };
    rigidBody.setTranslation(next, true);
    recordPose('position', { x, y, z }, next);
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
    const { x, y, z, w } = rigidBody.rotation();
    const next = { x: quat.x, y: quat.y, z: quat.z, w: quat.w };
    rigidBody.setRotation(next, true);
    recordPose('rotation', { x, y, z, w }, next);
  });
  entityWindowPane.addButton({ title: 'Update rotation input' }).on('click', () => {
    const rot = rigidBody.rotation();
    transform.rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w)
    );
    rotationInput.refresh();
  });

  entityWindowPane.addBlade({ view: 'separator' });
  addEntityWireframeControls(entityWindowPane, entityId, world);

  return entityWindowCmp;
};

registerDraggableWindowKind(EDIT_PHYS_ENTITY_WIN_ID, {
  content: createEditPhysicsEntityContent,
  onClose: refreshPhysicsTab,
  // Kept open on a scene change when the next scene has a physics entity with the same stable
  // appId
  sceneTargetResolver: (data) => {
    if (!(data as Partial<PhysEntityWinData>)?.appId) return false;
    const entityId = getPhysWinEntityId(data);
    return entityId !== undefined && Boolean(getPhysicsEntityRigidBody(entityId));
  },
});

type WireframeProxies = {
  colors: Record<WireframeColorState, number>;
  thickness: { lineThickness: number };
  pose: { poseSource: WireframePoseSource };
};

/**
 * "Wireframe" folder: the global palette every per-entity collider wireframe falls back
 * to. Visibility itself is never global — it's toggled per entity (edit window or list).
 * Tweakpane binds to object properties, so the live values are mirrored into plain proxies;
 * each onChange writes through to the draw module and persists (to its own module-owned key).
 */
const getWireframeFolder = (proxies: WireframeProxies): DebuggerPaneItem<PhysicsState> => {
  const { colors, thickness, pose } = proxies;
  const items: DebuggerPaneItem<PhysicsState>[] = [];
  for (const state of WIREFRAME_COLOR_STATES) {
    items.push(
      {
        key: state,
        target: colors,
        label: WIREFRAME_STATE_LABELS[state],
        view: 'color',
        onChange: (value) => {
          setGlobalWireframeColor(state, Number(value));
          persistWireframeState();
        },
      },
      // A bare "Reset" directly under its own picker, matching the Sky box tab's pattern.
      {
        type: 'button',
        title: 'Reset',
        onClick: () => {
          setGlobalWireframeColor(state, undefined);
          colors[state] = getWireframeColorDefault(state);
          persistWireframeState();
          refreshPhysicsTab();
        },
      }
    );
  }
  items.push(
    { type: 'separator' },
    {
      key: 'lineThickness',
      target: thickness,
      label: 'Line thickness (px)',
      min: 1,
      max: 10,
      step: 1,
      onChange: (value) => {
        setGlobalWireframeLineThickness(Number(value));
        persistWireframeState();
      },
    },
    {
      type: 'button',
      title: 'Reset',
      onClick: () => {
        setGlobalWireframeLineThickness(undefined);
        thickness.lineThickness = getWireframeLineThicknessDefault();
        persistWireframeState();
        refreshPhysicsTab();
      },
    },
    {
      type: 'button',
      title: 'Reset all wireframe settings',
      onClick: () => {
        for (const state of WIREFRAME_COLOR_STATES) {
          setGlobalWireframeColor(state, undefined);
          colors[state] = getWireframeColorDefault(state);
        }
        setGlobalWireframeLineThickness(undefined);
        thickness.lineThickness = getWireframeLineThicknessDefault();
        setWireframePoseSource(undefined);
        pose.poseSource = DEFAULT_WIREFRAME_POSE_SOURCE;
        lsRemoveItem(WIREFRAME_LS_KEY);
        refreshPhysicsTab();
      },
    }
  );
  return { type: 'folder', id: 'wireframe', title: 'Wireframe', expanded: false, content: items };
};

/** Arms/disarms the determinism probe (_dbg__PhysicsDeterminism.ts). Results go to the console. */
const getDeterminismProbeFolder = (): DebuggerPaneItem<PhysicsState> => {
  const probeState = { steps: getPhysicsDeterminismProbeSteps() ?? 300 };
  return {
    type: 'folder',
    id: 'determinismProbe',
    title: 'Determinism probe',
    expanded: false,
    content: [
      { key: 'steps', target: probeState, label: 'Steps (N)', step: 1, min: 1 },
      {
        type: 'button',
        title: 'Probe N steps (from now, then on every scene enter)',
        onClick: () => armPhysicsDeterminismProbe(probeState.steps),
      },
      {
        type: 'button',
        title: 'Stop probe (resumes physics)',
        onClick: () => disarmPhysicsDeterminismProbe(),
      },
    ],
  };
};

/** Live render-clock values (updated by physicsInterpolationSystem, frozen in 'NONE') — the
 * jitter margin and servo can't be tuned without them. Readonly bindings poll. */
const getInterpolationClockFolder = (): DebuggerPaneItem<PhysicsState> => {
  const readout = getPhysicsInterpolationReadout(getECSWorld());
  const formatMs = (v: number) => v.toFixed(2);
  const monitor = (key: string, label: string, format = formatMs) =>
    ({ key, target: readout, label, readonly: true, format }) as DebuggerPaneItem<PhysicsState>;
  return {
    type: 'folder',
    id: 'interpolationClock',
    title: 'Interpolation clock (live, simulated ms)',
    expanded: false,
    content: [
      monitor('lagMs', 'Lag behind the stepper'),
      monitor('delayMs', 'Delay D (max recent interval)'),
      monitor('intervalMs', 'Last snapshot interval'),
      monitor('errorMs', 'Servo error (RENDERER)'),
      monitor('rate', 'Clock rate', (v: number) => v.toFixed(3)),
      monitor('resets', 'Clock re-anchors', (v: number) => v.toFixed(0)),
    ],
  };
};

export const _createPhysicsAPIDebugGUI = () => {
  physicsApiUIState = { ...physicsApiUIState, ...lsGetItem(UI_LS_KEY, physicsApiUIState) };
  restoreWireframeState();

  const state = getPhysicsState();

  createDebuggerTab({
    id: TAB_ID,
    title: 'Physics API controls',
    icon: 'rocketTakeoff',
    lsKey: LS_KEY,
    state,
    persistKeys: LIVE_PERSIST_KEYS,
    // Every key this tab owns, so one button leaves nothing behind
    clearLSButton: false,
    headerButtons: () => [
      createClearTabLSButton({
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
      }),
    ],
    // No entity create/delete hook to subscribe to: poll, same tradeoff as the spatial grid
    // debug panel's live readout (the list only re-renders when its rows changed)
    refreshIntervalMs: 500,
    content: () => {
      // Read once: createPhysicsWorld() (which resolves this) always runs before this tab is
      // ever built (see InitApp.ts's boot order). The world is recreated on every scene load,
      // but always resolves the same transport (it only depends on the boot-time useSAB
      // setting and the page's cross-origin isolation), so there's nothing to poll.
      const transportModeReadout = {
        transportMode: getResolvedTransportMode() ?? 'N/A, worker only',
      };
      // The boot value, not the live one: it only takes effect after a reload
      const workerTargetProxy = { workerTarget: state.workerTarget };
      // The boot value too: the live one is on while the profiler measures the step
      const stepStatsBootProxy = {
        stepStatsEnabled: Boolean(getConfig().physics?.stepStatsEnabled),
      };
      // Displayed as Hz (1 / seconds), matching the 'Global timestep' control — the state
      // fields are stored as seconds.
      const deltaTimeHzProxy = {
        minDeltaTimeHz: state.minDeltaTime > 0 ? 1 / state.minDeltaTime : 0,
        maxDeltaTimeHz: state.maxDeltaTime > 0 ? 1 / state.maxDeltaTime : 0,
      };
      const wireframeProxies: WireframeProxies = {
        colors: { ...getWireframeColors() } as Record<WireframeColorState, number>,
        thickness: { lineThickness: getWireframeLineThickness() },
        pose: { poseSource: getWireframePoseSource() },
      };

      return [
        {
          pane: true,
          content: [
            // --- Boot-time settings (require a reload to take effect) ---
            {
              key: 'workerTarget',
              target: workerTargetProxy,
              label: 'Worker target (reloads)',
              options: [
                { value: 'MAIN_THREAD', text: 'Main thread' },
                { value: 'WORKER_THREAD', text: 'Worker thread' },
              ],
              onChange: (value) => setBootOverride({ workerTarget: value as PhysicsWorkerTarget }),
            },
            {
              key: 'useSAB',
              label: 'Use SharedArrayBuffer (reloads)',
              onChange: (value) => setBootOverride({ useSAB: Boolean(value) }),
            },
            {
              key: 'maxBodies',
              label: 'Max bodies (reloads)',
              step: 1,
              min: 1,
              onChange: (value) => setBootOverride({ maxBodies: Number(value) }),
            },
            // Feeds the stats "PHY" panel, and getLastPhysicsStepDuration()/
            // getLastPhysicsStepMessagingLatency(). Off by default so the measurement costs
            // nothing — including the risk of the timing overhead skewing the very number it
            // reports — unless someone asks for it. The boot value: the PHY panel is created
            // at boot, and the profiler switches the measurement on at runtime while it shows
            // it (setPhysicsStepStatsEnabled).
            {
              key: 'stepStatsEnabled',
              target: stepStatsBootProxy,
              label: 'Track physics step time (reloads)',
              onChange: (value) => setBootOverride({ stepStatsEnabled: Boolean(value) }),
            },
            {
              key: 'transportMode',
              target: transportModeReadout,
              label: 'Resolved transport mode',
              readonly: true,
            },
            { type: 'separator' },

            // --- Live settings ---
            // Enable visualizer is still omitted: visualizerEnabled has no debugRender wiring
            // yet. 'EXTRAPOLATION' isn't offered below yet — reserved, not implemented.
            {
              key: 'timestep',
              label: 'Global timestep (1 / ts)',
              step: 1,
              min: 1,
              onChange: (value) => {
                state.timestepRatio = 1 / Number(value);
                if (isPhysicsWorldEnabled()) getPhysicsWorld().setTimestep(state.timestepRatio);
              },
            },
            { key: 'worldStepEnabled', label: 'Enable world step' },
            {
              key: 'gravity',
              label: 'Gravity',
              onChange: (value, e) => {
                state.gravity = copySetting(value as PhysicsState['gravity']);
                applySettingToWorld.gravity(state);
                recordSettingChange('gravity', e.prev as PhysicsState['gravity'], state.gravity);
              },
            },
            {
              key: 'solverIterations',
              label: 'Solver iterations',
              min: 1,
              step: 1,
              onChange: (value, e) => {
                applySettingToWorld.solverIterations(state);
                recordSettingChange('solverIterations', Number(e.prev), Number(value));
              },
            },
            {
              key: 'internalPgsIterations',
              label: 'Internal PGS iterations (run at each solver iteration)',
              min: 1,
              step: 1,
              onChange: (value, e) => {
                applySettingToWorld.internalPgsIterations(state);
                recordSettingChange('internalPgsIterations', Number(e.prev), Number(value));
              },
            },
            { type: 'separator' },
            {
              key: 'backgroundBehavior',
              label:
                'Background behavior (while the window is hidden — another tab, another window, minimized)',
              options: [
                { value: 'KEEP_RUNNING', text: 'Keep running' },
                {
                  value: 'KEEP_RUNNING_USE_MIN_DELTA',
                  text: 'Keep running, use minimum delta time',
                },
                { value: 'PAUSE', text: 'Pause' },
              ],
            },
            {
              key: 'minDeltaTimeHz',
              target: deltaTimeHzProxy,
              label:
                'Minimum delta time (as fps; used by "Keep running, use minimum delta time"), 0 = not in use',
              step: 1,
              min: 0,
              onChange: (value, e) => {
                state.minDeltaTime = Number(value) > 0 ? 1 / Number(value) : 0;
                if (e.last) persistDebuggerTabValue(TAB_ID, 'minDeltaTime');
              },
            },
            {
              key: 'maxDeltaTimeHz',
              target: deltaTimeHzProxy,
              label:
                'Maximum delta time (as fps; clamps a single frame’s contribution to the physics accumulator), 0 = not in use',
              step: 1,
              min: 0,
              onChange: (value, e) => {
                state.maxDeltaTime = Number(value) > 0 ? 1 / Number(value) : 0;
                if (e.last) persistDebuggerTabValue(TAB_ID, 'maxDeltaTime');
              },
            },
            {
              key: 'maxSubSteps',
              label:
                'Max sub-steps per frame (drops backlog beyond this instead of deferring it), 0 = not in use',
              step: 1,
              min: 0,
            },
            { type: 'separator' },
            // physicsInterpolationSystem (PhysicsManager.ts) returns early for
            // 'EXTRAPOLATION', so selecting it via AppConfig is safe but inert.
            {
              key: 'interpolationMode',
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
            },
            // Which pose moving bodies' collider wireframes follow: the raw physics pose shows
            // the interpolation offset (the mesh trails its wireframe while moving), the
            // rendered pose puts the wireframe on the mesh. Headless bodies have no mesh and
            // always show physics.
            {
              key: 'poseSource',
              target: wireframeProxies.pose,
              label: 'Wireframe pose (moving bodies)',
              options: [
                { value: 'PHYSICS', text: 'Physics (raw stepped pose)' },
                { value: 'RENDERED', text: 'Rendered (interpolated mesh pose)' },
              ],
              onChange: (value) => {
                setWireframePoseSource(value as WireframePoseSource);
                persistWireframeState();
              },
            },
            getInterpolationClockFolder(),
            { type: 'separator' },
            getDeterminismProbeFolder(),
            { type: 'separator' },
            getWireframeFolder(wireframeProxies),
          ],
        },
        debuggerListCMP({
          id: 'physicsEntities',
          heading: 'Physics entities',
          emptyText: 'No physics entities registered..',
          data: getPhysicsEntitiesListData,
          selectedItemId: () =>
            getDraggableWindowsOfKind(EDIT_PHYS_ENTITY_WIN_ID)
              .map((win) => getPhysWinEntityId(win.data))
              .filter((entityId) => entityId !== undefined)
              .map(String),
          perItemConfig: {
            onClick: toggleEditPhysicsEntityWindow,
            toggles: [
              { icon: 'rocket', title: 'Show wireframe', fn: togglePhysicsEntityWireframe },
            ],
          },
        }),
      ];
    },
  });

  // Hydrated at registration (the same values _hydratePhysicsLiveSettings restored at boot)
  state.timestepRatio = 1 / (state.timestep || 60);
};
