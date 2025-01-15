import * as THREE from 'three/webgpu';
import WebGL from 'three/addons/capabilities/WebGL.js';
import { getWindowSize } from '../utils/Window';
import { llog, lwarn } from '../utils/Logger';

let r: THREE.WebGPURenderer | null = null;
const ELEM_ID = 'mainCanvas';
const options: RendererOptions = {
  antialias: undefined,
  forceWebGL: undefined,
  devicePixelRatio: 1,
  currentApi: 'WebGL',
  currentApiIsWebGPU: false,
  currentApiIsWebGL: true,
};

type RendererOptions = {
  antialias?: boolean;
  forceWebGL?: boolean;
  devicePixelRatio?: number;
  currentApi: 'WebGL' | 'WebGL2' | 'WebGPU';
  currentApiIsWebGPU: boolean;
  currentApiIsWebGL: boolean;
};

// @TODO: add JSDoc comment
export const createRenderer = (opts?: Partial<RendererOptions>) => {
  const windowSize = getWindowSize();

  setRendererOptions(opts);
  llog('Render options', options);

  const renderer = new THREE.WebGPURenderer({
    antialias: options.antialias,
    forceWebGL: options.forceWebGL || options.currentApiIsWebGL,
  });
  renderer.setPixelRatio(options.devicePixelRatio);
  renderer.setSize(windowSize.width, windowSize.height);

  const canvasParentElem = getCanvasParentElem();
  canvasParentElem.appendChild(renderer.domElement);

  r = renderer;

  return renderer;
};

// @TODO: add JSDoc comment
export const getCanvasParentElem = () => {
  const canvasParentElem = document.getElementById(ELEM_ID);
  if (!canvasParentElem) {
    throw new Error(`Canvas parent element with id "${ELEM_ID}" was not found.`);
  }
  return canvasParentElem;
};

// @TODO: add JSDoc comment
export const getRenderer = () => r;

// @TODO: add JSDoc comment
export const deleteRenderer = () => {
  if (!r) {
    lwarn(`The renderer has not been created or it has been deleted, in deleteRenderer(id).`);
    return;
  }
  r.dispose();
  r = null;
};

const setRendererOptions = async (opts?: Partial<RendererOptions>) => {
  options.antialias = Boolean(opts?.antialias);
  options.forceWebGL = Boolean(opts?.forceWebGL);
  options.devicePixelRatio = opts?.devicePixelRatio || window?.devicePixelRatio || 1;
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

// @TODO: add JSDoc comment
export const getRendererOptions = () => options;
