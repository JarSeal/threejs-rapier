import * as THREE from 'three/webgpu';
import { getWindowSize } from '../utils/Window';
import { lwarn } from '../utils/Logger';

const cameras: { [id: string]: THREE.PerspectiveCamera } = {};
let currentCamera: THREE.PerspectiveCamera | null = null;
let currentCameraId: string | null = null;

/**
 * Creates a perspective camera.
 * @param id camera id
 * @param opts optional camera configuration options: { isCurrentCamera?: boolean; fov?: number; near?: number; far?: number }
 * @returns THREE.PerspectiveCamera
 */
export const createCamera = (
  id: string,
  opts?: { isCurrentCamera?: boolean; fov?: number; near?: number; far?: number }
) => {
  if (cameras[id]) return cameras[id];

  const fov = opts?.fov !== undefined ? opts.fov : 45;
  const near = opts?.near || 0.1;
  const far = opts?.far || 1000;

  const windowSize = getWindowSize();
  const camera = new THREE.PerspectiveCamera(fov, windowSize.aspect, near, far);

  cameras[id] = camera;

  if (opts?.isCurrentCamera) setCurrentCamera(id);

  return camera;
};

/**
 * Returns a camera with an id.
 * @param id camera id
 * @returns THREE.PerspectiveCamera or null
 */
export const getCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) lwarn(`Could not find camera with id "${id}" in getCamera(id).`);
  return camera || null;
};

/**
 * Deletes a camera with an id.
 * @param id camera id
 */
export const deleteCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) {
    lwarn(`Could not find camera with id "${id}" in deleteCamera(id).`);
    return;
  }

  delete cameras[id];
};

/**
 * Sets a new current camera to be used in scene.
 * @param id camera id
 * @returns THREE.PerspectiveCamera
 */
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

/**
 * Return the current camera.
 * @returns THREE.PerspectiveCamera or null
 */
export const getCurrentCamera = () => currentCamera as THREE.PerspectiveCamera;

/**
 * Return the current camera id.
 * @returns string or null
 */
export const getCurrentCameraId = () => currentCameraId;

/**
 * Returns all cameras.
 * @returns object: { [id: string]: THREE.PerspectiveCamera }
 */
export const getAllCameras = () => cameras;

/**
 * Checks, with a camera id, whether a camera exists or not
 * @param id (string) camera id
 * @returns boolean
 */
export const doesCameraExist = (id: string) => Boolean(cameras[id]);
