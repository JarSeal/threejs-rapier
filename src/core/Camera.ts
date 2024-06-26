import * as THREE from 'three';
import { getWindowSize } from '../utils/window';

const cameras: { [id: string]: THREE.Camera } = {};
let currentCamera: THREE.Camera | null = null;
let currentCameraId: string | null = null;

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

export const getCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find camera with id "${id}" in getCamera(id).`);
  }
  return camera || null;
};

export const deleteCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find camera with id "${id}" in deleteCamera(id).`);
    return;
  }

  delete cameras[id];
};

export const setCurrentCamera = (id: string) => {
  if (currentCameraId === id) return currentCamera;
  const nextCamera = id ? cameras[id] : null;
  if (!nextCamera) {
    // eslint-disable-next-line no-console
    console.warn(`Could not find camera with id "${id}" in setCurrentCamera(id).`);
    return currentCamera;
  }
  currentCameraId = id;
  currentCamera = nextCamera;
  return nextCamera;
};

export const getCurrentCamera = () => currentCamera as THREE.Camera;

export const getAllCameras = () => cameras;
