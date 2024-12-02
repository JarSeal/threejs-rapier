import * as THREE from 'three/webgpu';
import { getWindowSize } from '../utils/window';
import { llog } from '../utils/Logger';

let r: THREE.WebGPURenderer | null = null;
const ELEM_ID = 'mainCanvas';
const options: { antialias?: boolean; forceWebGL?: boolean; devicePixelRatio: number } = {
  antialias: undefined,
  forceWebGL: undefined,
  devicePixelRatio: 1,
};

type RendererOptions = {
  antialias?: boolean;
  forceWebGL?: boolean;
  devicePixelRatio?: number;
};

export const createRenderer = (opts?: RendererOptions) => {
  const windowSize = getWindowSize();

  setRendererOptions(opts);
  llog('Render options', options);

  const renderer = new THREE.WebGPURenderer({
    antialias: options.antialias,
    forceWebGL: options.forceWebGL,
  });
  renderer.setPixelRatio(options.devicePixelRatio);
  renderer.setSize(windowSize.width, windowSize.height);

  const canvasElem = document.getElementById(ELEM_ID);
  if (!canvasElem) {
    throw new Error(`Canvas element with id "${ELEM_ID}" was not found.`);
  }
  canvasElem.appendChild(renderer.domElement);

  r = renderer;

  return renderer;
};

export const getRenderer = () => {
  if (!r) {
    // eslint-disable-next-line no-console
    console.warn(`The renderer has not been created or it has been deleted, in getRenderer().`);
  }
  return r;
};

export const deleteRenderer = () => {
  if (!r) {
    // eslint-disable-next-line no-console
    console.warn(
      `The renderer has not been created or it has been deleted, in deleteRenderer(id).`
    );
    return;
  }
  r.dispose();
  r = null;
};

const setRendererOptions = (opts?: RendererOptions) => {
  options.antialias = Boolean(opts?.antialias);
  options.forceWebGL = Boolean(opts?.forceWebGL);
  options.devicePixelRatio = opts?.devicePixelRatio || window?.devicePixelRatio || 1;
};

export const getRendererOptions = () => options;
