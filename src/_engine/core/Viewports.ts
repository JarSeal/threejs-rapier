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
 * The same path works with PostFX on or off, and on the WebGPU and WebGL2 backends. With no
 * enabled viewport, renderViewports() is a single count check.
 */
import * as THREE from 'three/webgpu';
import { texture, uniform, uv } from 'three/tsl';
import { lwarn } from '../utils/Logger';

export type ViewportRect = { x: number; y: number; width: number; height: number };

export type ViewportProps = {
  id: string;
  /** A private scene, or getRootScene() for a picture-in-picture of the game. A PiP of the
   * game scene renders it twice per frame (shadow maps, onBeforeRender hooks, draw counts):
   * that cost is the consumer's. */
  scene: THREE.Object3D;
  /** The camera, or a resolver called every frame (eg. `() => getActiveCamera() ?? null`).
   * The viewport is skipped on frames where the resolver returns null. */
  camera: THREE.Camera | (() => THREE.Camera | null);
  /** Placement in CSS px (or `%` of the canvas), relative to the canvas top-left corner. The
   * part outside the canvas is cropped. */
  rect: ViewportRect & { unit?: 'px' | '%' };
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
  /** Default true */
  enabled?: boolean;
  /** Called every frame before the viewport renders (only while it is enabled). */
  onBeforeRender?: (vp: Viewport, delta: number) => void;
};

export type Viewport = {
  readonly id: string;
  readonly props: Readonly<ViewportProps>;
  /** The rendered rect in CSS px, relative to the canvas top-left corner, snapped to whole
   * device pixels (before cropping to the canvas). 0×0 until its first frame. */
  readonly rect: Readonly<ViewportRect>;
  readonly enabled: boolean;
};

type ViewportState = {
  id: string;
  props: ViewportProps;
  rect: ViewportRect;
  enabled: boolean;
  /** Needs a layout (rect, render target size, crop) before its next render. */
  isLayoutDirty: boolean;
  /** Nothing of it is on the canvas (empty or fully cropped rect). */
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
};

const viewports: ViewportState[] = [];
let enabledCount = 0;

// Canvas size and pixel ratio of the last layout (a change re-layouts every viewport)
let lastCanvasWidth = -1;
let lastCanvasHeight = -1;
let lastPixelRatio = -1;

// Scratch objects (no per-frame allocations)
const _canvasSize = new THREE.Vector2();
const _bufferSize = new THREE.Vector2();
const _prevClearColor = new THREE.Color();
const _prevViewport = new THREE.Vector4();

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

  const vp: ViewportState = {
    id: props.id,
    props,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    enabled: props.enabled !== false,
    isLayoutDirty: true,
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
  };
  viewports.push(vp);
  if (vp.enabled) enabledCount++;
  return vp;
};

/**
 * Deletes a viewport and disposes its render target and quad material.
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
};

/**
 * Enables or disables a viewport. A disabled viewport costs nothing per frame, and keeps its
 * render target (so re-enabling it is cheap).
 * @param id (string) viewport id
 * @param enabled (boolean)
 */
export const setViewportEnabled = (id: string, enabled: boolean) => {
  const vp = viewports.find((v) => v.id === id);
  if (!vp || vp.enabled === enabled) return;
  vp.enabled = enabled;
  enabledCount += enabled ? 1 : -1;
  if (enabled) vp.isLayoutDirty = true;
};

/**
 * Returns a viewport by id.
 * @param id (string) viewport id
 * @returns (object | undefined) {@link Viewport}
 */
export const getViewport = (id: string): Viewport | undefined =>
  viewports.find((vp) => vp.id === id);

const resolveCamera = (vp: ViewportState) => {
  const camera = vp.props.camera;
  return typeof camera === 'function' ? camera() : camera;
};

/** Computes the viewport's device px rect (snapped to whole pixels), its crop to the canvas,
 * and (re)sizes its render target. */
const layoutViewport = (
  vp: ViewportState,
  renderer: THREE.Renderer,
  pixelRatio: number,
  bufferWidth: number,
  bufferHeight: number
) => {
  vp.isLayoutDirty = false;
  const rect = vp.props.rect;
  const isPercent = rect.unit === '%';
  const scaleX = (isPercent ? _canvasSize.x / 100 : 1) * pixelRatio;
  const scaleY = (isPercent ? _canvasSize.y / 100 : 1) * pixelRatio;

  const x0 = Math.round(rect.x * scaleX);
  const y0 = Math.round(rect.y * scaleY);
  const x1 = Math.round((rect.x + rect.width) * scaleX);
  const y1 = Math.round((rect.y + rect.height) * scaleY);
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
    for (let i = 0; i < viewports.length; i++) viewports[i].isLayoutDirty = true;
  }
  renderer.getDrawingBufferSize(_bufferSize);

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
    if (!vp.enabled) continue;
    if (vp.isLayoutDirty) {
      layoutViewport(vp, renderer, pixelRatio, _bufferSize.x, _bufferSize.y);
    }
    if (vp.isEmpty) continue;

    vp.props.onBeforeRender?.(vp, delta);
    // onBeforeRender may disable it
    if (!vp.enabled) continue;
    const camera = resolveCamera(vp);
    if (!camera) continue;

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
