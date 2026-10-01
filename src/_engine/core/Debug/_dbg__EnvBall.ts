/**
 * Environment ball (docs/plans/p115_debug-environment-ball-viewport.md): a reflective sphere in
 * the top-right viewport stack, left of the axes gizmo, showing the environment map PBR
 * materials sample (the PMREM, not the background). It is a core viewport (Viewports.ts) with
 * a private scene: one unlit sphere sampling the PMREM along the reflection vector at the
 * "Env ball roughness" (0 = mirror, 1 = fully diffuse), so it shows the map itself, with no
 * lights involved. Its camera turns with the active camera, so the ball shows what that camera
 * would see reflected.
 *
 * Visibility: `show && there is an environment && (debug camera active || showInMainCamera)`,
 * evaluated every frame by a MAIN-stage system (a boolean compare, the viewport only changes on
 * a transition). While not visible, the viewport is disabled and costs nothing.
 */
import * as THREE from 'three/webgpu';
import { pmremTexture, reflectVector, uniform } from 'three/tsl';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { getActiveCamera, isDebugCameraActive } from '../CameraManager';
import { getRootScene } from '../Scene';
import { getActiveEnvironmentTexture, getActiveSkyBox, onSkyBoxChange } from '../SkyBox/SkyBox';
import { isBaseFlipY, turnUpsideDown } from '../SkyBox/layers/base';
import { createViewport, setViewportEnabled } from '../Viewports';
import styles from './EnvBall.module.scss';

export type EnvBallOpts = { show: boolean; showInMainCamera: boolean; roughness: number };

const VIEWPORT_ID = 'aekEnvBall';

const CAMERA_FOV = 25;
/** The unit sphere fills the view, with a small margin. */
const CAMERA_DISTANCE = 1.06 / Math.sin(THREE.MathUtils.degToRad(CAMERA_FOV / 2));

let isInitialized = false;
let showBall = false;
let showInMainCamera = false;
let isVisible = false;

let ballCamera: THREE.PerspectiveCamera | null = null;
let ballMaterial: THREE.MeshBasicNodeMaterial | null = null;
/** The PMREM the ball samples (the root scene's environment), or null. */
let envTexture: THREE.Texture | null = null;
/** Whether the ball's lookup is turned upside down (see syncEnvironment). */
let isEnvFlipY = false;
const uRoughness = uniform(0);

// Scratch objects (no per-frame allocations)
const _cameraQuat = new THREE.Quaternion();

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.MAIN, 'envBallSystem', envBallSystem);
});

/** Visibility. Plugins run per world: the ball is global, so only the default world drives it. */
function envBallSystem(world: ECSWorld) {
  if (!isInitialized || world !== getECSWorld()) return;
  const visible = showBall && envTexture !== null && (showInMainCamera || isDebugCameraActive());
  if (visible !== isVisible) {
    isVisible = visible;
    setViewportEnabled(VIEWPORT_ID, visible);
  }
}

/** Points the ball at the active sky box's environment. A new node per texture, never a
 * `.value` swap: re-pointing a PMREMNode at another target left stale bindings on WebGL2 (the
 * env bake's own node is never re-pointed either, SkyEnvironment.ts). A re-bake renders into
 * the same target, so the ball follows it without a new node. A direct-path cube's flipY is
 * not in its PMREM but in the root scene's environment node (layers/base.ts), so the ball's
 * lookup gets the same flip; the composite path bakes it in. */
const syncEnvironment = () => {
  const texture = getActiveEnvironmentTexture();
  const active = getActiveSkyBox();
  const flipY = Boolean(active && !active.isComposite && isBaseFlipY(active.def.base));
  if (texture === envTexture && flipY === isEnvFlipY) return;
  envTexture = texture;
  isEnvFlipY = flipY;
  if (!texture || !ballMaterial) return;
  const lookupDir = flipY ? turnUpsideDown(reflectVector) : reflectVector;
  ballMaterial.colorNode = pmremTexture(texture, lookupDir, uRoughness);
  ballMaterial.needsUpdate = true;
};

/** Follows the active camera's world rotation, orbiting the ball at a fixed distance, and the
 * root scene's environment rotation (the ball scene has no environment of its own, so
 * PMREMNode applies the material's envMapRotation). */
const updateBall = () => {
  const sourceCamera = getActiveCamera();
  if (!sourceCamera || !ballCamera || !ballMaterial) return;
  sourceCamera.getWorldQuaternion(_cameraQuat);
  ballCamera.quaternion.copy(_cameraQuat);
  ballCamera.position.set(0, 0, CAMERA_DISTANCE).applyQuaternion(_cameraQuat);
  ballMaterial.envMapRotation.copy((getRootScene() as THREE.Scene).environmentRotation);
};

const createBallScene = () => {
  const scene = new THREE.Scene();
  scene.name = 'envBallScene';
  ballMaterial = new THREE.MeshBasicNodeMaterial();
  ballMaterial.name = 'envBallMaterial';
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), ballMaterial);
  ball.name = 'envBall';
  scene.add(ball);
  return scene;
};

// Public (via debug/EnvBall.ts)
// **************************************

/**
 * Creates the environment ball (once).
 * @param opts (object) {@link EnvBallOpts}
 */
export const _initEnvBall = (opts: EnvBallOpts) => {
  showBall = opts.show;
  showInMainCamera = opts.showInMainCamera;
  uRoughness.value = opts.roughness;
  if (isInitialized) return;
  isInitialized = true;

  ballCamera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, CAMERA_DISTANCE * 2);

  createViewport({
    id: VIEWPORT_ID,
    scene: createBallScene(),
    camera: ballCamera,
    anchor: 'TOP_RIGHT',
    order: 1,
    slotClass: styles.envBallSlot,
    transparent: true,
    toneMapping: 'RENDERER',
    syncCameraAspect: true,
    // The env ball system enables it
    enabled: false,
    interactive: false,
    onBeforeRender: updateBall,
  });

  syncEnvironment();
  onSkyBoxChange(syncEnvironment);
};

/**
 * Shows or hides the environment ball (it is only shown while the debug camera is active,
 * unless showInMainCamera is on, and only while there is an environment).
 * @param show (boolean)
 */
export const _setEnvBallVisible = (show: boolean) => {
  showBall = show;
};

/**
 * Sets whether the environment ball is also shown while the main (gameplay) camera is active.
 * @param show (boolean)
 */
export const _setEnvBallInMainCamera = (show: boolean) => {
  showInMainCamera = show;
};

/**
 * Sets the roughness the environment ball samples the environment at.
 * @param roughness (number) 0 (mirror) to 1 (fully diffuse)
 */
export const _setEnvBallRoughness = (roughness: number) => {
  uRoughness.value = THREE.MathUtils.clamp(roughness, 0, 1);
};
