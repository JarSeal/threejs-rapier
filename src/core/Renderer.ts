import * as THREE from 'three';
import { getWindowSize } from '../utils/window';

let r: THREE.WebGLRenderer | null = null;
const ELEM_ID = 'mainCanvas';

export const createRenderer = () => {
  const windowSize = getWindowSize();

  const renderer = new THREE.WebGLRenderer();
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
