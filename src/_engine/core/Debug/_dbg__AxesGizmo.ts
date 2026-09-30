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
 *
 * Interaction (debug camera only; with the main camera the gizmo lets the pointer through):
 * hovering highlights a bubble (and shows the negative axes' labels) over a backdrop, a click
 * on a bubble animates the debug camera to look along that axis (a second click flips to the
 * opposite one, like Blender), and a drag orbits the debug camera around its target.
 */
import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { getActiveCamera, isDebugCameraActive } from '../CameraManager';
import { getCanvasElem } from '../Renderer';
import { CLICK_MAX_MOVE_PX } from '../Input/MouseInput';
import {
  createViewport,
  getViewportPointerNDC,
  setViewportEnabled,
  setViewportInteractive,
} from '../Viewports';
import { DEBUG_CAMERA_ID } from '../../debug/DebugToolsManager';
import { saveDebugCameraToLS } from './Camera/_dbg__CameraGUI';
import { setDebugCameraControlsSuspended } from './Camera/_dbg__DebugCamera';
import styles from './AxesGizmo.module.scss';

export type AxesGizmoOpts = { show: boolean; showInMainCamera: boolean };

const VIEWPORT_ID = 'aekAxesGizmo';

/** Axis bubble centre distance from the gizmo centre, and the bubble radius (the camera
 * frustum is -1..1 on both axes). */
const AXIS_LENGTH = 0.68;
const BUBBLE_RADIUS = 0.2;
const LINE_RADIUS = 0.022;
const BACKDROP_RADIUS = 0.98;
/** Opacity of a bubble pointing straight away from the viewer (Blender dims back axes). */
const BACK_BUBBLE_MIN_OPACITY = 0.55;

const ATLAS_CELL_SIZE = 128;

const ALIGN_DURATION_MS = 250;
/** Clicking the axis the view is already aligned to (within ~1°) aligns to the opposite one. */
const ALIGNED_COS = Math.cos(THREE.MathUtils.degToRad(1));
/** Polar angle of the top/bottom views: inside OrbitControls' own clamp (1e-6), so it never
 * nudges them (no roll jump). */
const POLE_EPS = 1e-4;

type AxisDef = { label: 'X' | 'Y' | 'Z'; dir: THREE.Vector3; color: string };

const AXES: AxisDef[] = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ff3653' },
  { label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#8adb00' },
  { label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#2c8fff' },
];

type BubbleMaterial = THREE.MeshBasicNodeMaterial;

type Bubble = {
  /** Unit direction in world space (eg. -X = (-1, 0, 0)). */
  dir: THREE.Vector3;
  mesh: THREE.Mesh<THREE.PlaneGeometry, BubbleMaterial>;
  idleMaterial: BubbleMaterial;
  hoverMaterial: BubbleMaterial;
};

/** OrbitControls' damping momentum (not in its typings). */
type OrbitControlsInternals = OrbitControls & {
  _sphericalDelta: THREE.Spherical;
  _panOffset: THREE.Vector3;
};

type AlignAnimation = {
  startTime: number;
  obj: THREE.Object3D;
  controls: OrbitControls;
  radius: number;
  fromPhi: number;
  fromTheta: number;
  deltaPhi: number;
  deltaTheta: number;
};

let isInitialized = false;
let showGizmo = false;
let showInMainCamera = false;
let isVisible = false;
let isClickable = false;

let slotElem: HTMLElement | null = null;
let gizmoCamera: THREE.OrthographicCamera | null = null;
let gizmoRoot: THREE.Group | null = null;
let backdrop: THREE.Mesh | null = null;
const bubbles: Bubble[] = [];
const bubbleMeshes: THREE.Object3D[] = [];

let hoveredBubble: Bubble | null = null;
let pressPointerId: number | null = null;
let pressX = 0;
let pressY = 0;
let lastX = 0;
let lastY = 0;
let isDragging = false;
let alignAnimation: AlignAnimation | null = null;

// Scratch objects (no per-frame allocations)
const _cameraQuat = new THREE.Quaternion();
const _bubblePos = new THREE.Vector3();
const _sortedBubbles: Bubble[] = [];
const _offset = new THREE.Vector3();
const _spherical = new THREE.Spherical();
const _alignDir = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _hits: THREE.Intersection[] = [];

ECSWorld.registerPlugin((world) => {
  // Order 1: before debugCameraSystem (order 0), so its controls.update() applies the align
  // animation's camera position in the same frame
  world.addSystem(ECSSystemStage.MAIN, 'axesGizmoSystem', axesGizmoSystem, 1);
});

/** Visibility, clickability and the align animation. Plugins run per world: the gizmo is
 * global, so only the default world drives it. */
function axesGizmoSystem(world: ECSWorld) {
  if (!isInitialized || world !== getECSWorld()) return;
  const isDebugCam = isDebugCameraActive();
  const visible = showGizmo && (showInMainCamera || isDebugCam);
  if (visible !== isVisible) {
    isVisible = visible;
    setViewportEnabled(VIEWPORT_ID, visible);
  }
  const clickable = visible && isDebugCam;
  if (clickable !== isClickable) {
    isClickable = clickable;
    setViewportInteractive(VIEWPORT_ID, clickable);
    if (!clickable) resetPointerState();
  }
  if (alignAnimation) {
    if (isDebugCam) stepAlignAnimation(alignAnimation);
    else cancelAlignAnimation();
  }
}

// Visuals
// **************************************

/** One row of bubble images (the order of the bubbles): +X, +Y, +Z, -X, -Y, -Z. Drawn on a 2D
 * canvas, so the circles and labels are anti-aliased at any gizmo size. The hover atlas has
 * the same layout: lighter positive bubbles, and labelled, filled negative ones. */
const createBubbleAtlas = (isHover: boolean) => {
  const cellCount = AXES.length * 2;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_CELL_SIZE * cellCount;
  canvas.height = ATLAS_CELL_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const half = ATLAS_CELL_SIZE / 2;
  const radius = half - 4; // a transparent margin against mipmap bleeding
  const rimWidth = ATLAS_CELL_SIZE * 0.07;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < cellCount; i++) {
    const axis = AXES[i % AXES.length];
    const isNegative = i >= AXES.length;
    const cx = i * ATLAS_CELL_SIZE + half;
    ctx.beginPath();
    ctx.arc(cx, half, isNegative ? radius - rimWidth / 2 : radius, 0, Math.PI * 2);
    ctx.fillStyle = axis.color;
    if (isNegative) {
      // Coloured rim, darker translucent fill, a label only on hover
      ctx.globalAlpha = isHover ? 0.8 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = rimWidth;
      ctx.strokeStyle = axis.color;
      ctx.stroke();
      if (!isHover) continue;
    } else {
      ctx.fill();
      if (isHover) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    const fontScale = isNegative ? 0.42 : 0.52;
    ctx.font = `bold ${Math.round(ATLAS_CELL_SIZE * fontScale)}px sans-serif`;
    ctx.fillText(`${isNegative ? '−' : ''}${axis.label}`, cx, half + ATLAS_CELL_SIZE * 0.03);
  }

  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.name = `axesGizmoBubbleAtlas${isHover ? 'Hover' : ''}`;
  return atlas;
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

const createBubbleMaterial = (atlas: THREE.Texture) =>
  new THREE.MeshBasicNodeMaterial({ map: atlas, transparent: true, depthWrite: false });

const createGizmoScene = () => {
  const scene = new THREE.Scene();
  scene.name = 'axesGizmoScene';
  const root = new THREE.Group();
  scene.add(root);

  // Translucent backdrop disc, shown while the pointer is over the gizmo
  backdrop = new THREE.Mesh(
    new THREE.CircleGeometry(BACKDROP_RADIUS, 48),
    new THREE.MeshBasicNodeMaterial({
      color: '#dddddd',
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    })
  );
  backdrop.position.z = -3;
  backdrop.visible = false;
  scene.add(backdrop);

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
  const idleAtlas = createBubbleAtlas(false);
  const hoverAtlas = createBubbleAtlas(true);
  const cellCount = AXES.length * 2;
  for (let i = 0; i < cellCount; i++) {
    const axis = AXES[i % AXES.length];
    const isNegative = i >= AXES.length;
    const idleMaterial = createBubbleMaterial(idleAtlas);
    const hoverMaterial = createBubbleMaterial(hoverAtlas);
    const mesh = new THREE.Mesh(createBubbleGeometry(i, cellCount), idleMaterial);
    mesh.name = `axesGizmoBubble_${isNegative ? '-' : '+'}${axis.label}`;
    scene.add(mesh);
    bubbleMeshes.push(mesh);
    bubbles.push({
      dir: axis.dir.clone().multiplyScalar(isNegative ? -1 : 1),
      mesh,
      idleMaterial,
      hoverMaterial,
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
    const opacity = 1 - (1 - BACK_BUBBLE_MIN_OPACITY) * awayAmount;
    bubble.idleMaterial.opacity = opacity;
    bubble.hoverMaterial.opacity = opacity;
    _sortedBubbles.push(bubble);
  }
  _sortedBubbles.sort(byViewDepth);
  for (let i = 0; i < _sortedBubbles.length; i++) _sortedBubbles[i].mesh.renderOrder = i + 1;
};

// Debug camera moves
// **************************************

const getDebugCamera = () => {
  const entityId = getEntityIdByAppId(DEBUG_CAMERA_ID);
  if (entityId === undefined) return null;
  const world = getECSWorld();
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  const controls = world.getComponent(entityId, ComponentType.ORBIT_CONTROLS)?.controls;
  return obj && controls ? { obj, controls } : null;
};

/** Stops OrbitControls' damping momentum, so it doesn't fight a camera move. */
const stopControlsMomentum = (controls: OrbitControls) => {
  const internals = controls as OrbitControlsInternals;
  internals._sphericalDelta?.set(0, 0, 0);
  internals._panOffset?.set(0, 0, 0);
};

/** The polar angle range OrbitControls allows (its limits, inside the pole epsilon). */
const clampPhi = (controls: OrbitControls, phi: number) =>
  Math.max(
    Math.max(controls.minPolarAngle, POLE_EPS),
    Math.min(Math.min(controls.maxPolarAngle, Math.PI - POLE_EPS), phi)
  );

/** The 'end' event only fires for OrbitControls' own drags, so gizmo moves persist here. */
const saveDebugCameraPose = (obj: THREE.Object3D, controls: OrbitControls) => {
  saveDebugCameraToLS({
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
  });
};

/** Wraps an angle difference to -π..π (the shortest way round). */
const shortestAngle = (angle: number) =>
  angle - Math.PI * 2 * Math.floor((angle + Math.PI) / (Math.PI * 2));

/**
 * Animates the debug camera around its target to look along a bubble's axis (from that side),
 * keeping the target and the orbit distance. The camera's `up` stays +Y (OrbitControls needs
 * it), so the top and bottom views are a hair off the pole, on the +Z side (azimuth 0): that
 * gives X right and −Z up (top), and X right and +Z up (bottom).
 */
const alignToBubble = (bubble: Bubble) => {
  const debugCamera = getDebugCamera();
  if (!debugCamera) return;
  const { obj, controls } = debugCamera;
  _offset.copy(obj.position).sub(controls.target);
  const radius = _offset.length();
  if (!radius) return;

  // Blender flip: the axis the view is already aligned to aligns to the opposite one
  _alignDir.copy(bubble.dir);
  if (_offset.dot(_alignDir) / radius > ALIGNED_COS) _alignDir.negate();

  let toPhi: number;
  let toTheta: number;
  if (Math.abs(_alignDir.y) > 0.5) {
    toPhi = _alignDir.y > 0 ? POLE_EPS : Math.PI - POLE_EPS;
    toTheta = 0;
  } else {
    toPhi = Math.PI / 2;
    toTheta = Math.atan2(_alignDir.x, _alignDir.z);
  }
  toPhi = clampPhi(controls, toPhi);

  _spherical.setFromVector3(_offset);
  cancelAlignAnimation();
  stopControlsMomentum(controls);
  alignAnimation = {
    startTime: performance.now(),
    obj,
    controls,
    radius,
    fromPhi: _spherical.phi,
    fromTheta: _spherical.theta,
    deltaPhi: toPhi - _spherical.phi,
    deltaTheta: shortestAngle(toTheta - _spherical.theta),
  };
  // A user orbit, pan or zoom on the canvas cancels it
  controls.addEventListener('start', cancelAlignAnimation);
};

/** Timed with performance.now(), not the loop delta: the loop delta follows the play speed,
 * and a debug camera move shouldn't crawl in slow motion. */
const stepAlignAnimation = (anim: AlignAnimation) => {
  const t = Math.min(1, (performance.now() - anim.startTime) / ALIGN_DURATION_MS);
  const eased = 1 - (1 - t) ** 3; // ease-out
  _spherical.set(
    anim.radius,
    anim.fromPhi + anim.deltaPhi * eased,
    anim.fromTheta + anim.deltaTheta * eased
  );
  // debugCameraSystem's controls.update() (later this frame) turns the camera to the target
  anim.obj.position.setFromSpherical(_spherical).add(anim.controls.target);
  if (t < 1) return;
  cancelAlignAnimation();
  saveDebugCameraPose(anim.obj, anim.controls);
};

const cancelAlignAnimation = () => {
  if (!alignAnimation) return;
  alignAnimation.controls.removeEventListener('start', cancelAlignAnimation);
  alignAnimation = null;
};

/** Orbits the debug camera around its target by a pointer move, at OrbitControls' speed
 * (a full turn per canvas height, times rotateSpeed). */
const orbitBy = (dx: number, dy: number) => {
  const debugCamera = getDebugCamera();
  if (!debugCamera) return;
  const { obj, controls } = debugCamera;
  const turnPerPx = ((Math.PI * 2) / (getCanvasElem().clientHeight || 1)) * controls.rotateSpeed;
  _offset.copy(obj.position).sub(controls.target);
  _spherical.setFromVector3(_offset);
  _spherical.theta -= dx * turnPerPx;
  _spherical.phi = clampPhi(controls, _spherical.phi - dy * turnPerPx);
  obj.position.setFromSpherical(_spherical).add(controls.target);
};

// Pointer input
// **************************************

/** The front-most bubble under the pointer (the hit must be inside its circle). */
const pickBubble = (e: PointerEvent) => {
  if (!gizmoCamera || !getViewportPointerNDC(VIEWPORT_ID, e, _ndc)) return null;
  _raycaster.setFromCamera(_ndc, gizmoCamera);
  _hits.length = 0;
  _raycaster.intersectObjects(bubbleMeshes, false, _hits);
  let picked: Bubble | null = null;
  for (let i = 0; i < _hits.length; i++) {
    const hit = _hits[i];
    if (hit.point.distanceTo(hit.object.position) <= BUBBLE_RADIUS) {
      picked = bubbles.find((b) => b.mesh === hit.object) || null;
      break;
    }
  }
  _hits.length = 0;
  return picked;
};

const setHoveredBubble = (bubble: Bubble | null) => {
  if (bubble === hoveredBubble) return;
  if (hoveredBubble) hoveredBubble.mesh.material = hoveredBubble.idleMaterial;
  hoveredBubble = bubble;
  if (bubble) bubble.mesh.material = bubble.hoverMaterial;
  slotElem?.classList.toggle(styles.axesGizmoSlot_bubbleHover, Boolean(bubble));
};

const setPointerOver = (isOver: boolean) => {
  if (backdrop) backdrop.visible = isOver;
  if (!isOver) setHoveredBubble(null);
};

const startDrag = (e: PointerEvent) => {
  isDragging = true;
  slotElem?.setPointerCapture(e.pointerId);
  slotElem?.classList.add(styles.axesGizmoSlot_dragging);
  setHoveredBubble(null);
  cancelAlignAnimation();
  const debugCamera = getDebugCamera();
  if (debugCamera) stopControlsMomentum(debugCamera.controls);
  setDebugCameraControlsSuspended(true);
  // The first step includes the movement under the click threshold
  lastX = pressX;
  lastY = pressY;
};

const endDrag = () => {
  if (!isDragging) return;
  isDragging = false;
  if (pressPointerId !== null && slotElem?.hasPointerCapture(pressPointerId)) {
    slotElem.releasePointerCapture(pressPointerId);
  }
  slotElem?.classList.remove(styles.axesGizmoSlot_dragging);
  setDebugCameraControlsSuspended(false);
  const debugCamera = getDebugCamera();
  if (debugCamera) saveDebugCameraPose(debugCamera.obj, debugCamera.controls);
};

/** Drops any press, drag and hover (eg. when the gizmo stops being clickable). */
const resetPointerState = () => {
  endDrag();
  pressPointerId = null;
  setPointerOver(false);
};

const onPointerDown = (e: PointerEvent) => {
  if (e.button !== 0 || !e.isPrimary || !isClickable) return;
  e.preventDefault(); // no text selection
  pressPointerId = e.pointerId;
  pressX = e.clientX;
  pressY = e.clientY;
};

const onPointerMove = (e: PointerEvent) => {
  if (e.pointerId === pressPointerId) {
    if (!isDragging && Math.hypot(e.clientX - pressX, e.clientY - pressY) > CLICK_MAX_MOVE_PX) {
      startDrag(e);
    }
    if (isDragging) {
      orbitBy(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    }
    return;
  }
  setHoveredBubble(pickBubble(e));
};

const onPointerUp = (e: PointerEvent) => {
  if (e.pointerId !== pressPointerId) return;
  if (isDragging) {
    endDrag();
  } else {
    const bubble = pickBubble(e);
    if (bubble) alignToBubble(bubble);
  }
  pressPointerId = null;
  setHoveredBubble(pickBubble(e));
};

const onPointerCancel = (e: PointerEvent) => {
  if (e.pointerId !== pressPointerId) return;
  endDrag();
  pressPointerId = null;
};

const onPointerLeave = () => {
  // A captured drag keeps going outside the gizmo
  if (!isDragging) setPointerOver(false);
};

const listenToPointer = (elem: HTMLElement) => {
  elem.addEventListener('pointerdown', onPointerDown);
  elem.addEventListener('pointermove', onPointerMove);
  elem.addEventListener('pointerup', onPointerUp);
  elem.addEventListener('pointercancel', onPointerCancel);
  elem.addEventListener('pointerenter', () => setPointerOver(true));
  elem.addEventListener('pointerleave', onPointerLeave);
  // Wheel over the gizmo does nothing (as in Blender), and never scrolls or zooms the page
  elem.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
};

// Public (via debug/AxesGizmo.ts)
// **************************************

/**
 * Creates the axes gizmo (once).
 * @param opts (object) {@link AxesGizmoOpts}
 */
export const _initAxesGizmo = (opts: AxesGizmoOpts) => {
  showGizmo = opts.show;
  showInMainCamera = opts.showInMainCamera;
  if (isInitialized) return;
  isInitialized = true;

  gizmoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  gizmoCamera.position.set(0, 0, 5);
  gizmoCamera.lookAt(0, 0, 0);

  const viewport = createViewport({
    id: VIEWPORT_ID,
    scene: createGizmoScene(),
    camera: gizmoCamera,
    anchor: 'TOP_RIGHT',
    order: 0,
    // The global class is for the "Disable on-screen tools" rule (OnScreenTools.module.scss)
    slotClass: `${styles.axesGizmoSlot} aekAxesGizmoSlot`,
    transparent: true,
    toneMapping: 'NONE',
    // The gizmo system enables it and makes it interactive
    enabled: false,
    interactive: false,
    onBeforeRender: updateGizmo,
  });
  slotElem = viewport.slotElem;
  listenToPointer(slotElem);
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
