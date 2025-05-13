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
import { getRendererOptions } from './Renderer';
import { BladeController, View } from '@tweakpane/core';
import { FOUR_PX_TO_8K_LIST } from '../utils/constants';
import { getSvgIcon } from './UI/icons/SvgIcon';

export type Lights =
  | THREE.AmbientLight
  | THREE.HemisphereLight
  | THREE.PointLight
  | THREE.DirectionalLight;

export type LightProps = { id?: string; name?: string } & (
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

const lights: { [id: string]: Lights } = {};

/**
 * Creates a Three.js light
 * @param id (string) optional id for the light, if id is not provided the uuid of the light is used as id.
 * @param type ({@link LightProps.type}) required enum string that defines the type of light.
 * @param params ({@link LightProps.params}) optional light params, the params props depends on the type of the light.
 * @returns Three.js light
 */
export const createLight = ({ id, name, type, params }: LightProps) => {
  let light: Lights | null = null;

  if (id && lights[id]) return lights[id];

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
  lights[id || light.uuid] = light;

  updateLightsDebuggerGUI();

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

/**
 * Returns all created lights that exist
 * @returns array of Three.js lights
 */
export const getAllLights = () => lights;

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
  if (debuggerWindowCmp) debuggerWindowCmp.remove();
  if (!light) return CMP();

  addOnCloseToWindow(WIN_ID, () => {
    updateDebuggerLightsListSelectedClass('');
  });
  updateDebuggerLightsListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    tag: 'div',
    class: 'testing',
    onRemoveCmp: () => {
      debuggerWindowPane?.dispose();
      debuggerWindowPane = null;
    },
  });

  const type = light.userData.type;
  if (!type) return debuggerWindowCmp;

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () => `<button>${getSvgIcon('fileCode')}</button>`,
    onClick: () => {
      llog('LIGHT:****************', light, '**********************');
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () => `<button>${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      deleteLight(d.id);
      updateLightsDebuggerGUI();
      closeDraggableWindow(d.winId);
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
</div>
<div style="text-align:right">${logButton}${deleteButton}</div>
</div>`,
  });

  // Shared bindings
  if (light.userData.showHelper === undefined) light.userData.showHelper = false;
  if (type !== 'AMBIENT' && type !== 'HEMISPHERE') {
    debuggerWindowPane
      .addBinding(light.userData, 'showHelper', { label: 'Show helper' })
      .on('change', (e) => {
        const show = e.value;
        // @TODO: add helper
      });
  }
  debuggerWindowPane.addBinding(light, 'visible', { label: 'Enabled' });
  debuggerWindowPane.addBinding(light, 'intensity', { label: 'Intensity', step: 0.001 });

  if (type === 'AMBIENT') {
    const l = light as THREE.AmbientLight;
    debuggerWindowPane.addBinding(l, 'color', { label: 'Color', color: { type: 'float' } });
    return debuggerWindowCmp;
  }

  if (type === 'HEMISPHERE') {
    const l = light as THREE.HemisphereLight;
    debuggerWindowPane.addBinding(l, 'color', { label: 'Top color', color: { type: 'float' } });
    debuggerWindowPane.addBinding(l, 'groundColor', {
      label: 'Bottom color',
      color: { type: 'float' },
    });
    return debuggerWindowCmp;
  }

  if (type === 'DIRECTIONAL') {
    let l = light as THREE.DirectionalLight;
    debuggerWindowPane.addBinding(l, 'color', { label: 'Color', color: { type: 'float' } });
    debuggerWindowPane.addBinding(l, 'position', { label: 'Position' });
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

        shadowOptsBindings.forEach(
          (binding) => (binding.disabled = !renderOptions.enableShadows || !e.value)
        );
        l.castShadow = e.value; // @TODO: check if this is a bug in the WebGPU renderer, ask in three.js forum
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
      });
    const shadowFolder = debuggerWindowPane.addFolder({ title: 'Shadow', expanded: true });
    const shadowOptsBindings = [
      (
        shadowFolder.addBlade({
          view: 'list',
          label: 'Shadow map width',
          disabled: shadowOptionsEnabled,
          value: l.shadow.map?.width || 512,
          options: FOUR_PX_TO_8K_LIST,
        }) as ListBladeApi<BladeController<View>>
      ).on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

        const value = Number(e.value);
        const height = l.shadow.map?.width || 512;
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
      }),
      (
        shadowFolder.addBlade({
          view: 'list',
          label: 'Shadow map height',
          disabled: shadowOptionsEnabled,
          value: l.shadow.map?.height || 512,
          options: FOUR_PX_TO_8K_LIST,
        }) as ListBladeApi<BladeController<View>>
      ).on('change', (e) => {
        const curScene = getCurrentScene();
        if (!curScene) return;

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
      }),
      shadowFolder.addBinding(l.shadow, 'bias', {
        label: 'Shadow bias',
        disabled: shadowOptionsEnabled,
        step: 0.0001,
      }),
      shadowFolder.addBinding(l.shadow, 'normalBias', {
        label: 'Shadow normal bias',
        disabled: shadowOptionsEnabled,
        step: 0.0001,
      }),
      shadowFolder.addBinding(l.shadow, 'blurSamples', {
        label: 'Shadow blur samples',
        disabled: shadowOptionsEnabled,
      }),
      shadowFolder.addBinding(l.shadow, 'intensity', {
        label: 'Shadow intensity',
        disabled: shadowOptionsEnabled,
        step: 0.001,
      }),
      shadowFolder.addBinding(l.shadow, 'radius', {
        label: 'Shadow radius',
        disabled: shadowOptionsEnabled,
      }),
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
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'far', {
          label: 'Shadow camera far',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'left', {
          label: 'Shadow camera left',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'right', {
          label: 'Shadow camera right',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'top', {
          label: 'Shadow camera top',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
        }),
      shadowFolder
        .addBinding(l.shadow.camera, 'bottom', {
          label: 'Shadow camera bottom',
          disabled: shadowOptionsEnabled,
        })
        .on('change', () => {
          l.shadow.camera.updateProjectionMatrix();
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
        // @TODO: get draggable window state here and if open and data.id === keys[i], then close the window
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
  createDebuggerTab({
    id: 'lightsControls',
    buttonText: 'LIGHTS',
    title: 'Light controls',
    orderNr: 10,
    container: () => {
      const container = createNewDebuggerContainer('debuggerLights', 'Light Controls');
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
  if (winState) updateDraggableWindow(WIN_ID);
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
