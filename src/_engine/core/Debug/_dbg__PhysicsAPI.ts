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
import { DEBUG_PHYSICS_API_BOOT_LS_KEY } from '../Config';
import { ShapeType, type PhysicsState, type PhysicsWorkerTarget } from '../Physics/PhysicsAPITypes';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';

const LS_KEY = 'debugPhysicsApi';
const EDIT_PHYS_ENTITY_WIN_ID = 'physicsApiEntityEditorWindow';
const PHYSICS_ENTITY_COMPONENT_TYPES = [
  ComponentType.BODY_STATIC,
  ComponentType.BODY_DYNAMIC_VISUAL,
  ComponentType.BODY_DYNAMIC_HEADLESS,
] as const;

let debuggerEntityListCmp: TCMP | null = null;
let entityWindowCmp: TCMP | null = null;
let entityWindowPane: Pane | null = null;

type DebugPhysicsApiBoot = {
  workerTarget?: PhysicsWorkerTarget;
  useSAB?: boolean;
  maxBodies?: number;
};

const setBootOverride = (partial: DebugPhysicsApiBoot) => {
  const current = lsGetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, {}) as DebugPhysicsApiBoot;
  lsSetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, { ...current, ...partial });
  location.reload();
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

  return entityWindowCmp;
};

export const _createPhysicsAPIDebugGUI = () => {
  const state = getPhysicsState();
  const savedValues = lsGetItem(LS_KEY, state) as Partial<PhysicsState>;
  Object.assign(state, savedValues);

  const icon = getSvgIcon('rocketTakeoff');
  createDebuggerTab({
    id: 'physicsApiControls',
    buttonText: icon,
    title: 'Physics API controls',
    orderNr: 6,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY),
        onClear: () => lsRemoveItem(LS_KEY),
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

      const transportModeReadout = {
        transportMode: getResolvedTransportMode() ?? 'Not created yet',
      };
      const transportModeBinding = debugGUI.addBinding(transportModeReadout, 'transportMode', {
        label: 'Resolved transport mode',
        readonly: true,
      });
      // No create/delete-world hook to subscribe to — poll, same tradeoff as
      // the spatial grid debug panel's live readout (never cleared, same precedent).
      setInterval(() => {
        transportModeReadout.transportMode = getResolvedTransportMode() ?? 'Not created yet';
        transportModeBinding.refresh();
      }, 500);

      debugGUI.addBlade({ view: 'separator' });

      // --- Live settings ---

      debugGUI
        .addBinding(state, 'timestep', { label: 'Global timestep (1 / ts)', step: 1, min: 1 })
        .on('change', (e) => {
          state.timestepRatio = 1 / e.value;
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'worldStepEnabled', { label: 'Enable world step' })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'visualizerEnabled', {
          label: 'Enable visualizer (not yet wired to a 3D visualizer)',
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI.addBinding(state, 'gravity', { label: 'Gravity' }).on('change', (e) => {
        state.gravity = { ...e.value };
        lsSetItem(LS_KEY, state);
        if (isPhysicsWorldEnabled()) {
          getPhysicsWorld().setGravity(state.gravity);
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
          lsSetItem(LS_KEY, state);
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
          lsSetItem(LS_KEY, state);
          if (isPhysicsWorldEnabled()) {
            getPhysicsWorld().setNumInternalPgsIterations(e.value);
          }
        });
      debugGUI
        .addBinding(state, 'interpolationEnabled', { label: 'Enable interpolation' })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      const bgBehaviorDropDown = debugGUI.addBlade({
        view: 'list',
        label:
          'Background behavior (when the loop is not running or the window is hidden, not in view, another tab, or minimized)',
        options: [
          { value: 'KEEP_RUNNING', text: 'Keep running' },
          { value: 'KEEP_RUNNING_USE_MIN_DELTA', text: 'Keep running and use Minimum delta time' },
          { value: 'PAUSE', text: 'Pause' },
        ],
        value: state.backgroundBehavior,
      }) as ListBladeApi<BladeController<View>>;
      bgBehaviorDropDown.on('change', (e) => {
        state.backgroundBehavior = e.value as unknown as PhysicsState['backgroundBehavior'];
        lsSetItem(LS_KEY, state);
      });
      debugGUI
        .addBinding(state, 'minDeltaTime', {
          label: 'Minimum delta time (eg. 1 / 30fps), 0 = not in use',
          step: 0.0000000001,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'maxDeltaTime', {
          label: 'Maximum delta time (clamping to an fps, 1 / 10fps = 0.1), 0 = not in use',
          step: 0.0000000001,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'minSubSteps', {
          label: 'Minimum steps per render frame, 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'maxSubSteps', {
          label:
            'Maximum steps per render frame (Prevents the spiral of death, should usually be the same as timestep), 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });

      debuggerEntityListCmp = CMP({
        id: 'debuggerPhysicsApiEntityList',
        html: createPhysicsEntitiesDebugList,
      });
      container.add(debuggerEntityListCmp);
      // No entity create/delete hook to subscribe to — poll, same tradeoff as
      // the spatial grid debug panel's live readout (never cleared, same precedent).
      setInterval(() => {
        debuggerEntityListCmp?.update({ html: createPhysicsEntitiesDebugList });
      }, 500);

      return container;
    },
  });
};
