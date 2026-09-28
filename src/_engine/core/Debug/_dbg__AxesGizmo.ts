/**
 * Axes gizmo (docs/plans/p080_multi-viewport-rendering-and-axis-gizmo.md): a Blender-style
 * navigation gizmo in the top-right corner, showing the active camera's orientation. It is a
 * core viewport (Viewports.ts) with a private scene: unlit, no lights, a fixed orthographic
 * camera looking down −Z, and a root rotated by the inverse of the active camera's world
 * rotation every frame.
 *
 * Visibility: `show && (debug camera active || showInMainCamera)`, evaluated every frame by a
 * MAIN-stage system (a boolean compare, the viewport only changes on a transition). While not
 * visible, the viewport is disabled and costs nothing.
 */
import * as THREE from 'three/webgpu';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { getActiveCamera, isDebugCameraActive } from '../CameraManager';
import { createViewport, setViewportEnabled } from '../Viewports';
import styles from './AxesGizmo.module.scss';

export type AxesGizmoOpts = { show: boolean; showInMainCamera: boolean };

const VIEWPORT_ID = 'aekAxesGizmo';

/** Axis bubble centre distance from the gizmo centre, and the bubble radius (the camera
 * frustum is -1..1 on both axes). */
const AXIS_LENGTH = 0.68;
const BUBBLE_RADIUS = 0.2;
const LINE_RADIUS = 0.022;
/** Opacity of a bubble pointing straight away from the viewer (Blender dims back axes). */
const BACK_BUBBLE_MIN_OPACITY = 0.55;

const ATLAS_CELL_SIZE = 128;

type AxisDef = { label: 'X' | 'Y' | 'Z'; dir: THREE.Vector3; color: string };

const AXES: AxisDef[] = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ff3653' },
  { label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#8adb00' },
  { label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#2c8fff' },
];

type Bubble = {
  /** Unit direction in world space (eg. -X = (-1, 0, 0)). */
  dir: THREE.Vector3;
  isNegative: boolean;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
};

let isInitialized = false;
let showGizmo = false;
let showInMainCamera = false;
let isVisible = false;

let gizmoRoot: THREE.Group | null = null;
const bubbles: Bubble[] = [];

// Scratch objects (no per-frame allocations)
const _cameraQuat = new THREE.Quaternion();
const _bubblePos = new THREE.Vector3();
const _sortedBubbles: Bubble[] = [];

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.MAIN, 'axesGizmoVisibilitySystem', axesGizmoVisibilitySystem);
});

/** Plugins run per world: the gizmo is global, so only the default world drives it. */
function axesGizmoVisibilitySystem(world: ECSWorld) {
  if (!isInitialized || world !== getECSWorld()) return;
  const visible = showGizmo && (showInMainCamera || isDebugCameraActive());
  if (visible === isVisible) return;
  isVisible = visible;
  setViewportEnabled(VIEWPORT_ID, visible);
}

/** One row of bubble images (the order of `cellIndex`): +X, +Y, +Z, -X, -Y, -Z. Drawn on a
 * 2D canvas, so the circles and labels are anti-aliased at any gizmo size. */
const createBubbleAtlas = () => {
  const cellCount = AXES.length * 2;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_CELL_SIZE * cellCount;
  canvas.height = ATLAS_CELL_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const half = ATLAS_CELL_SIZE / 2;
  const radius = half - 4; // a transparent margin against mipmap bleeding
  const rimWidth = ATLAS_CELL_SIZE * 0.07;

  for (let i = 0; i < cellCount; i++) {
    const axis = AXES[i % AXES.length];
    const isNegative = i >= AXES.length;
    const cx = i * ATLAS_CELL_SIZE + half;
    ctx.beginPath();
    ctx.arc(cx, half, isNegative ? radius - rimWidth / 2 : radius, 0, Math.PI * 2);
    if (isNegative) {
      // Coloured rim, darker translucent fill, no label
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = axis.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = rimWidth;
      ctx.strokeStyle = axis.color;
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = axis.color;
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.font = `bold ${Math.round(ATLAS_CELL_SIZE * 0.52)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(axis.label, cx, half + ATLAS_CELL_SIZE * 0.03);
  }

  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.name = 'axesGizmoBubbleAtlas';
  return { atlas, cellCount };
};

/** A camera-facing bubble quad whose uvs show one atlas cell. */
const createBubbleGeometry = (cellIndex: number, cellCount: number) => {
  const geometry = new THREE.PlaneGeometry(BUBBLE_RADIUS * 2, BUBBLE_RADIUS * 2);
  const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setX(i, (cellIndex + uvAttr.getX(i)) / cellCount);
  }
  uvAttr.needsUpdate = true;
  return geometry;
};

const createGizmoScene = () => {
  const scene = new THREE.Scene();
  scene.name = 'axesGizmoScene';
  const root = new THREE.Group();
  scene.add(root);

  // Positive axis lines (thin cylinders, so MSAA smooths them), rotating with the root
  const lineLength = AXIS_LENGTH - BUBBLE_RADIUS * 0.9;
  const lineGeometry = new THREE.CylinderGeometry(LINE_RADIUS, LINE_RADIUS, lineLength, 8);
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const axis of AXES) {
    const line = new THREE.Mesh(
      lineGeometry,
      new THREE.MeshBasicNodeMaterial({ color: axis.color })
    );
    line.quaternion.setFromUnitVectors(yAxis, axis.dir);
    line.position.copy(axis.dir).multiplyScalar(lineLength / 2);
    root.add(line);
  }

  // Bubbles: children of the scene (not the root), so they always face the gizmo camera
  const { atlas, cellCount } = createBubbleAtlas();
  for (let i = 0; i < cellCount; i++) {
    const axis = AXES[i % AXES.length];
    const isNegative = i >= AXES.length;
    const material = new THREE.MeshBasicNodeMaterial({
      map: atlas,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(createBubbleGeometry(i, cellCount), material);
    mesh.name = `axesGizmoBubble_${isNegative ? '-' : '+'}${axis.label}`;
    scene.add(mesh);
    bubbles.push({
      dir: axis.dir.clone().multiplyScalar(isNegative ? -1 : 1),
      isNegative,
      mesh,
    });
  }

  gizmoRoot = root;
  return scene;
};

const byViewDepth = (a: Bubble, b: Bubble) => a.mesh.position.z - b.mesh.position.z;

/** Follows the active camera: the root gets the inverse of its world rotation, the bubbles are
 * placed along the rotated axes, drawn back to front, and dimmed when pointing away. */
const updateGizmo = () => {
  const sourceCamera = getActiveCamera();
  if (!sourceCamera || !gizmoRoot) return;
  sourceCamera.getWorldQuaternion(_cameraQuat).invert();
  gizmoRoot.quaternion.copy(_cameraQuat);

  _sortedBubbles.length = 0;
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    _bubblePos.copy(bubble.dir).applyQuaternion(_cameraQuat).multiplyScalar(AXIS_LENGTH);
    bubble.mesh.position.copy(_bubblePos);
    // View z: towards the viewer is +z (the gizmo camera looks down -Z)
    const awayAmount = Math.max(0, -_bubblePos.z / AXIS_LENGTH);
    bubble.mesh.material.opacity = 1 - (1 - BACK_BUBBLE_MIN_OPACITY) * awayAmount;
    _sortedBubbles.push(bubble);
  }
  _sortedBubbles.sort(byViewDepth);
  for (let i = 0; i < _sortedBubbles.length; i++) _sortedBubbles[i].mesh.renderOrder = i + 1;
};

/**
 * Creates the axes gizmo (once).
 * @param opts (object) {@link AxesGizmoOpts}
 */
export const _initAxesGizmo = (opts: AxesGizmoOpts) => {
  showGizmo = opts.show;
  showInMainCamera = opts.showInMainCamera;
  if (isInitialized) return;
  isInitialized = true;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  createViewport({
    id: VIEWPORT_ID,
    scene: createGizmoScene(),
    camera,
    anchor: 'TOP_RIGHT',
    order: 0,
    slotClass: styles.axesGizmoSlot,
    transparent: true,
    toneMapping: 'NONE',
    // The visibility system enables it
    enabled: false,
    onBeforeRender: updateGizmo,
  });
};

/**
 * Shows or hides the axes gizmo (it is only shown while the debug camera is active, unless
 * showInMainCamera is on).
 * @param show (boolean)
 */
export const _setAxesGizmoVisible = (show: boolean) => {
  showGizmo = show;
};

/**
 * Sets whether the axes gizmo is also shown while the main (gameplay) camera is active.
 * @param show (boolean)
 */
export const _setAxesGizmoInMainCamera = (show: boolean) => {
  showInMainCamera = show;
};
