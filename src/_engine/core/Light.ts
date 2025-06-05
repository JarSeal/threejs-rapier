import * as THREE from 'three/webgpu';
import { llog, lwarn } from '../utils/Logger';
import { createDebuggerTab, createNewDebuggerContainer } from '../debug/DebuggerGUI';
import { CMP, TCMP } from '../utils/CMP';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  updateDraggableWindow,
} from './UI/DraggableWindow';
import { ListBladeApi, Pane } from 'tweakpane';
import { isDebugEnvironment } from './Config';
import { getCurrentScene, getRootScene } from './Scene';
import { getRenderer, getRendererOptions } from './Renderer';
import { BladeController, View } from '@tweakpane/core';
import { FOUR_PX_TO_8K_LIST, RENDERER_SHADOW_OPTIONS } from '../utils/constants';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { toggleLightHelper } from './Helpers';
import { removeObjectAndChildrenFromMemory } from '../utils/helpers';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { updateOnScreenTools } from '../debug/OnScreenTools';

export type Lights =
  | THREE.AmbientLight
  | THREE.HemisphereLight
  | THREE.PointLight
  | THREE.DirectionalLight;

export type LightProps = { id?: string; name?: string; enabled?: boolean } & (
  | { type: 'AMBIENT'; params?: { color?: THREE.ColorRepresentation; intensity?: number } }
  | {
      type: 'HEMISPHERE';
      params?: {
        skyColor?: THREE.ColorRepresentation;
        groundColor?: THREE.ColorRepresentation;
        intensity?: number;
      };
    }
  | {
      type: 'POINT';
      params?: {
        color?: THREE.ColorRepresentation;
        intensity?: number;
        distance?: number;
        decay?: number;
        position?: { x: number; y: number; z: number };
        castShadow?: boolean;
        shadowMapSize?: number[];
        shadowCamNearFar?: number[];
        shadowBias?: number;
        shadowNormalBias?: number;
        /** Note: has no effect for PCFSoftShadowMap type */
        shadowBlurSamples?: number;
        /** Note: only for VSM shadowmap types */
        shadowRadius?: number;
        shadowIntensity?: number;
      };
    }
  | {
      type: 'DIRECTIONAL';
      params?: {
        color?: THREE.ColorRepresentation;
        intensity?: number;
        position?: { x: number; y: number; z: number };
        target?: { x: number; y: number; z: number };
        castShadow?: boolean;
        shadowMapSize?: number[];
        shadowCamNearFar?: number[];
        shadowCamLeftRightTopBottom?: number[];
        shadowBias?: number;
        shadowNormalBias?: number;
        /** Note: has no effect for PCFSoftShadowMap type */
        shadowBlurSamples?: number;
        /** Note: only for VSM shadowmap types */
        shadowRadius?: number;
        shadowIntensity?: number;
      };
    }
);

const LS_KEY = 'debugLights';
const lights: { [id: string]: Lights } = {};
let clearLSButton: TCMP | null = null;

/**
 * Creates a Three.js light
 * @param id (string) optional id for the light, if id is not provided the uuid of the light is used as id.
 * @param type ({@link LightProps.type}) required enum string that defines the type of light.
 * @param params ({@link LightProps.params}) optional light params, the params props depends on the type of the light.
 * @returns Three.js light
 */
export const createLight = ({ id, name, enabled, type, params }: LightProps) => {
  let light: Lights | null = null;

  if (id && lights[id]) {
    mergeLightDataFromLS(id);
    toggleLightHelper(lights[id].userData.id, Boolean(lights[id].userData.showHelper));
    return lights[id];
  }

  switch (type) {
    case 'AMBIENT':
      light = new THREE.AmbientLight(params?.color, params?.intensity);
      light.userData.type = 'AMBIENT';
      break;
    case 'HEMISPHERE':
      light = new THREE.HemisphereLight(params?.skyColor, params?.groundColor, params?.intensity);
      light.userData.type = 'HEMISPHERE';
      break;
    case 'POINT':
      light = new THREE.PointLight(
        params?.color,
        params?.intensity,
        params?.distance,
        params?.decay
      );
      light.userData.type = 'POINT';
      if (params?.position) {
        light.position.set(params.position.x, params.position.y, params.position.z);
      }
      // @TODO: @BUG: Three.js bug with VSMShadowMap and point light in WebGPU
      // Complete breakdown in WebGPU renderer when shadowMap type is VSMShadowMap and a point light tries to cast shadows.
      // Also breaks when forceWebGL is set to true but gives a different error. REPORT THIS!
      if (params?.castShadow === true) {
        light.castShadow = true;
        if (params.shadowMapSize) {
          light.shadow.mapSize.width = params.shadowMapSize[0] || 512;
          light.shadow.mapSize.height = params.shadowMapSize[1] || 512;
        }
        let shadowCamNear = 0.1;
        let shadowCamFar = 500;
        if (params.shadowCamNearFar) {
          shadowCamNear = params.shadowCamNearFar[0] || shadowCamNear;
          shadowCamFar = params.shadowCamNearFar[1] || shadowCamFar;
        }
        light.shadow.camera.near = shadowCamNear;
        light.shadow.camera.far = shadowCamFar;
        if (params.shadowBlurSamples !== undefined) {
          light.shadow.blurSamples = params.shadowBlurSamples;
        }
        if (params.shadowRadius !== undefined) light.shadow.radius = params.shadowRadius;
        if (params.shadowBias !== undefined) light.shadow.bias = params.shadowBias;
        if (params.shadowNormalBias !== undefined) {
          light.shadow.normalBias = params.shadowNormalBias;
        }
        if (params.shadowIntensity) light.shadow.intensity = params.shadowIntensity;
      } else {
        light.castShadow = false;
      }
      light.shadow.camera.updateProjectionMatrix();
      break;
    case 'DIRECTIONAL':
      light = new THREE.DirectionalLight(params?.color, params?.intensity);
      light.userData.type = 'DIRECTIONAL';
      if (params?.position) {
        light.position.set(params.position.x, params.position.y, params.position.z);
      }
      if (params?.target) {
        light.target.position.set(params.target.x, params.target.y, params.target.z);
      }
      if (params?.castShadow === true) {
        light.castShadow = true;
        if (params.shadowMapSize) {
          light.shadow.mapSize.width = params.shadowMapSize[0] || 512;
          light.shadow.mapSize.height = params.shadowMapSize[1] || 512;
        }
        let shadowCamNear = 0.1;
        let shadowCamFar = 2000;
        if (params.shadowCamNearFar) {
          shadowCamNear = params.shadowCamNearFar[0] || shadowCamNear;
          shadowCamFar = params.shadowCamNearFar[1] || shadowCamFar;
        }
        light.shadow.camera.near = shadowCamNear;
        light.shadow.camera.far = shadowCamFar;
        if (params.shadowCamLeftRightTopBottom) {
          light.shadow.camera.left = params.shadowCamLeftRightTopBottom[0] || -1;
          light.shadow.camera.right = params.shadowCamLeftRightTopBottom[1] || 1;
          light.shadow.camera.top = params.shadowCamLeftRightTopBottom[2] || 1;
          light.shadow.camera.bottom = params.shadowCamLeftRightTopBottom[3] || -1;
        }
        if (params.shadowBlurSamples !== undefined) {
          light.shadow.blurSamples = params.shadowBlurSamples;
        }
        if (params.shadowRadius !== undefined) light.shadow.radius = params.shadowRadius;
        if (params.shadowBias !== undefined) light.shadow.bias = params.shadowBias;
        if (params.shadowNormalBias !== undefined) {
          light.shadow.normalBias = params.shadowNormalBias;
        }
        if (params.shadowIntensity) light.shadow.intensity = params.shadowIntensity;
        light.shadow.camera.updateProjectionMatrix();
      } else {
        light.castShadow = false;
      }
      break;
  }

  if (!light) {
    throw new Error(`Could not create light (unknown type: '${type}').`);
  }

  light.userData.id = id || light.uuid;
  light.userData.name = name;
  if (enabled !== undefined) light.visible = enabled;
  lights[id || light.uuid] = light;

  mergeLightDataFromLS(id);
  toggleLightHelper(light.userData.id, Boolean(light.userData.showHelper));

  return light;
};

/**
 * Returns a light or undefined based on the id
 * @param id (string) light id
 * @returns Three.js light | undefined
 */
export const getLight = (id: string) => lights[id];

/**
 * Returns one or multiple lights based on the ids
 * @param id (array of strings) one or multiple light ids
 * @returns Array of Three.js lights
 */
export const getLights = (id: string[]) => id.map((lightId) => lights[lightId]);

/**
 * Returns all created lights that exist
 * @returns array of Three.js lights
 */
export const getAllLights = () => lights;

/**
 * Deletes a light based on an id
 * @param id (string) light id
 */
export const deleteLight = (id: string) => {
  const light = lights[id];
  if (!light) {
    lwarn(`Could not find light with id "${id}" in deleteLight(id).`);
    return;
  }

  light.removeFromParent();
  light.dispose();
  delete lights[id];

  updateLightsDebuggerGUI();
};

export const deleteAllInSceneLights = () => {
  const curScene = getCurrentScene();
  if (!curScene) return;
  const lightKeys = Object.keys(lights);
  for (let i = 0; i < lightKeys.length; i++) {
    const light = lights[lightKeys[i]];
    const foundLightInScene = curScene.getObjectById(light.id);
    if (foundLightInScene) deleteLight(light.userData.id);
  }
};

/**
 * Checks, with a light id, whether a light exists or not
 * @param id (string) light id
 * @returns boolean
 */
export const doesLightExist = (id: string) => Boolean(lights[id]);

// Debugger stuff for lights
// *************************

const getLightTypeShorthand = (type: string) => {
  switch (type) {
    case 'AMBIENT':
      return 'AL';
    case 'HEMISPHERE':
      return 'HL';
    case 'POINT':
      return 'PL';
    case 'DIRECTIONAL':
      return 'DL';
    case 'SPOT':
      return 'SL';
    default:
      return '??';
  }
};

let debuggerListCmp: TCMP | null = null;
let debuggerWindowCmp: TCMP | null = null;
let debuggerWindowPane: Pane | null = null;
const WIN_ID = 'lightEditorWindow';

export const createEditLightContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const light = lights[d.id];
  if (debuggerWindowPane) {
    debuggerWindowPane.dispose();
    debuggerWindowPane = null;
  }
  if (debuggerWindowCmp) debuggerWindowCmp.remove();
  if (!light) return CMP();

  addOnCloseToWindow(WIN_ID, () => {
    updateDebuggerLightsListSelectedClass('');
  });
  updateDebuggerLightsListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    onRemoveCmp: () => (debuggerWindowPane = null),
  });

  const type = light.userData.type;
  if (!type) return debuggerWindowCmp;

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  const copyCodeButton = CMP({
    class: 'winSmallIconButton',
    html: () => `<button title="Copy light creation script">${getSvgIcon('fileCode')}</button>`,
    onClick: () => {
      let paramsString = '';
      if (type === 'AMBIENT') {
        paramsString = `params: {
    color: '#${light.color.getHexString()}',
    intensity: ${light.intensity},
  },`;
      } else if (type === 'HEMISPHERE') {
        paramsString = `params: {
    skyColor: '#${light.color.getHexString()}',
    groundColor: '#${(light as THREE.HemisphereLight).groundColor.getHexString()}',
    intensity: ${light.intensity},
  },`;
      } else if (type === 'POINT') {
        paramsString = `params: {
    color: '#${light.color.getHexString()}',
    intensity: ${light.intensity},
    distance: ${(light as THREE.PointLight).distance},
    decay: ${(light as THREE.PointLight).decay},
    position: { x: ${light.position.x}, y: ${light.position.y}, z: ${light.position.z} },
    castShadow: ${light.castShadow},`;
        paramsString += light.shadow?.map
          ? `\n    shadowMapSize: [${light.shadow?.map?.width}, ${light.shadow?.map?.height}],`
          : '';
        const cam = light.shadow?.camera as THREE.PerspectiveCamera | undefined;
        paramsString += cam ? `\n    shadowCamNearFar: [${cam?.near}, ${cam?.far}],` : '';
        paramsString +=
          light.shadow?.bias !== undefined ? `\n    shadowBias: ${light.shadow?.bias},` : '';
        paramsString +=
          light.shadow?.normalBias !== undefined
            ? `\n    shadowNormalBias: ${light.shadow?.normalBias},`
            : '';
        paramsString +=
          light.shadow?.blurSamples !== undefined
            ? `\n    shadowBlurSamples: ${light.shadow?.blurSamples},`
            : '';
        paramsString +=
          light.shadow?.radius !== undefined ? `\n    shadowRadius: ${light.shadow?.radius},` : '';
        paramsString +=
          light.shadow?.intensity !== undefined
            ? `\n    shadowIntensity: ${light.shadow?.intensity},`
            : '';
        paramsString += '\n  },';
      } else if (type === 'DIRECTIONAL') {
        paramsString = `params: {
    color: '#${light.color.getHexString()}',
    intensity: ${light.intensity},
    position: { x: ${light.position.x}, y: ${light.position.y}, z: ${light.position.z} },
    target: { x: ${(light as THREE.DirectionalLight).target.position.x}, y: ${(light as THREE.DirectionalLight).target.position.y}, z: ${(light as THREE.DirectionalLight).target.position.z} },
    castShadow: ${light.castShadow},`;
        paramsString += light.shadow?.map
          ? `\n    shadowMapSize: [${light.shadow?.map?.width}, ${light.shadow?.map?.height}],`
          : '';
        const cam = light.shadow?.camera as THREE.OrthographicCamera | undefined;
        paramsString += cam ? `\n    shadowCamNearFar: [${cam?.near}, ${cam?.far}],` : '';
        paramsString += cam
          ? `\n    shadowCamLeftRightTopBottom: [${cam?.left}, ${cam?.right}, ${cam?.top}, ${cam?.bottom}],`
          : '';
        paramsString +=
          light.shadow?.bias !== undefined ? `\n    shadowBias: ${light.shadow?.bias},` : '';
        paramsString +=
          light.shadow?.normalBias !== undefined
            ? `\n    shadowNormalBias: ${light.shadow?.normalBias},`
            : '';
        paramsString +=
          light.shadow?.blurSamples !== undefined
            ? `\n    shadowBlurSamples: ${light.shadow?.blurSamples},`
            : '';
        paramsString +=
          light.shadow?.radius !== undefined ? `\n    shadowRadius: ${light.shadow?.radius},` : '';
        paramsString +=
          light.shadow?.intensity !== undefined
            ? `\n    shadowIntensity: ${light.shadow?.intensity},`
            : '';
        paramsString += '\n  },';
      }
      const createScript = `createLight({
  id: '${light.userData.id}',${light.userData.name ? `\n  name: '${light.userData.name}',` : ''}
  type: '${type}',${light.visible === false ? '\n  enabled: false,' : ''}
  ${paramsString}
});`;
      llog(createScript);
      navigator.clipboard.writeText(createScript);
      // @TODO: add toast that the script has been copied
    },
  });
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this light to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('LIGHT:****************', light, '**********************');
    },
  });
  const lightState = lsGetItem(LS_KEY, {})[light.userData.id];
  const lsIsEmpty =
    !lightState ||
    (lightState && Object.keys(lightState).length === 1 && lightState.saveToLS === false);
  clearLSButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Clear Local Storage params for this light">${getSvgIcon('databaseX')}</button>`,
    attr: lsIsEmpty ? { disabled: 'true' } : {},
    onClick: () => {
      const state = lsGetItem(LS_KEY, {});
      delete state[light.userData.id];
      lsSetItem(LS_KEY, state);
      updateLightsDebuggerGUI('WINDOW');
      // @TODO: add toast to tell that the Local Storage has been cleared for this light
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Remove light (only for this browser load, does not delete light permanently)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      deleteLight(d.id);
      updateLightsDebuggerGUI('LIST');
      closeDraggableWindow(WIN_ID);
      // @TODO: add toast to tell that the light has been deleted (but not permanently)
    },
  });

  debuggerWindowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Type:</span> ${light.userData.type || ''} (${getLightTypeShorthand(light.userData.type)})</div>
  <div><span class="winSmallLabel">Name:</span> ${light.userData.name || ''}</div>
  <div><span class="winSmallLabel">Id:</span> ${light.userData.id}</div>
  <div><span class="winSmallLabel">Shadows enabled:</span> ${getRenderer()?.shadowMap.enabled}</div>
  <div><span class="winSmallLabel">Shadow map type:</span> ${RENDERER_SHADOW_OPTIONS.find((opt) => opt.value === getRenderer()?.shadowMap.type)?.text || '[Not defined]'}</div>
</div>
<div style="text-align:right">${copyCodeButton}${logButton}${clearLSButton}${deleteButton}</div>
</div>`,
  });

  // Shared bindings
  if (light.userData.id) {
    if (light.userData.saveToLS === undefined) light.userData.saveToLS = false;
    debuggerWindowPane
      .addBinding(light.userData, 'saveToLS', { label: 'Save to LS' })
      .on('change', (e) => {
        light.userData.saveToLS = e.value;
        saveLightToLS(light.userData.id);
      });
    debuggerWindowPane.addBlade({ view: 'separator' });
  }

  if (light.userData.showHelper === undefined) {
    light.userData.showHelper = false;
  }
  if (type !== 'AMBIENT' && type !== 'HEMISPHERE') {
    debuggerWindowPane
      .addBinding(light.userData, 'showHelper', { label: 'Show helper' })
      .on('change', (e) => {
        toggleLightHelper(light.userData.id, e.value);
        light.userData.showHelper = e.value;
        saveLightToLS(light.userData.id);
        updateOnScreenTools('SWITCH');
      });
  }
  debuggerWindowPane.addBinding(light, 'visible', { label: 'Enabled' }).on('change', () => {
    saveLightToLS(light.userData.id);
  });
  debuggerWindowPane
    .addBinding(light, 'intensity', { label: 'Intensity', step: 0.001 })
    .on('change', () => {
      saveLightToLS(light.userData.id);
    });

  if (type === 'AMBIENT') {
    const l = light as THREE.AmbientLight;
    const color = { hex: l.color.getHex() };
    debuggerWindowPane
      .addBinding(color, 'hex', { label: 'Color', color: { type: 'float' } })
      .on('change', (e) => {
        l.color.setHex(e.value);
        saveLightToLS(l.userData.id);
      });
    return debuggerWindowCmp;
  }

  if (type === 'HEMISPHERE') {
    const l = light as THREE.HemisphereLight;
    const color = { hexColor: l.color.getHex(), hexGround: l.groundColor.getHex() };
    debuggerWindowPane
      .addBinding(color, 'hexColor', { label: 'Sky color', color: { type: 'float' } })
      .on('change', (e) => {
        l.color.setHex(e.value);
        saveLightToLS(l.userData.id);
      });
    debuggerWindowPane
      .addBinding(color, 'hexGround', {
        label: 'Ground color',
        color: { type: 'float' },
      })
      .on('change', (e) => {
        l.groundColor.setHex(e.value);
        saveLightToLS(l.userData.id);
      });
    return debuggerWindowCmp;
  }

  if (type === 'POINT') {
    let l = light as THREE.PointLight;
    const color = { hex: l.color.getHex() };
    debuggerWindowPane
      .addBinding(color, 'hex', { label: 'Color', color: { type: 'float' } })
      .on('change', (e) => {
        l.color.setHex(e.value);
        saveLightToLS(l.userData.id);
      });
    debuggerWindowPane
      .addBinding(l, 'position', { label: 'Position' })
      .on('change', () => saveLightToLS(l.userData.id));
    debuggerWindowPane.addBinding(l, 'distance', { label: 'Distance' });
    debuggerWindowPane.addBinding(l, 'decay', { label: 'Decay' });
    const renderOptions = getRendererOptions();
    const shadowOptionsEnabled = !(
      renderOptions.enableShadows &&
      renderOptions.shadowMapType !== THREE.VSMShadowMap && // @TODO: THERE IS A BUG IN Three.js WebGPU renderer with VSMShadowMap and PointLight, fix this when this works
      l.castShadow
    );
    debuggerWindowPane
      .addBinding(l, 'castShadow', {
        label: 'Cast shadow',
        disabled:
          !renderOptions.enableShadows || renderOptions.shadowMapType === THREE.VSMShadowMap, // @TODO: THERE IS A BUG IN Three.js WebGPU renderer with VSMShadowMap and PointLight, fix this when this works
      })
      .on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        // Hide helper temporarily
        if (l.userData.helperCreated) {
          toggleLightHelper(l.userData.id, false);
          const lightHelper = light.children.find(
            (child) => child.type === 'PointLightHelper'
          ) as THREE.PointLightHelper;
          if (lightHelper) removeObjectAndChildrenFromMemory(lightHelper);
          l.userData.helperCreated = false;
        }

        shadowOptsBindings.forEach(
          (binding) => (binding.disabled = !renderOptions.enableShadows || !e.value)
        );
        l.castShadow = e.value; // @TODO: check if this is a bug in the WebGPU renderer, ask in three.js forum (the shadows won't just turn on/off, we have to do this trick below)
        const newLight = l.clone(true);

        l.removeFromParent();
        l.dispose();
        if (l.uuid === l.userData.id) {
          delete lights[l.uuid];
          newLight.userData.id = newLight.uuid;
          lights[newLight.uuid] = newLight;
        } else {
          lights[newLight.userData.id] = newLight;
        }
        l = newLight;
        curScene.add(newLight);

        updateLightsDebuggerGUI('LIST');
        updateDebuggerLightsListSelectedClass(d.id);
        setTimeout(() => {
          updateLightsDebuggerGUI('WINDOW');
        }, 10);

        // Show camera helper for new light
        if (l.userData.showHelper) {
          toggleLightHelper(l.userData.id, true);
        }

        saveLightToLS(l.userData.id);
      });
    const shadowFolder = debuggerWindowPane.addFolder({ title: 'Shadow', expanded: true });
    const shadowOptsBindings = [
      (
        shadowFolder.addBlade({
          view: 'list',
          label: 'Shadow map width',
          disabled: shadowOptionsEnabled,
          value: l.shadow.mapSize.width || 512,
          options: FOUR_PX_TO_8K_LIST,
        }) as ListBladeApi<BladeController<View>>
      ).on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        // Hide helper temporarily
        if (l.userData.helperCreated) {
          toggleLightHelper(l.userData.id, false);
          const lightHelper = light.children.find(
            (child) => child.type === 'PointLightHelper'
          ) as THREE.PointLightHelper;
          if (lightHelper) removeObjectAndChildrenFromMemory(lightHelper);
          l.userData.helperCreated = false;
        }

        const value = Number(e.value);
        const height = l.shadow.mapSize.height || 512;
        l.shadow.mapSize.set(value, height);
        const newLight = l.clone(true);
        newLight.shadow.mapSize.set(value, height);

        l.removeFromParent();
        l.dispose();
        if (l.uuid === l.userData.id) {
          delete lights[l.uuid];
          newLight.userData.id = newLight.uuid;
          lights[newLight.uuid] = newLight;
        } else {
          lights[newLight.userData.id] = newLight;
        }
        l = newLight;
        curScene.add(newLight);

        updateLightsDebuggerGUI('LIST');
        updateDebuggerLightsListSelectedClass(d.id);
        setTimeout(() => {
          updateLightsDebuggerGUI('WINDOW');
        }, 10);

        // Show camera helper for new light
        if (l.userData.showHelper) {
          toggleLightHelper(l.userData.id, true);
        }

        saveLightToLS(l.userData.id);
      }),
      (
        shadowFolder.addBlade({
          view: 'list',
          label: 'Shadow map height',
          disabled: shadowOptionsEnabled,
          value: l.shadow.mapSize.height || 512,
          options: FOUR_PX_TO_8K_LIST,
        }) as ListBladeApi<BladeController<View>>
      ).on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        // Hide helper temporarily
        if (l.userData.helperCreated) {
          toggleLightHelper(l.userData.id, false);
          const lightHelper = light.children.find(
            (child) => child.type === 'PointLightHelper'
          ) as THREE.PointLightHelper;
          if (lightHelper) removeObjectAndChildrenFromMemory(lightHelper);
          l.userData.helperCreated = false;
        }

        const value = Number(e.value);
        const width = l.shadow.mapSize.width || 512;
        l.shadow.mapSize.set(width, value);
        const newLight = l.clone(true);
        newLight.shadow.mapSize.set(width, value);

        l.removeFromParent();
        l.dispose();
        if (l.uuid === l.userData.id) {
          delete lights[l.uuid];
          newLight.userData.id = newLight.uuid;
          lights[newLight.uuid] = newLight;
        } else {
          lights[newLight.userData.id] = newLight;
        }
        l = newLight;
        curScene.add(newLight);

        updateLightsDebuggerGUI('LIST');
        updateDebuggerLightsListSelectedClass(d.id);
        setTimeout(() => {
          updateLightsDebuggerGUI('WINDOW');
        }, 10);

        // Show camera helper for new light
        if (l.userData.showHelper) {
          toggleLightHelper(l.userData.id, true);
        }

        saveLightToLS(l.userData.id);
      }),
      shadowFolder
        .addBinding(l.shadow, 'bias', {
          label: 'Shadow bias',
          disabled: shadowOptionsEnabled,
          step: 0.0001,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'normalBias', {
          label: 'Shadow normal bias',
          disabled: shadowOptionsEnabled,
          step: 0.0001,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'blurSamples', {
          label: 'Shadow blur samples',
          disabled: shadowOptionsEnabled || renderOptions.shadowMapType === THREE.VSMShadowMap,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'intensity', {
          label: 'Shadow intensity',
          disabled: shadowOptionsEnabled,
          step: 0.001,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'radius', {
          label: 'Shadow radius',
          disabled: shadowOptionsEnabled || renderOptions.shadowMapType === THREE.BasicShadowMap,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder.addBlade({ view: 'separator' }),
      shadowFolder
        .addBinding(l.shadow.camera, 'near', {
          label: 'Shadow camera near',
          disabled: shadowOptionsEnabled,
          keyScale: 1,
          step: 0.0001,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'far', {
          label: 'Shadow camera far',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
    ];
    return debuggerWindowCmp;
  }

  if (type === 'DIRECTIONAL') {
    let l = light as THREE.DirectionalLight;
    const color = { hex: l.color.getHex() };
    debuggerWindowPane
      .addBinding(color, 'hex', { label: 'Color', color: { type: 'float' } })
      .on('change', (e) => {
        l.color.setHex(e.value);
        saveLightToLS(l.userData.id);
      });
    debuggerWindowPane.addBinding(l, 'position', { label: 'Position' }).on('change', () => {
      saveLightToLS(l.userData.id);
    });
    debuggerWindowPane.addBinding(l.target, 'position', { label: 'Target' }).on('change', (e) => {
      const curScene = getCurrentScene();
      if (!curScene) return;
      const value = e.value;
      let target = l.target;
      if (!target.userData.addedToScene) {
        target = new THREE.Object3D();
        target.userData.addedToScene = true;
        target.userData.id = `${l.userData.id}-target`;
        l.target = target;
        curScene.add(target);
      }
      target.position.set(value.x, value.y, value.z);
      saveLightToLS(l.userData.id);
    });
    const renderOptions = getRendererOptions();
    const shadowOptionsEnabled = !(renderOptions.enableShadows && l.castShadow);
    debuggerWindowPane
      .addBinding(l, 'castShadow', {
        label: 'Cast shadow',
        disabled: !renderOptions.enableShadows,
      })
      .on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        // Hide helpers temporarily
        if (l.userData.helperCreated) {
          toggleLightHelper(l.userData.id, false);
          const lightHelper = light.children.find(
            (child) => child.type === 'DirectionalLightHelper'
          ) as THREE.DirectionalLightHelper;
          if (lightHelper) removeObjectAndChildrenFromMemory(lightHelper);
          const cameraHelper = light.children.find(
            (child) => child.type === 'CameraHelper'
          ) as THREE.DirectionalLightHelper;
          if (cameraHelper) removeObjectAndChildrenFromMemory(cameraHelper);
          l.userData.helperCreated = false;
        }

        shadowOptsBindings.forEach(
          (binding) => (binding.disabled = !renderOptions.enableShadows || !e.value)
        );
        // @TODO: check if this is a bug in the WebGPU renderer, ask in three.js forum (the shadows won't just turn on/off, we have to do this trick below)
        // @NOTE: this has been fixed to the current dev branch, so refactor this when a new release of three.js is released
        l.castShadow = e.value;
        const newLight = l.clone(true);

        l.removeFromParent();
        l.dispose();
        if (l.uuid === l.userData.id) {
          delete lights[l.uuid];
          newLight.userData.id = newLight.uuid;
          lights[newLight.uuid] = newLight;
        } else {
          lights[newLight.userData.id] = newLight;
        }
        l = newLight;
        curScene.add(newLight);

        updateLightsDebuggerGUI('LIST');
        updateDebuggerLightsListSelectedClass(d.id);
        setTimeout(() => {
          updateLightsDebuggerGUI('WINDOW');
        }, 10);

        // Show camera helper for new light
        if (l.userData.showHelper) {
          toggleLightHelper(l.userData.id, true);
        }

        saveLightToLS(l.userData.id);
      });
    const shadowFolder = debuggerWindowPane.addFolder({ title: 'Shadow', expanded: true });
    const shadowOptsBindings = [
      (
        shadowFolder.addBlade({
          view: 'list',
          label: 'Shadow map width',
          disabled: shadowOptionsEnabled,
          value: l.shadow.mapSize.width || 512,
          options: FOUR_PX_TO_8K_LIST,
        }) as ListBladeApi<BladeController<View>>
      ).on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        // Hide helpers temporarily
        if (l.userData.helperCreated) {
          toggleLightHelper(l.userData.id, false);
          const lightHelper = light.children.find(
            (child) => child.type === 'DirectionalLightHelper'
          ) as THREE.DirectionalLightHelper;
          if (lightHelper) removeObjectAndChildrenFromMemory(lightHelper);
          const cameraHelper = light.children.find(
            (child) => child.type === 'CameraHelper'
          ) as THREE.DirectionalLightHelper;
          if (cameraHelper) removeObjectAndChildrenFromMemory(cameraHelper);
          l.userData.helperCreated = false;
        }

        const value = Number(e.value);
        const height = l.shadow.map?.height || 512;
        l.shadow.mapSize.set(value, height);
        l.shadow.map?.setSize(value, height);
        const newLight = l.clone(true);
        newLight.shadow.mapSize.set(value, height);
        newLight.shadow.map?.setSize(value, height);

        l.removeFromParent();
        l.dispose();
        if (l.uuid === l.userData.id) {
          delete lights[l.uuid];
          newLight.userData.id = newLight.uuid;
          lights[newLight.uuid] = newLight;
        } else {
          lights[newLight.userData.id] = newLight;
        }
        l = newLight;
        curScene.add(newLight);

        updateLightsDebuggerGUI('LIST');
        updateDebuggerLightsListSelectedClass(d.id);
        setTimeout(() => {
          updateLightsDebuggerGUI('WINDOW');
        }, 10);

        // Show camera helper for new light
        if (l.userData.showHelper) {
          toggleLightHelper(l.userData.id, true);
        }

        saveLightToLS(l.userData.id);
      }),
      (
        shadowFolder.addBlade({
          view: 'list',
          label: 'Shadow map height',
          disabled: shadowOptionsEnabled,
          value: l.shadow.mapSize.height || 512,
          options: FOUR_PX_TO_8K_LIST,
        }) as ListBladeApi<BladeController<View>>
      ).on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        // Hide helpers temporarily
        if (l.userData.helperCreated) {
          toggleLightHelper(l.userData.id, false);
          const lightHelper = light.children.find(
            (child) => child.type === 'DirectionalLightHelper'
          ) as THREE.DirectionalLightHelper;
          if (lightHelper) removeObjectAndChildrenFromMemory(lightHelper);
          const cameraHelper = light.children.find(
            (child) => child.type === 'CameraHelper'
          ) as THREE.DirectionalLightHelper;
          if (cameraHelper) removeObjectAndChildrenFromMemory(cameraHelper);
          l.userData.helperCreated = false;
        }

        const value = Number(e.value);
        const width = l.shadow.map?.width || 512;
        l.shadow.mapSize.set(width, value);
        l.shadow.map?.setSize(width, value);
        const newLight = l.clone(true);
        newLight.shadow.mapSize.set(width, value);
        newLight.shadow.map?.setSize(width, value);

        l.removeFromParent();
        l.dispose();
        if (l.uuid === l.userData.id) {
          delete lights[l.uuid];
          newLight.userData.id = newLight.uuid;
          lights[newLight.uuid] = newLight;
        } else {
          lights[newLight.userData.id] = newLight;
        }
        l = newLight;
        curScene.add(newLight);

        updateLightsDebuggerGUI('LIST');
        updateDebuggerLightsListSelectedClass(d.id);
        setTimeout(() => {
          updateLightsDebuggerGUI('WINDOW');
        }, 10);

        // Show camera helper for new light
        if (l.userData.showHelper) {
          toggleLightHelper(l.userData.id, true);
        }

        saveLightToLS(l.userData.id);
      }),
      shadowFolder
        .addBinding(l.shadow, 'bias', {
          label: 'Shadow bias',
          disabled: shadowOptionsEnabled,
          step: 0.0001,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'normalBias', {
          label: 'Shadow normal bias',
          disabled: shadowOptionsEnabled,
          step: 0.0001,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'blurSamples', {
          label: 'Shadow blur samples',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'intensity', {
          label: 'Shadow intensity',
          disabled: shadowOptionsEnabled,
          step: 0.001,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder
        .addBinding(l.shadow, 'radius', {
          label: 'Shadow radius',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => saveLightToLS(l.userData.id)),
      shadowFolder.addBlade({ view: 'separator' }),
      shadowFolder
        .addBinding(l.shadow.camera, 'near', {
          label: 'Shadow camera near',
          disabled: shadowOptionsEnabled,
          keyScale: 1,
          step: 0.0001,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'far', {
          label: 'Shadow camera far',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'left', {
          label: 'Shadow camera left',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'right', {
          label: 'Shadow camera right',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'top', {
          label: 'Shadow camera top',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'bottom', {
          label: 'Shadow camera bottom',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
          saveLightToLS(l.userData.id);
        }),
    ];
    return debuggerWindowCmp;
  }

  return debuggerWindowCmp;
};

const createLightsDebuggerList = () => {
  const keys = Object.keys(lights);
  let html = '<ul class="ulList">';
  let lightsInScene = false;

  for (let i = 0; i < keys.length; i++) {
    const light = lights[keys[i]];
    const rootScene = getRootScene();
    if (!rootScene) continue;
    const foundInScene = rootScene.getObjectByProperty('uuid', light.uuid);
    if (!foundInScene) continue;
    lightsInScene = true;

    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(WIN_ID);
        if (winState?.isOpen && winState?.data?.id === keys[i]) {
          closeDraggableWindow(WIN_ID);
          return;
        }
        openDraggableWindow({
          id: WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit light: ${light.userData.name || `[${light.userData.id}]`}`,
          isDebugWindow: true,
          content: createEditLightContent,
          data: { id: light.userData.id, WIN_ID },
          closeOnSceneChange: true,
        });
        updateDebuggerLightsListSelectedClass(keys[i]);
      },
      html: `<button class="listItemWithId">
  <span class="itemId">[${light.userData.id}]</span>
  <span title="${light.userData.type}">${getLightTypeShorthand(light.userData.type)}</span>
  <h4>${light.userData.name || `[${light.userData.id}]`}</h4>
</button>`,
    });

    html += `<li data-id="${keys[i]}">${button}</li>`;
  }

  if (!lightsInScene) html += `<li class="emptyState">No lights registered..</li>`;

  html += '</ul>';
  return html;
};

export const createLightsDebuggerGUI = () => {
  const icon = getSvgIcon('lightBulb');
  createDebuggerTab({
    id: 'lightsControls',
    buttonText: icon,
    title: 'Light controls',
    orderNr: 10,
    container: () => {
      const container = createNewDebuggerContainer('debuggerLights', `${icon} Light Controls`);
      debuggerListCmp = CMP({ id: 'debuggerLightsList', html: createLightsDebuggerList });
      container.add(debuggerListCmp);
      const winState = getDraggableWindow(WIN_ID);
      if (winState?.isOpen && winState.data?.id) {
        const id = (winState.data as { id: string }).id;
        updateDebuggerLightsListSelectedClass(id);
      }
      return container;
    },
  });
};

export const updateLightsDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!isDebugEnvironment()) return;
  if (only !== 'WINDOW') debuggerListCmp?.update({ html: createLightsDebuggerList });
  if (only === 'LIST') return;
  const winState = getDraggableWindow(WIN_ID);
  if (winState?.isOpen) updateDraggableWindow(WIN_ID);
};

export const updateDebuggerLightsListSelectedClass = (id: string) => {
  const ulElem = debuggerListCmp?.elem;
  if (!ulElem) return;

  for (const child of ulElem.children) {
    const elemId = child.getAttribute('data-id');
    if (elemId === id) {
      child.classList.add('selected');
      continue;
    }
    child.classList.remove('selected');
  }
};

export const mergeLightDataFromLS = (id: string | undefined) => {
  if (!isDebugEnvironment() || !id) return;

  const curState = lsGetItem(LS_KEY, {});
  if (id && curState[id]) {
    const state = curState[id];
    const light = lights[id];
    if (state.saveToLS !== undefined) light.userData.saveToLS = state.saveToLS;
    if (state.showHelper !== undefined) light.userData.showHelper = state.showHelper;
    if (state.visible !== undefined) light.visible = state.visible;
    if (state.intensity !== undefined) light.intensity = state.intensity;
    if (state.color !== undefined) light.color.setHex(Number(state.color));

    if (light.type === 'HemisphereLight') {
      if (state.groundColor !== undefined) {
        (light as THREE.HemisphereLight).groundColor.setHex(Number(state.groundColor));
      }
    } else if (light.type === 'PointLight') {
      const l = light as THREE.PointLight;
      if (state.position) l.position.set(state.position.x, state.position.y, state.position.z);
      if (state.distance !== undefined) l.distance = state.distance;
      if (state.decay !== undefined) l.decay = state.decay;
      if (state.castShadow !== undefined) l.castShadow = state.castShadow;
      if (state.shadowMapWidth !== undefined && state.shadowMapHeight !== undefined) {
        l.shadow.mapSize.set(state.shadowMapWidth, state.shadowMapHeight);
        l.shadow.map?.setSize(state.shadowMapWidth, state.shadowMapHeight);
      }
      if (state.shadowBias !== undefined) l.shadow.bias = state.shadowBias;
      if (state.shadowNormalBias !== undefined) l.shadow.normalBias = state.shadowNormalBias;
      if (state.shadowBlurSamples !== undefined) l.shadow.blurSamples = state.shadowBlurSamples;
      if (state.shadowIntensity !== undefined) l.shadow.intensity = state.shadowIntensity;
      if (state.shadowRadius !== undefined) l.shadow.radius = state.shadowRadius;
      if (state.shadowCameraNear !== undefined) l.shadow.camera.near = state.shadowCameraNear;
      if (state.shadowCameraFar !== undefined) l.shadow.camera.far = state.shadowCameraFar;
    } else if (light.type === 'DirectionalLight') {
      const l = light as THREE.DirectionalLight;
      if (state.position) l.position.set(state.position.x, state.position.y, state.position.z);
      if (state.target) {
        l.target.position.set(state.target.x, state.target.y, state.target.z);
      }
      if (state.castShadow !== undefined) l.castShadow = state.castShadow;
      if (state.shadowMapWidth !== undefined && state.shadowMapHeight !== undefined) {
        l.shadow.mapSize.set(state.shadowMapWidth, state.shadowMapHeight);
        l.shadow.map?.setSize(state.shadowMapWidth, state.shadowMapHeight);
      }
      if (state.shadowBias !== undefined) l.shadow.bias = state.shadowBias;
      if (state.shadowNormalBias !== undefined) l.shadow.normalBias = state.shadowNormalBias;
      if (state.shadowBlurSamples !== undefined) l.shadow.blurSamples = state.shadowBlurSamples;
      if (state.shadowIntensity !== undefined) l.shadow.intensity = state.shadowIntensity;
      if (state.shadowRadius !== undefined) l.shadow.radius = state.shadowRadius;
      if (state.shadowCameraNear !== undefined) l.shadow.camera.near = state.shadowCameraNear;
      if (state.shadowCameraFar !== undefined) l.shadow.camera.far = state.shadowCameraFar;
      if (state.shadowCameraLeft !== undefined) l.shadow.camera.left = state.shadowCameraLeft;
      if (state.shadowCameraRight !== undefined) l.shadow.camera.right = state.shadowCameraRight;
      if (state.shadowCameraTop !== undefined) l.shadow.camera.top = state.shadowCameraTop;
      if (state.shadowCameraBottom !== undefined) l.shadow.camera.bottom = state.shadowCameraBottom;
    }
  }
};

export const saveLightToLS = (id: string | undefined) => {
  if (!isDebugEnvironment || !id) return;
  const light = getLight(id);
  const rootScene = getRootScene();
  if (!light?.userData.id || !rootScene) return;
  const foundInScene = rootScene.getObjectByProperty('uuid', light.uuid);
  if (!foundInScene) return;

  const curState = lsGetItem(LS_KEY, {});
  if (!curState[id]) {
    if (!light?.userData.saveToLS) return;
    curState[id] = {};
  }

  curState[id].saveToLS = light.userData.saveToLS;
  curState[id].showHelper = light.userData.showHelper;
  curState[id].visible = light.visible;
  curState[id].intensity = light.intensity;
  curState[id].color = light.color.getHex();

  if (light.type === 'HemisphereLight') {
    curState[id].groundColor = (light as THREE.HemisphereLight).groundColor.getHex();
  } else if (light.type === 'PointLight') {
    const l = light as THREE.PointLight;
    curState[id].position = { x: l.position.x, y: l.position.y, z: l.position.z };
    curState[id].distance = l.distance;
    curState[id].decay = l.decay;
    curState[id].castShadow = l.castShadow;
    curState[id].shadowMapWidth = l.shadow.mapSize.width;
    curState[id].shadowMapHeight = l.shadow.mapSize.height;
    curState[id].shadowBias = l.shadow.bias;
    curState[id].shadowNormalBias = l.shadow.normalBias;
    curState[id].shadowBlurSamples = l.shadow.blurSamples;
    curState[id].shadowIntensity = l.shadow.intensity;
    curState[id].shadowRadius = l.shadow.radius;
    curState[id].shadowCameraNear = l.shadow.camera.near;
    curState[id].shadowCameraFar = l.shadow.camera.far;
  } else if (light.type === 'DirectionalLight') {
    const l = light as THREE.DirectionalLight;
    curState[id].position = { x: l.position.x, y: l.position.y, z: l.position.z };
    curState[id].target = {
      x: l.target.position.x,
      y: l.target.position.y,
      z: l.target.position.z,
    };
    curState[id].castShadow = l.castShadow;
    curState[id].shadowMapWidth = l.shadow.mapSize.width;
    curState[id].shadowMapHeight = l.shadow.mapSize.height;
    curState[id].shadowBias = l.shadow.bias;
    curState[id].shadowNormalBias = l.shadow.normalBias;
    curState[id].shadowBlurSamples = l.shadow.blurSamples;
    curState[id].shadowIntensity = l.shadow.intensity;
    curState[id].shadowRadius = l.shadow.radius;
    curState[id].shadowCameraNear = l.shadow.camera.near;
    curState[id].shadowCameraFar = l.shadow.camera.far;
    curState[id].shadowCameraLeft = l.shadow.camera.left;
    curState[id].shadowCameraRight = l.shadow.camera.right;
    curState[id].shadowCameraTop = l.shadow.camera.top;
    curState[id].shadowCameraBottom = l.shadow.camera.bottom;
  }

  lsSetItem(LS_KEY, curState);
  clearLSButton?.removeAttr('disabled');
};
