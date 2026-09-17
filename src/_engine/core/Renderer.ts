import * as THREE from 'three/webgpu';
import WebGL from 'three/addons/capabilities/WebGL.js';
import { getWindowSize } from '../utils/Window';
import { lerror, lwarn } from '../utils/Logger';
import { isDebugEnvironment } from './Config';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import { existsOrThrow } from '../utils/assert';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

let r: THREE.WebGPURenderer | null = null;
const ELEM_ID = 'mainCanvas';
const CANVAS_ID = 'AEK_CANVAS_ELEM';
const LS_KEY = 'debugRenderer';
let options: RendererOptions = {
  antialias: true,
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

export type RendererOptions = {
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
export const createRenderer = async (opts?: Partial<RendererOptions>) => {
  if (r) return r;

  const windowSize = getWindowSize();

  setRendererOptions(opts);

  const renderer = new THREE.WebGPURenderer({
    antialias: options.antialias,
    forceWebGL: options.currentApiIsWebGL || options.forceWebGL,
    alpha: options.alpha,
  });
  renderer.domElement.id = CANVAS_ID;
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

  await renderer.init();

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

export const getCanvasElem = () =>
  existsOrThrow(
    document.getElementById(CANVAS_ID),
    `Could not find a canvas element with id "${CANVAS_ID}".`
  );

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

export const isWebGPURenderer = () => options.currentApiIsWebGPU;
export const isWebGLRenderer = () => options.currentApiIsWebGL;

// Debug
type RendererGUIModule = typeof import('../core/Debug/_dbg__Renderer');
let debugGUI: DebugModuleRef<RendererGUIModule> | null = null;

export const createRendererDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__Renderer'));
  useDebug(debugGUI)?._createRendererDebugGUI(options, r, LS_KEY);
};
