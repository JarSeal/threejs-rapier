import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import { getECSWorld, ECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { CMP, TCMP } from '../../../utils/CMP';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerContainer } from '../../../debug/DebuggerGUI';
import { openDraggableWindow } from '../../UI/DraggableWindow';
import { setTransform } from '../../../utils/ECSHelpers';

export const EDIT_LIGHT_WIN_ID = 'lightEditorWindow';
let debuggerListCmp: TCMP | null = null;

const getLightTypeShorthand = (world: ECSWorld, entityId: number) => {
  if (world.hasComponent(entityId, ComponentType.TAG_IS_POINT_LIGHT)) return 'PL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_DIRECTIONAL_LIGHT)) return 'DL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_SPOT_LIGHT)) return 'SL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_AMBIENT_LIGHT)) return 'AL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_HEMISPHERE_LIGHT)) return 'HL';
  return '??';
};

/** Logic for the Edit Light Draggable Window */
export const createEditLightContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: number; winId: string };
  const world = getECSWorld();
  const entityId = d.id;

  if (!world.isAlive(entityId)) return CMP({ text: 'Entity no longer exists' });

  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;

  if (!objComp || !(objComp.value instanceof THREE.Light)) return CMP();

  const light = objComp.value;
  const container = CMP({ onRemoveCmp: () => pane.dispose() });
  const pane = new Pane({ container: container.elem });

  // Header Info
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">ID:</span> ${entityId}</div>
      <div><span class="winSmallLabel">AppID:</span> ${appId || 'None'}</div>
      <div><span class="winSmallLabel">Type:</span> ${light.type}</div>
    </div>`,
  });

  // Tweakpane Bindings
  pane.addBinding(light, 'visible', { label: 'Enabled' });
  pane.addBinding(light, 'intensity', { label: 'Intensity', min: 0, step: 0.1 });

  if ('color' in light) {
    pane.addBinding(light, 'color', { label: 'Color', view: 'color' });
  }

  // Sync Position to ECS Transform
  if (transform) {
    pane
      .addBinding(transform, 'position', {
        label: 'Position',
      })
      .on('change', (e) => {
        // Only trigger if the change came from the UI (manual dragging)
        // to avoid the double-trigger from setTransform calls.
        if (!e.last) return;

        setTransform(entityId, { pos: transform.position });

        const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
        if (helper && 'update' in helper.value) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (helper.value as any).update();
        }
      });
  }

  // Shadow Logic
  if (light.castShadow !== undefined) {
    pane.addBinding(light, 'castShadow', { label: 'Cast Shadow' });
  }

  return container;
};

/** Creates the Tab in the Debug Drawer */
export const initLightDebuggerGUI = () => {
  const icon = getSvgIcon('lightBulb');
  createDebuggerTab({
    id: 'lightsControls',
    buttonText: icon,
    title: 'Light controls',
    orderNr: 10,
    container: () => {
      const container = createNewDebuggerContainer('debuggerLights', `${icon} Light Controls`);
      debuggerListCmp = CMP({
        id: 'debuggerLightsList',
        html: () => createLightsDebuggerList(getECSWorld()),
      });
      container.add(debuggerListCmp);
      return container;
    },
  });
};

const createLightsDebuggerList = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.TAG_IS_LIGHT);
  let html = '<ul class="ulList">';

  for (const [entityId] of storage) {
    const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id || entityId;
    const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);
    const typeShorthand = getLightTypeShorthand(world, entityId);

    const button = CMP({
      onClick: () => {
        openDraggableWindow({
          id: EDIT_LIGHT_WIN_ID,
          title: `Edit Light: ${appId}`,
          isDebugWindow: true,
          content: createEditLightContent,
          data: { id: entityId, winId: EDIT_LIGHT_WIN_ID },
          closeOnSceneChange: true,
        });
      },
      html: `<button class="listItemWithId">
        <span class="itemId">[${appId}] [${entityId}]</span>
        <span>${typeShorthand}</span>
        <h4${!debugData?.name ? ` style="font-style:italic"` : ''}>${debugData?.name || appId}</h4>
      </button>`,
    });

    html += `<li>${button}</li>`;
  }

  if (storage.size === 0) html += `<li class="emptyState">No ECS lights found.</li>`;
  html += '</ul>';
  return html;
};

export const updateLightsDebuggerGUI = () => {
  if (debuggerListCmp) debuggerListCmp.update();
};
