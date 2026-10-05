/**
 * Viewports (docs/plans/p080_multi-viewport-rendering-and-axis-gizmo.md): extra rectangles
 * rendered over the main canvas after the main render (and after PostFX), each with its own
 * scene and camera (picture-in-picture, minimaps, item previews, the debug axes gizmo).
 *
 * Naming rule: an extra rendered rectangle is a "viewport", the full-canvas render is the "main
 * view". A viewport is never called a "pass" (PostFX owns that word).
 *
 * Each enabled viewport, each frame:
 * 1. renders its scene into its own RenderTarget (own clear, depth and MSAA, never the canvas's
 *    internal framebuffer target), then
 * 2. composites that target onto the canvas with a QuadMesh inside `renderer.setViewport()`,
 *    with the renderer's tone mapping and output colour space neutralised for the draw (the
 *    same contract as `RenderPipeline.render()`), so the draw goes straight to the canvas
 *    instead of through the renderer's full-canvas output pass. The quad's own
 *    `renderOutput()` does the tone mapping and colour space conversion, and blends
 *    premultiplied "over" the frame.
 *
 * Layout is DOM-anchored: every viewport owns a slot element in the viewports layer (in the
 * HUD root), either in a corner stack (`anchor` + `order`) or placed by an explicit `rect`. The
 * rendered rect is the slot's box, so CSS (media queries, transitions) is the single source of
 * truth for placement. Slot boxes are only read when they may have changed: on create/enable,
 * canvas resize, pixel ratio change, a body class change, every frame while a CSS transition
 * runs in the layer, and on invalidateViewportLayout().
 *
 * Input: an `interactive` viewport's slot takes pointer events (so they never reach the canvas,
 * OrbitControls or MouseInput); others let everything through to the canvas.
 *
 * The same path works with PostFX on or off, and on the WebGPU and WebGL2 backends. With no
 * enabled viewport, renderViewports() is a single count check, and nothing is added to the DOM
 * before the first createViewport().
 */
import * as THREE from 'three/webgpu';
import { texture, uniform, uv } from 'three/tsl';
import { registerGPUMemorySource } from '../debug/GPUMemory';
import type { TCMP } from '../utils/CMP';
import { lwarn } from '../utils/Logger';
import { getHUDRootCMP, KEEP_IN_VIEWS_CLASS } from './HUD';
import { getCurrentSceneId, registerOnAllSceneExits } from './Scene';
import styles from './Viewports.module.scss';

export type ViewportRect = { x: number; y: number; width: number; height: number };

export type ViewportAnchor = 'TOP_RIGHT' | 'TOP_LEFT' | 'BOTTOM_RIGHT' | 'BOTTOM_LEFT';

export type ViewportProps = {
  id: string;
  /** A private scene, or getRootScene() for a picture-in-picture of the game. A PiP of the
   * game scene renders it twice per frame (shadow maps, onBeforeRender hooks, draw counts):
   * that cost is the consumer's. */
  scene: THREE.Object3D;
  /** The camera, or a resolver called every frame (eg. `() => getActiveCamera() ?? null`).
   * The viewport is skipped on frames where the resolver returns null. */
  camera: THREE.Camera | (() => THREE.Camera | null);
  /** Corner stack to place the slot in, when there is no `rect`. Default 'TOP_RIGHT'. Its
   * global class is `aekViewportStack_<anchor>` (for consumer SCSS). */
  anchor?: ViewportAnchor;
  /** Position inside the corner stack, from the corner outwards (0 = in the corner). */
  order?: number;
  /** Explicit placement in CSS px (or `%` of the canvas), relative to the canvas top-left
   * corner, instead of a corner stack. The part outside the canvas is cropped. */
  rect?: ViewportRect & { unit?: 'px' | '%' };
  /** CSS size of a stacked slot (eg. '10rem'). Can be left out when `slotClass` sizes it. */
  size?: { width: string; height: string };
  /** Extra class(es) on the slot (consumer SCSS: size, margins, media queries). */
  slotClass?: string;
  /** Default true: cleared with alpha 0 and blended over the frame. */
  transparent?: boolean;
  /** Clear colour, for opaque viewports whose scene has no background. Default black. */
  clearColor?: THREE.ColorRepresentation;
  /** 'NONE' (default) gives exact flat colours (overlays), 'RENDERER' uses the renderer's tone
   * mapping and exposure (a PiP of the game scene that matches the main view). */
  toneMapping?: 'NONE' | 'RENDERER';
  /** MSAA samples of the viewport's render target. Default: 4 if the renderer uses MSAA,
   * otherwise 0. */
  samples?: number;
  /** Default false. When true, the slot takes pointer events (see getViewportPointerNDC()). */
  interactive?: boolean;
  /** Default true */
  enabled?: boolean;
  /** When set, the viewport is deleted when that scene is exited. Otherwise it is global and
   * persists across scene changes. */
  sceneId?: string;
  /** Default false. Keeps a perspective camera's aspect (or an orthographic camera's frustum
   * width) matched to the viewport rect. Don't use it with a camera the main view also renders
   * with (eg. getMainCamera()). */
  syncCameraAspect?: boolean;
  /** Called every frame before the viewport renders (only while it is enabled and on the
   * canvas). */
  onBeforeRender?: (vp: Viewport, delta: number) => void;
};

export type Viewport = {
  readonly id: string;
  readonly props: Readonly<ViewportProps>;
  /** The rendered rect in CSS px, relative to the canvas top-left corner, snapped to whole
   * device pixels (before cropping to the canvas). 0×0 until its first layout. */
  readonly rect: Readonly<ViewportRect>;
  readonly enabled: boolean;
  readonly interactive: boolean;
  /** The viewport's slot element (listen to pointer events on it when interactive). */
  readonly slotElem: HTMLElement;
};

type ViewportState = {
  id: string;
  props: ViewportProps;
  rect: ViewportRect;
  enabled: boolean;
  interactive: boolean;
  slotElem: HTMLElement;
  slotCmp: TCMP;
  /** Nothing of it is on the canvas (empty, hidden or fully cropped slot). */
  isEmpty: boolean;
  /** Full rect in device px (x0, y0 = top-left, relative to the canvas). */
  devX: number;
  devY: number;
  devWidth: number;
  devHeight: number;
  /** The drawn (cropped to the canvas) part in device px. */
  drawX: number;
  drawY: number;
  drawWidth: number;
  drawHeight: number;
  clearColor: THREE.Color;
  renderTarget: THREE.RenderTarget | null;
  quad: THREE.QuadMesh;
  material: THREE.NodeMaterial;
  /** The crop of the render target sampled by the quad (uv offset and scale). */
  uvOffset: THREE.UniformNode<'vec2', THREE.Vector2>;
  uvScale: THREE.UniformNode<'vec2', THREE.Vector2>;
  /** Tone mapping and output colour space the quad material was built with (null = never). */
  builtToneMapping: THREE.ToneMapping | null;
  builtColorSpace: string | null;
  /** The camera and aspect syncCameraAspect last applied. */
  syncedCamera: THREE.Camera | null;
  syncedAspect: number;
  /** Removes its render target from the GPU memory tab's sources (debug env only). */
  removeGPUMemorySource: () => void;
};

const LAYER_ID = 'aekViewportsLayer';
const SCENE_EXIT_HOOK_ID = 'viewports';
/** A transition that never reports its end (eg. its element was removed mid-way) stops being
 * tracked after this long without transition events. */
const TRANSITION_TRACKING_TIMEOUT_MS = 3000;

const viewports: ViewportState[] = [];
let enabledCount = 0;

let layerCmp: TCMP | null = null;
const stackCmps: Partial<Record<ViewportAnchor, TCMP>> = {};
let isLayoutDirty = true;
let runningTransitionCount = 0;
let lastTransitionEventTime = 0;

// The canvas's CSS box at the last layout (for getViewportPointerNDC)
let canvasLeft = 0;
let canvasTop = 0;

// Canvas size and pixel ratio of the last layout (a change re-layouts every viewport)
let lastCanvasWidth = -1;
let lastCanvasHeight = -1;
let lastPixelRatio = -1;

// Scratch objects (no per-frame allocations)
const _canvasSize = new THREE.Vector2();
const _bufferSize = new THREE.Vector2();
const _prevClearColor = new THREE.Color();
const _prevViewport = new THREE.Vector4();

const onTransitionRun = () => {
  runningTransitionCount++;
  lastTransitionEventTime = performance.now();
};

const onTransitionStop = () => {
  runningTransitionCount = Math.max(0, runningTransitionCount - 1);
  lastTransitionEventTime = performance.now();
  // One more layout for the final position
  isLayoutDirty = true;
};

/** Creates the viewports layer (on the first createViewport()). */
const ensureLayer = () => {
  if (layerCmp) return layerCmp;
  layerCmp = getHUDRootCMP().add({
    id: LAYER_ID,
    idAttr: true,
    // Viewports render over every view (ViewManager.ts)
    class: [styles.viewportsLayer, KEEP_IN_VIEWS_CLASS],
    // First in the HUD root, so it is below the rest of the HUD also in DOM order
    prepend: true,
  });
  // Transition events bubble, so the layer sees every slot and stack transition
  layerCmp.elem.addEventListener('transitionrun', onTransitionRun);
  layerCmp.elem.addEventListener('transitionend', onTransitionStop);
  layerCmp.elem.addEventListener('transitioncancel', onTransitionStop);
  // Body classes (eg. the debugger drawer's) can move or hide slots without a transition
  new MutationObserver(invalidateViewportLayout).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  registerOnAllSceneExits(SCENE_EXIT_HOOK_ID, deleteSceneViewports);
  return layerCmp;
};

const getStackCmp = (anchor: ViewportAnchor) => {
  let stackCmp = stackCmps[anchor];
  if (!stackCmp) {
    stackCmp = ensureLayer().add({
      id: `${LAYER_ID}_stack_${anchor}`,
      class: [styles.viewportStack, `aekViewportStack_${anchor}`],
    });
    stackCmps[anchor] = stackCmp;
  }
  return stackCmp;
};

const createSlotCmp = (props: ViewportProps) => {
  const classes = ['aekViewportSlot', styles.viewportSlot];
  if (props.slotClass) classes.push(...props.slotClass.split(' ').filter(Boolean));
  if (props.interactive) classes.push('aekViewportSlot_interactive');
  if (props.enabled === false) classes.push(styles.viewportSlot_disabled);
  const slotProps = { id: `${LAYER_ID}_slot_${props.id}`, class: classes };

  const rect = props.rect;
  if (rect) {
    const unit = rect.unit || 'px';
    classes.push(styles.viewportSlot_rect);
    return ensureLayer().add({
      ...slotProps,
      style: {
        left: `${rect.x}${unit}`,
        top: `${rect.y}${unit}`,
        width: `${rect.width}${unit}`,
        height: `${rect.height}${unit}`,
      },
    });
  }
  return getStackCmp(props.anchor || 'TOP_RIGHT').add({
    ...slotProps,
    style: {
      order: String(props.order ?? 0),
      ...(props.size ? { width: props.size.width, height: props.size.height } : {}),
    },
  });
};

/**
 * Creates a viewport: an extra rect with its own scene and camera, rendered over the main
 * canvas every frame after the main render (and PostFX).
 * @param props (object) {@link ViewportProps}
 * @returns (object) {@link Viewport}
 */
export const createViewport = (props: ViewportProps): Viewport => {
  const existing = viewports.find((vp) => vp.id === props.id);
  if (existing) {
    lwarn(`Viewport with id "${props.id}" already exists, in createViewport. Replacing it.`);
    deleteViewport(props.id);
  }
  if (props.rect && (props.anchor || props.order !== undefined || props.size)) {
    lwarn(`Viewport "${props.id}" has a rect, so its anchor, order and size are ignored.`);
  }

  const material = new THREE.NodeMaterial();
  material.name = `viewport_${props.id}`;
  // Premultiplied "over": renderOutput() premultiplies its result
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.depthTest = false;
  material.depthWrite = false;

  const slotCmp = createSlotCmp(props);

  const vp: ViewportState = {
    id: props.id,
    props,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    enabled: props.enabled !== false,
    interactive: Boolean(props.interactive),
    slotElem: slotCmp.elem,
    slotCmp,
    isEmpty: true,
    devX: 0,
    devY: 0,
    devWidth: 0,
    devHeight: 0,
    drawX: 0,
    drawY: 0,
    drawWidth: 0,
    drawHeight: 0,
    clearColor: new THREE.Color(props.clearColor ?? 0x000000),
    renderTarget: null,
    quad: new THREE.QuadMesh(material),
    material,
    uvOffset: uniform(new THREE.Vector2(0, 0)),
    uvScale: uniform(new THREE.Vector2(1, 1)),
    builtToneMapping: null,
    builtColorSpace: null,
    syncedCamera: null,
    syncedAspect: 0,
    removeGPUMemorySource: registerGPUMemorySource({
      id: `viewport.${props.id}`,
      label: `Viewport "${props.id}"`,
      owner: props.sceneId,
      getResources: () => [vp.renderTarget],
    }),
  };
  viewports.push(vp);
  if (vp.enabled) enabledCount++;
  isLayoutDirty = true;
  return vp;
};

/**
 * Deletes a viewport and disposes its render target, quad material and slot element.
 * @param id (string) viewport id
 */
export const deleteViewport = (id: string) => {
  const index = viewports.findIndex((vp) => vp.id === id);
  if (index < 0) return;
  const vp = viewports[index];
  viewports.splice(index, 1);
  if (vp.enabled) enabledCount--;
  vp.renderTarget?.dispose();
  vp.material.dispose();
  vp.slotCmp.remove();
  vp.removeGPUMemorySource();
  // Removing a slot can move the others in its stack
  isLayoutDirty = true;
};

/** Deletes the viewports of the scene being exited (registered on all scene exits). */
const deleteSceneViewports = () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;
  for (let i = viewports.length - 1; i >= 0; i--) {
    if (viewports[i].props.sceneId === sceneId) deleteViewport(viewports[i].id);
  }
};

/**
 * Enables or disables a viewport. A disabled viewport costs nothing per frame, keeps its
 * render target (so re-enabling it is cheap), and its slot is hidden (`display: none`).
 * @param id (string) viewport id
 * @param enabled (boolean)
 */
export const setViewportEnabled = (id: string, enabled: boolean) => {
  const vp = viewports.find((v) => v.id === id);
  if (!vp || vp.enabled === enabled) return;
  vp.enabled = enabled;
  enabledCount += enabled ? 1 : -1;
  vp.slotElem.classList.toggle(styles.viewportSlot_disabled, !enabled);
  isLayoutDirty = true;
};

/**
 * Sets whether a viewport's slot takes pointer events (true) or lets them through to the
 * canvas (false).
 * @param id (string) viewport id
 * @param interactive (boolean)
 */
export const setViewportInteractive = (id: string, interactive: boolean) => {
  const vp = viewports.find((v) => v.id === id);
  if (!vp || vp.interactive === interactive) return;
  vp.interactive = interactive;
  vp.slotElem.classList.toggle('aekViewportSlot_interactive', interactive);
};

/**
 * Returns a viewport by id.
 * @param id (string) viewport id
 * @returns (object | undefined) {@link Viewport}
 */
export const getViewport = (id: string): Viewport | undefined =>
  viewports.find((vp) => vp.id === id);

/**
 * Re-reads every viewport's slot box before the next render. Call it after changing something
 * that moves or resizes slots without a transition, a canvas resize or a body class change
 * (eg. a class on a slot's ancestor).
 */
export const invalidateViewportLayout = () => {
  isLayoutDirty = true;
};

/**
 * Writes a pointer event's position as normalized device coordinates of a viewport (-1..1,
 * y up, the same as the viewport camera's), eg. for raycasting into the viewport's scene.
 * @param id (string) viewport id
 * @param e (PointerEvent | MouseEvent)
 * @param out (THREE.Vector2) target
 * @returns (boolean) whether the pointer is inside the viewport rect (`out` is written anyway)
 */
export const getViewportPointerNDC = (
  id: string,
  e: PointerEvent | MouseEvent,
  out: THREE.Vector2
) => {
  const vp = viewports.find((v) => v.id === id);
  if (!vp || !vp.rect.width || !vp.rect.height) return false;
  const x = (e.clientX - canvasLeft - vp.rect.x) / vp.rect.width;
  const y = (e.clientY - canvasTop - vp.rect.y) / vp.rect.height;
  out.set(x * 2 - 1, -(y * 2 - 1));
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
};

const resolveCamera = (vp: ViewportState) => {
  const camera = vp.props.camera;
  return typeof camera === 'function' ? camera() : camera;
};

/** Reads the viewport's slot box, snaps it to whole device px, computes its crop to the canvas,
 * and (re)sizes its render target. */
const layoutViewport = (
  vp: ViewportState,
  renderer: THREE.Renderer,
  canvasRect: DOMRect,
  pixelRatio: number,
  bufferWidth: number,
  bufferHeight: number
) => {
  // A hidden slot (display: none, also via an ancestor) has an empty box
  const slotRect = vp.slotElem.getBoundingClientRect();
  const x = slotRect.left - canvasRect.left;
  const y = slotRect.top - canvasRect.top;
  const x0 = Math.round(x * pixelRatio);
  const y0 = Math.round(y * pixelRatio);
  const x1 = Math.round((x + slotRect.width) * pixelRatio);
  const y1 = Math.round((y + slotRect.height) * pixelRatio);
  vp.devX = x0;
  vp.devY = y0;
  vp.devWidth = Math.max(0, x1 - x0);
  vp.devHeight = Math.max(0, y1 - y0);
  vp.rect.x = x0 / pixelRatio;
  vp.rect.y = y0 / pixelRatio;
  vp.rect.width = vp.devWidth / pixelRatio;
  vp.rect.height = vp.devHeight / pixelRatio;

  // Crop to the canvas
  const cx0 = Math.max(x0, 0);
  const cy0 = Math.max(y0, 0);
  const cx1 = Math.min(x1, bufferWidth);
  const cy1 = Math.min(y1, bufferHeight);
  vp.drawX = cx0;
  vp.drawY = cy0;
  vp.drawWidth = Math.max(0, cx1 - cx0);
  vp.drawHeight = Math.max(0, cy1 - cy0);
  vp.isEmpty = vp.drawWidth === 0 || vp.drawHeight === 0;
  if (vp.isEmpty) return;

  // The quad's uv (0,0 = bottom-left) mapped to the drawn part of the render target
  vp.uvScale.value.set(vp.drawWidth / vp.devWidth, vp.drawHeight / vp.devHeight);
  vp.uvOffset.value.set((cx0 - x0) / vp.devWidth, (y1 - cy1) / vp.devHeight);

  if (!vp.renderTarget) {
    vp.renderTarget = new THREE.RenderTarget(vp.devWidth, vp.devHeight, {
      type: THREE.HalfFloatType,
      samples: vp.props.samples ?? (renderer.samples > 0 ? 4 : 0),
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    vp.renderTarget.texture.name = `viewport_${vp.id}`;
  } else if (vp.renderTarget.width !== vp.devWidth || vp.renderTarget.height !== vp.devHeight) {
    vp.renderTarget.setSize(vp.devWidth, vp.devHeight);
  }
};

/** Reads every enabled viewport's slot box (one forced layout for all of them). */
const layoutViewports = (renderer: THREE.Renderer, pixelRatio: number) => {
  isLayoutDirty = false;
  renderer.getDrawingBufferSize(_bufferSize);
  const canvasRect = renderer.domElement.getBoundingClientRect();
  canvasLeft = canvasRect.left;
  canvasTop = canvasRect.top;
  for (let i = 0; i < viewports.length; i++) {
    const vp = viewports[i];
    if (vp.enabled)
      layoutViewport(vp, renderer, canvasRect, pixelRatio, _bufferSize.x, _bufferSize.y);
  }
};

/** Keeps a perspective camera's aspect, or an orthographic camera's frustum width (around its
 * centre, keeping its height), matched to the viewport rect. */
const syncCameraAspect = (vp: ViewportState, camera: THREE.Camera) => {
  const aspect = vp.devWidth / vp.devHeight;
  if (camera === vp.syncedCamera && aspect === vp.syncedAspect) return;
  vp.syncedCamera = camera;
  vp.syncedAspect = aspect;
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    const halfWidth = ((camera.top - camera.bottom) / 2) * aspect;
    const centerX = (camera.left + camera.right) / 2;
    camera.left = centerX - halfWidth;
    camera.right = centerX + halfWidth;
    camera.updateProjectionMatrix();
  }
};

/** (Re)builds the quad material's output node when the tone mapping or output colour space it
 * was built with changed (eg. the Renderer debug tab changed the tone mapping live). */
const updateQuadMaterial = (
  vp: ViewportState,
  toneMapping: THREE.ToneMapping,
  colorSpace: string
) => {
  const targetToneMapping = vp.props.toneMapping === 'RENDERER' ? toneMapping : THREE.NoToneMapping;
  if (vp.builtToneMapping === targetToneMapping && vp.builtColorSpace === colorSpace) return;
  vp.builtToneMapping = targetToneMapping;
  vp.builtColorSpace = colorSpace;
  const sampleUV = uv().mul(vp.uvScale).add(vp.uvOffset);
  vp.material.fragmentNode = texture(vp.renderTarget!.texture, sampleUV).renderOutput(
    targetToneMapping,
    colorSpace
  );
  vp.material.needsUpdate = true;
};

/**
 * Renders every enabled viewport over the canvas. Called by MainLoop's renderScene() once per
 * frame, right after the main render (and PostFX). Not for app code.
 * @param renderer (THREE.Renderer)
 * @param delta (number) main loop delta time
 */
export const renderViewports = (renderer: THREE.Renderer, delta: number) => {
  if (!enabledCount) return;

  // A canvas resize or a pixel ratio change re-layouts every viewport
  renderer.getSize(_canvasSize);
  const pixelRatio = renderer.getPixelRatio();
  if (
    _canvasSize.x !== lastCanvasWidth ||
    _canvasSize.y !== lastCanvasHeight ||
    pixelRatio !== lastPixelRatio
  ) {
    lastCanvasWidth = _canvasSize.x;
    lastCanvasHeight = _canvasSize.y;
    lastPixelRatio = pixelRatio;
    isLayoutDirty = true;
  }
  // While a CSS transition runs in the layer (eg. a stack sliding along with the debugger
  // drawer), the slots are re-read every frame
  if (runningTransitionCount > 0) {
    if (performance.now() - lastTransitionEventTime > TRANSITION_TRACKING_TIMEOUT_MS) {
      runningTransitionCount = 0;
    }
    isLayoutDirty = true;
  }
  if (isLayoutDirty) layoutViewports(renderer, pixelRatio);

  // Saved renderer state (restored below)
  const prevRenderTarget = renderer.getRenderTarget();
  const prevCubeFace = renderer.getActiveCubeFace();
  const prevMipmapLevel = renderer.getActiveMipmapLevel();
  const prevAutoClear = renderer.autoClear;
  const prevToneMapping = renderer.toneMapping;
  const prevColorSpace = renderer.outputColorSpace;
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(_prevClearColor);
  renderer.getViewport(_prevViewport);

  for (let i = 0; i < viewports.length; i++) {
    const vp = viewports[i];
    if (!vp.enabled || vp.isEmpty) continue;

    vp.props.onBeforeRender?.(vp, delta);
    // onBeforeRender may disable it
    if (!vp.enabled) continue;
    const camera = resolveCamera(vp);
    if (!camera) continue;
    if (vp.props.syncCameraAspect) syncCameraAspect(vp, camera);

    // 1. The viewport's scene into its own render target (not an output target: no tone
    // mapping, working colour space)
    renderer.setRenderTarget(vp.renderTarget);
    renderer.autoClear = true;
    renderer.setClearColor(vp.clearColor, vp.props.transparent === false ? 1 : 0);
    renderer.render(vp.props.scene, camera);

    // 2. Composite onto the canvas, inside the viewport rect. With tone mapping and colour
    // space neutralised, the renderer draws the quad straight to the canvas (no internal
    // framebuffer target and output pass). The +0.5 device px makes the renderer's
    // `(css * pixelRatio).floor()` land exactly on the snapped pixel.
    updateQuadMaterial(vp, prevToneMapping, prevColorSpace);
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    renderer.setViewport(
      (vp.drawX + 0.5) / pixelRatio,
      (vp.drawY + 0.5) / pixelRatio,
      (vp.drawWidth + 0.5) / pixelRatio,
      (vp.drawHeight + 0.5) / pixelRatio
    );
    vp.quad.render(renderer);
    renderer.toneMapping = prevToneMapping;
    renderer.outputColorSpace = prevColorSpace;
  }

  // Restore (the scissor test is never touched: a leaked scissor breaks PMREM, three #31777)
  renderer.setViewport(_prevViewport);
  renderer.setClearColor(_prevClearColor, prevClearAlpha);
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevRenderTarget, prevCubeFace, prevMipmapLevel);
};
