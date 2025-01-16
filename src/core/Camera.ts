import * as THREE from 'three/webgpu';
import { getWindowSize } from '../utils/Window';
import { lwarn } from '../utils/Logger';

const cameras: { [id: string]: THREE.PerspectiveCamera } = {};
let currentCamera: THREE.PerspectiveCamera | null = null;
let currentCameraId: string | null = null;

// @TODO: add JSDoc comment
export const createCamera = (
  id: string,
  opts?: { isCurrentCamera: boolean; fov?: number; near?: number; far?: number }
) => {
  const fov = opts?.fov || 45;
  const near = opts?.near || 0.1;
  const far = opts?.far || 1000;

  if (cameras[id]) {
    throw new Error(
      `Camera with id "${id}" already exists. Pick another id or delete the camera first before recreating it.`
    );
  }

  const windowSize = getWindowSize();
  const camera = new THREE.PerspectiveCamera(fov, windowSize.aspect, near, far);

  cameras[id] = camera;

  if (opts?.isCurrentCamera) setCurrentCamera(id);

  return camera;
};

// @TODO: add JSDoc comment
export const getCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) lwarn(`Could not find camera with id "${id}" in getCamera(id).`);
  return camera || null;
};

// @TODO: add JSDoc comment
export const deleteCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) {
    lwarn(`Could not find camera with id "${id}" in deleteCamera(id).`);
    return;
  }

  delete cameras[id];
};

// @TODO: add JSDoc comment
export const setCurrentCamera = (id: string) => {
  if (currentCameraId === id) return currentCamera;
  const nextCamera = id ? cameras[id] : null;
  if (!nextCamera) {
    lwarn(`Could not find camera with id "${id}" in setCurrentCamera(id).`);
    return currentCamera;
  }
  currentCameraId = id;
  currentCamera = nextCamera;
  return nextCamera;
};

// @TODO: add JSDoc comment
export const getCurrentCamera = () => currentCamera as THREE.PerspectiveCamera;

// @TODO: add JSDoc comment
export const getAllCameras = () => cameras;
