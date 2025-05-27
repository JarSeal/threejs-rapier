import * as THREE from 'three/webgpu';
import WebGL from 'three/addons/capabilities/WebGL.js';
import { getWindowSize } from '../utils/Window';
import { lerror, lwarn } from '../utils/Logger';
import { isDebugEnvironment } from './Config';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { createDebuggerTab, createNewDebuggerPane } from '../debug/DebuggerGUI';
import { ListBladeApi } from 'tweakpane';
import { BladeController, View } from '@tweakpane/core';
import { updateLightsDebuggerGUI } from './Light';
import { RENDERER_SHADOW_OPTIONS } from '../utils/constants';
import { getSvgIcon } from './UI/icons/SvgIcon';

let r: THREE.WebGPURenderer | null = null;
const ELEM_ID = 'mainCanvas';
const LS_KEY = 'debugRenderer';
let options: RendererOptions = {
  antialias: undefined,
  forceWebGL: false,
  devicePixelRatio: 1,
  currentApi: 'WebGL',
  currentApiIsWebGPU: false,
  currentApiIsWebGL: true,
  toneMapping: THREE.NoToneMapping,
  toneMappingExposure: 1,
  outputColorSpace: THREE.SRGBColorSpace,
  alpha: false,
  enableShadows: false,
  shadowMapType: THREE.BasicShadowMap,
};

type RendererOptions = {
  antialias?: boolean;
  forceWebGL?: boolean;
  devicePixelRatio?: number;
  currentApi: 'WebGL' | 'WebGL2' | 'WebGPU';
  currentApiIsWebGPU: boolean;
  currentApiIsWebGL: boolean;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: THREE.ColorSpace;
  alpha?: boolean;
  enableShadows?: boolean;
  shadowMapType?: THREE.ShadowMapType;
};

/**
 * Creates a Three.js WebGPU renderer
 * @param opts (object) optional render options object {@link RendererOptions}
 * @returns THREE.WebGPURenderer
 */
export const createRenderer = (opts?: Partial<RendererOptions>) => {
  if (r) return r;

  const windowSize = getWindowSize();

  setRendererOptions(opts);

  const renderer = new THREE.WebGPURenderer({
    antialias: options.antialias,
    forceWebGL: options.currentApiIsWebGL || options.forceWebGL,
    alpha: options.alpha,
  });
  renderer.toneMapping = options.toneMapping;
  renderer.toneMappingExposure = options.toneMappingExposure;
  renderer.outputColorSpace = options.outputColorSpace;
  renderer.debug.checkShaderErrors = isDebugEnvironment();

  renderer.shadowMap.enabled = options.enableShadows || false;
  if (opts?.shadowMapType) renderer.shadowMap.type = options.shadowMapType || THREE.BasicShadowMap;

  renderer.setPixelRatio(options.devicePixelRatio || window.devicePixelRatio);
  renderer.setSize(windowSize.width, windowSize.height);

  const canvasParentElem = getCanvasParentElem();
  canvasParentElem.appendChild(renderer.domElement);

  r = renderer;

  return renderer;
};

/**
 * Returns the canvas parent element in the DOM which the canvas is in
 * @returns HTMLElement
 */
export const getCanvasParentElem = () => {
  const canvasParentElem = document.getElementById(ELEM_ID);
  if (!canvasParentElem) {
    throw new Error(`Canvas parent element with id "${ELEM_ID}" was not found.`);
  }
  return canvasParentElem;
};

/**
 * Returns the initialized renderer or null
 * @param throwOnError (boolean) optional flag to throw if renderer is not defined
 * @returns THREE.WebGPURenderer | null
 */
export const getRenderer = (throwOnError?: boolean) => {
  if (!r && throwOnError) {
    const msg = 'Renderer is not defined (not created) in getRenderer.';
    lerror(msg);
    throw new Error(msg);
  }
  return r;
};

/**
 * Deletes the initialized renderer
 */
export const deleteRenderer = () => {
  if (!r) {
    lwarn(`The renderer has not been created or it has been deleted, in deleteRenderer(id).`);
    return;
  }
  r.dispose();
  r = null;
};

const setRendererOptions = async (opts?: Partial<RendererOptions>) => {
  options = { ...options, ...opts };
  options.antialias = Boolean(opts?.antialias);
  options.forceWebGL = Boolean(opts?.forceWebGL);
  options.devicePixelRatio = opts?.devicePixelRatio || window?.devicePixelRatio || 1;

  if (isDebugEnvironment()) {
    const savedOptions = lsGetItem(LS_KEY, options);
    options = { ...options, ...opts, ...savedOptions };
  }

  if (!options.forceWebGL && navigator.gpu) {
    options.currentApi = 'WebGPU';
    options.currentApiIsWebGPU = true;
    options.currentApiIsWebGL = false;
  } else {
    options.currentApi = WebGL.isWebGL2Available() ? 'WebGL2' : 'WebGL';
    options.currentApiIsWebGPU = false;
    options.currentApiIsWebGL = true;
  }
};

/**
 * Returns render options object
 * @returns (object) {@link RendererOptions}
 */
export const getRendererOptions = () => options;

export const createRendererDebugGUI = () => {
  const savedOptions = lsGetItem(LS_KEY, options);
  options = { ...options, ...savedOptions };

  const icon = getSvgIcon('gpuCard');
  createDebuggerTab({
    id: 'rendererControls',
    buttonText: icon,
    title: 'Renderer controls',
    orderNr: 7,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane(
        'renderer',
        `${icon} Renderer Controls`
      );

      // Antialias
      debugGUI
        .addBinding(options, 'antialias', { label: 'Antialias (reloads)' })
        .on('change', () => {
          lsSetItem(LS_KEY, options);
          location.reload();
        });
      // Force WebGL
      debugGUI
        .addBinding(options, 'forceWebGL', { label: 'Force WebGL (reloads)' })
        .on('change', () => {
          lsSetItem(LS_KEY, options);
          location.reload();
        });
      // Device pixel ratio
      debugGUI
        .addBinding(options, 'devicePixelRatio', {
          label: `Device pixel ratio (${window?.devicePixelRatio})`,
          step: 0.5,
          min: 1,
          max: 4,
        })
        .on('change', () => {
          r?.setPixelRatio(options.devicePixelRatio);
          lsSetItem(LS_KEY, options);
        });
      // Tone mapping
      const toneMappingDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Tone mapping',
        options: [
          { value: THREE.NoToneMapping, text: 'No tone mapping' },
          { value: THREE.LinearToneMapping, text: 'Linear' },
          { value: THREE.ReinhardToneMapping, text: 'Reinhard' },
          { value: THREE.CineonToneMapping, text: 'Cineon' },
          { value: THREE.ACESFilmicToneMapping, text: 'ACES Filmic' },
          { value: THREE.CustomToneMapping, text: 'Custom' },
          { value: THREE.AgXToneMapping, text: 'AgX' },
          { value: THREE.NeutralToneMapping, text: 'Neutral' },
        ],
        value: options.toneMapping,
      }) as ListBladeApi<BladeController<View>>;
      toneMappingDropDown.on('change', (e) => {
        const value = Number(e.value);
        options.toneMapping = value as THREE.ToneMapping;
        if (r) r.toneMapping = options.toneMapping;
        lsSetItem(LS_KEY, options);
      });
      // Tone mapping exposure
      debugGUI
        .addBinding(options, 'toneMappingExposure', {
          label: 'Tone mapping exposure',
          step: 0.005,
          min: 0,
          max: 50,
        })
        .on('change', () => {
          if (r) r.toneMappingExposure = options.toneMappingExposure;
          lsSetItem(LS_KEY, options);
        });
      // Output color space
      const outputColorSpaceDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Output color space',
        options: [
          { value: THREE.NoColorSpace, text: 'No color space' },
          { value: THREE.SRGBColorSpace, text: 'SRGB' },
          { value: THREE.LinearSRGBColorSpace, text: 'Linear SRGB' },
        ],
        value: options.outputColorSpace,
      }) as ListBladeApi<BladeController<View>>;
      outputColorSpaceDropDown.on('change', (e) => {
        const value = String(e.value);
        options.outputColorSpace = value as THREE.ColorSpace;
        if (r) r.outputColorSpace = options.outputColorSpace;
        lsSetItem(LS_KEY, options);
      });
      // Enable alpha
      debugGUI.addBinding(options, 'alpha', { label: 'Enable alpha' }).on('change', () => {
        if (r) r.alpha = Boolean(options.alpha);
        lsSetItem(LS_KEY, options);
      });
      // Enable shadows
      debugGUI
        .addBinding(options, 'enableShadows', { label: 'Enable shadows' })
        .on('change', () => {
          if (r) r.shadowMap.enabled = Boolean(options.enableShadows);
          updateLightsDebuggerGUI();
          lsSetItem(LS_KEY, options);
        });
      // Shadow map type
      const shadowMapTypeDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Shadow map type (reloads)',
        options: RENDERER_SHADOW_OPTIONS,
        value: options.shadowMapType,
      }) as ListBladeApi<BladeController<View>>;
      shadowMapTypeDropDown.on('change', (e) => {
        const value = Number(e.value);
        options.shadowMapType = value as THREE.ShadowMapType;
        if (r) r.shadowMap.type = options.shadowMapType;
        lsSetItem(LS_KEY, options);
        location.reload();
      });

      return container;
    },
  });
};
