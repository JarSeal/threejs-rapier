/**
 * An editor view's orbit camera (docs/plans/_DONE_p083_editor-creator-view.md DD7), written once for
 * every editor (material, particles, skybox, animation, …). A `PerspectiveCamera` with
 * `OrbitControls` on the canvas, owned by the view (not an ECS entity), and its
 * {@link ViewCameraRig}, which the axes gizmo follows, aligns and orbits.
 *
 * Wire it into a ViewDef: `getCamera: () => viewCam.camera`, `getCameraRig: () => viewCam.rig`,
 * and call `onEnter`, `onExit` and `mainUpdate` from the view's own. The controls take canvas
 * input only between `onEnter` and `onExit`.
 *
 * Pose memory, per view and per pose key: the key is the editor's subject (a material id, a
 * particle system id), `null` (the default) the view's own pose. A pose is saved when an
 * OrbitControls drag, pan or zoom ends, and when a gizmo align or drag ends (the rig's
 * `onMoveEnd`). The default store is LocalStorage `AEK_debugViewCams`; an editor that keeps
 * per-subject data in its own record passes a `store` that writes there. The Runtime view's
 * debug camera and its per-scene state (`AEK_debugCams`) are never touched.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { getCanvasElem, getRenderer } from '../../Renderer';
import type { ViewCameraRig } from '../../ViewManager';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { lwarn } from '../../../utils/Logger';

type XYZ = { x: number; y: number; z: number };

/** A view camera's pose: where it is, what it orbits, and its vertical field of view. */
export type ViewCameraPose = { position: XYZ; target: XYZ; fov: number };

/** Where a view camera keeps its poses (`key`: the pose key, `null` = the view's own pose). */
export type ViewCameraStore = {
  load: (key: string | null) => ViewCameraPose | null | undefined;
  save: (key: string | null, pose: ViewCameraPose) => void;
  /** No argument clears every pose of the view, `null` the view's own pose, a key that key's. */
  clear: (key?: string | null) => void;
};

export type ViewCameraOpts = {
  /** The view the camera belongs to (one view camera per view). */
  viewId: string;
  /** The pose of a key without a saved one (and of {@link ViewCamera.resetPose}). */
  defaultPose: ViewCameraPose;
  /** Default 0.1. */
  near?: number;
  /** Default 1000. */
  far?: number;
  /** Default: LocalStorage `AEK_debugViewCams`. */
  store?: ViewCameraStore;
};

export type ViewCamera = {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** For the view's `getCameraRig`. */
  rig: ViewCameraRig;
  /** Switches the pose key and applies its saved pose, or the default pose. */
  setPoseKey: (key: string | null) => void;
  getPoseKey: () => string | null;
  /** The camera's current pose (a new object). */
  getPose: () => ViewCameraPose;
  /** Applies the default pose and clears the current key's saved one. */
  resetPose: () => void;
  /** For the view's `onEnter`: enables the controls' input and fits the aspect. */
  onEnter: () => void;
  /** For the view's `onExit`: disables the controls' input. */
  onExit: () => void;
  /** For the view's `mainUpdate`: the controls' update and the aspect. */
  mainUpdate: () => void;
  /** Removes the controls' canvas listeners (eg. when the view is unregistered). */
  dispose: () => void;
};

/** The structure of 'AEK_debugViewCams' in LocalStorage. */
type ViewCamsLSData = {
  [viewId: string]: { view?: ViewCameraPose; keys?: Record<string, ViewCameraPose> };
};

const LS_KEY = 'AEK_debugViewCams';

/** The live view cameras by view id (for clearViewCameraPoses). */
const instances = new Map<
  string,
  { store: ViewCameraStore; applyDefaultPose: () => void; dispose: () => void }
>();

const isXYZ = (value: unknown): value is XYZ =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as XYZ).x) &&
  Number.isFinite((value as XYZ).y) &&
  Number.isFinite((value as XYZ).z);

/** Stored poses come from LocalStorage or an editor's own record, so they are checked. */
const isValidPose = (pose: unknown): pose is ViewCameraPose =>
  typeof pose === 'object' &&
  pose !== null &&
  isXYZ((pose as ViewCameraPose).position) &&
  isXYZ((pose as ViewCameraPose).target) &&
  Number.isFinite((pose as ViewCameraPose).fov);

const readLS = () => (lsGetItem(LS_KEY, {}) as ViewCamsLSData | null) ?? {};

const writeLS = (data: ViewCamsLSData) => {
  if (Object.keys(data).length) lsSetItem(LS_KEY, data);
  else lsRemoveItem(LS_KEY);
};

/** The default store: one record per view in 'AEK_debugViewCams'. */
const createLSStore = (viewId: string): ViewCameraStore => ({
  load: (key) => {
    const record = readLS()[viewId];
    return key === null ? record?.view : record?.keys?.[key];
  },
  save: (key, pose) => {
    const data = readLS();
    const record = (data[viewId] ??= {});
    if (key === null) record.view = pose;
    else (record.keys ??= {})[key] = pose;
    writeLS(data);
  },
  clear: (key) => {
    const data = readLS();
    const record = data[viewId];
    if (!record) return;
    if (key === undefined) {
      delete data[viewId];
    } else if (key === null) {
      delete record.view;
    } else if (record.keys) {
      delete record.keys[key];
      if (!Object.keys(record.keys).length) delete record.keys;
    }
    if (data[viewId] && !Object.keys(record).length) delete data[viewId];
    writeLS(data);
  },
});

const copyPose = (pose: ViewCameraPose): ViewCameraPose => ({
  position: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
  target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
  fov: pose.fov,
});

const _size = new THREE.Vector2();

/**
 * Creates an editor view's orbit camera, with its rig and pose memory (see the file comment).
 * One per view: a second one for the same view id replaces (and disposes) the first.
 * @param opts ({@link ViewCameraOpts})
 * @returns ({@link ViewCamera})
 */
export const createViewCamera = (opts: ViewCameraOpts): ViewCamera => {
  const { viewId } = opts;
  const defaultPose = copyPose(opts.defaultPose);
  const store = opts.store ?? createLSStore(viewId);

  const camera = new THREE.PerspectiveCamera(
    defaultPose.fov,
    1,
    opts.near ?? 0.1,
    opts.far ?? 1000
  );
  camera.name = `viewCamera_${viewId}`;
  const controls = new OrbitControls(camera, getCanvasElem());
  controls.enabled = false;

  let poseKey: string | null = null;
  let isEntered = false;
  let isControlsSuspended = false;

  const syncControlsEnabled = () => {
    controls.enabled = isEntered && !isControlsSuspended;
  };

  const getPose = (): ViewCameraPose => ({
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    fov: camera.fov,
  });

  const applyPose = (pose: ViewCameraPose) => {
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    if (camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
    controls.update();
  };

  const applyDefaultPose = () => applyPose(defaultPose);

  const applyKeyPose = () => {
    const saved = store.load(poseKey);
    applyPose(isValidPose(saved) ? saved : defaultPose);
  };

  const savePose = () => store.save(poseKey, getPose());

  /** The canvas's drawing size (no DOM read), so a resize is picked up on the next frame. */
  const fitAspect = () => {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.getSize(_size);
    if (!_size.y) return;
    const aspect = _size.x / _size.y;
    if (camera.aspect === aspect) return;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  };

  // OrbitControls' own drags, pans and zooms (the gizmo's moves end in rig.onMoveEnd)
  controls.addEventListener('end', savePose);

  const rig: ViewCameraRig = {
    camera,
    controls,
    setControlsSuspended: (suspended) => {
      isControlsSuspended = suspended;
      syncControlsEnabled();
    },
    onMoveEnd: savePose,
  };

  const dispose = () => {
    controls.removeEventListener('end', savePose);
    controls.dispose();
    if (instances.get(viewId)?.store === store) instances.delete(viewId);
  };

  const previous = instances.get(viewId);
  if (previous) {
    lwarn(`A view camera for view "${viewId}" already exists, in createViewCamera. Replacing it.`);
    previous.dispose();
  }
  instances.set(viewId, { store, applyDefaultPose, dispose });

  applyKeyPose();

  return {
    camera,
    controls,
    rig,
    setPoseKey: (key) => {
      poseKey = key;
      applyKeyPose();
    },
    getPoseKey: () => poseKey,
    getPose,
    resetPose: () => {
      store.clear(poseKey);
      applyDefaultPose();
    },
    onEnter: () => {
      isEntered = true;
      isControlsSuspended = false;
      syncControlsEnabled();
      fitAspect();
    },
    onExit: () => {
      isEntered = false;
      syncControlsEnabled();
    },
    mainUpdate: () => {
      fitAspect();
      // Every frame, also while the gizmo's drag suspends the input: it turns the camera to the
      // target after the gizmo moved it (like debugCameraSystem)
      controls.update();
    },
    dispose,
  };
};

/**
 * Clears every saved pose of a view's camera (an editor's clear-LS button), from its store, and
 * puts a live view camera back to its default pose.
 * @param viewId (string) the view id
 */
export const clearViewCameraPoses = (viewId: string) => {
  const instance = instances.get(viewId);
  if (!instance) {
    createLSStore(viewId).clear();
    return;
  }
  instance.store.clear();
  instance.applyDefaultPose();
};
