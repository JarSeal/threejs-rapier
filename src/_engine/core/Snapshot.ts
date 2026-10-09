/**
 * Snapshots: renders a scene through a camera into an image, off screen, at any size, and reads
 * it back (example images for the Hub, material and model thumbnails, save game pictures). By
 * default it's what the canvas shows: the current view's scene and camera, through the scene's
 * PostFX, without the viewports (the axes gizmo, the env ball, picture-in-picture) and with the
 * debug helpers hidden.
 *
 * Two paths:
 * - **Direct** (any scene and camera, or PostFX off): the scene renders into a HalfFloat render
 *   target at the snapshot's size, then a quad applies the renderer's tone mapping and output
 *   colour space (`renderOutput()`, as the canvas's output pass and the viewports do) into an
 *   RGBA8 target, which is read back. The canvas is never touched.
 * - **PostFX** (the root scene with the active camera, its pipeline on): three's passes size
 *   themselves from the drawing buffer, so the renderer is resized to the snapshot (pixel ratio
 *   1) for the render, the pipeline renders into the RGBA8 target, and the renderer is put back.
 *   The resize clears the canvas, so the current frame is rendered again in the same task, before
 *   the browser shows it.
 *
 * It starts a new node frame first, so nodes three updates once per frame (a PostFX pass, a
 * shadow map) render again for the snapshot's size and camera.
 *
 * Everything the render changes (the renderer's target, size, clear and tone mapping state, the
 * camera's aspect, hidden helpers, a hidden background) is restored before the readback starts,
 * so the next frame renders as before.
 */
import * as THREE from 'three/webgpu';
import { texture, unpremultiplyAlpha } from 'three/tsl';
import { DEBUG_HELPER_USER_DATA_KEY } from '../debug/Profiler';
import { getActiveCamera } from './CameraManager';
import { renderFrameNow } from './MainLoop';
import { getActivePostFxPipeline } from './PostFX';
import { getRenderer } from './Renderer';
import { getRootScene } from './Scene';
import { getActiveView, isRuntimeViewActive } from './ViewManager';

export type SnapshotOpts = {
  /** The image's size in pixels (pixel ratio 1), 1 to {@link MAX_SNAPSHOT_SIZE} */
  width: number;
  height: number;
  /** Default: the current view's (the root scene in the Runtime view, else the editor view's) */
  scene?: THREE.Scene;
  /** Default: the current view's (the active camera in the Runtime view, the debug camera too) */
  camera?: THREE.Camera;
  /**
   * Render through the scene's PostFX pipeline (default true). Only the root scene with the
   * active camera has one, and only while it's on; otherwise, and with `transparent`, the
   * snapshot renders directly.
   */
  postFx?: boolean;
  /** Hide the debug helpers: `markDebugHelper`'s, the 3D symbols, three's `*Helper`s (default true) */
  hideDebugHelpers?: boolean;
  /**
   * A transparent background (default false): cleared to alpha 0, and the scene's background is
   * left out for the render (its environment lighting stays), eg. for a thumbnail of one object
   */
  transparent?: boolean;
  /** MSAA samples of the direct path (default 4 when the renderer antialiases, else 0) */
  samples?: number;
};

/** A snapshot's pixels: RGBA8, sRGB encoded as the canvas shows them, straight alpha, top row first */
export type Snapshot = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Whether it went through the scene's PostFX pipeline */
  postFx: boolean;
};

/** The largest side a snapshot can have (WebGPU's default `maxTextureDimension2D`) */
export const MAX_SNAPSHOT_SIZE = 8192;

const isDebugHelper = (obj: THREE.Object3D) =>
  Boolean(obj.userData[DEBUG_HELPER_USER_DATA_KEY]) ||
  Boolean(obj.userData.isHelperSymbol) ||
  obj.type.endsWith('Helper');

/** Sets the camera's aspect for the image, as the canvas resizer would; returns what puts it back */
const fitCamera = (camera: THREE.Camera, aspect: number) => {
  if (camera instanceof THREE.PerspectiveCamera) {
    const prevAspect = camera.aspect;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    return () => {
      camera.aspect = prevAspect;
      camera.updateProjectionMatrix();
    };
  }
  if (camera instanceof THREE.OrthographicCamera) {
    // Keeps the vertical extent, like a perspective camera's fov
    const { left, right } = camera;
    const centre = (left + right) / 2;
    const halfWidth = ((camera.top - camera.bottom) * aspect) / 2;
    camera.left = centre - halfWidth;
    camera.right = centre + halfWidth;
    camera.updateProjectionMatrix();
    return () => {
      camera.left = left;
      camera.right = right;
      camera.updateProjectionMatrix();
    };
  }
  return () => undefined;
};

/**
 * Starts a new node frame. three r186 updates `FRAME` nodes (a PostFX `pass()`, a shadow map)
 * once per node frame, so a snapshot rendered after the frame's own render would reuse them as
 * the canvas drew them (its size, its camera's aspect). The next animation frame counts on.
 */
const advanceNodeFrame = (renderer: THREE.WebGPURenderer) => {
  const nodeFrame = (renderer as unknown as { _nodes?: { nodeFrame?: { frameId: number } } })._nodes
    ?.nodeFrame;
  if (nodeFrame) nodeFrame.frameId++;
};

/** The current view's scene and camera, as `renderScene()` draws them */
const getViewSceneAndCamera = () => {
  if (isRuntimeViewActive()) return { scene: getRootScene(), camera: getActiveCamera() };
  const view = getActiveView();
  return { scene: view?.scene, camera: view?.getCamera() ?? undefined };
};

const createOutputTarget = (width: number, height: number) => {
  const target = new THREE.RenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    generateMipmaps: false,
  });
  target.texture.name = 'snapshotOutput';
  return target;
};

/**
 * Reads an RGBA8 render target's level 0 back as it's stored (sRGB stays encoded), top row first
 * on both backends: WebGPU pads its rows to 256 bytes, WebGL reads them bottom-up.
 * @param target (THREE.RenderTarget) an `UnsignedByteType` `RGBAFormat` target
 * @returns its pixels, `width × height × 4` bytes
 */
export const readRenderTargetRGBA8Async = async (target: THREE.RenderTarget) => {
  const renderer = getRenderer(true)!;
  if (
    target.texture.type !== THREE.UnsignedByteType ||
    target.texture.format !== THREE.RGBAFormat
  ) {
    throw new Error(`readRenderTargetRGBA8Async: '${target.texture.name}' isn't an RGBA8 target.`);
  }
  const { width, height } = target;
  const isBottomUp = Boolean((renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend);
  const data = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    width,
    height
  )) as Uint8Array;
  const rowBytes = width * 4;
  const stride = height > 1 ? (data.length - rowBytes) / (height - 1) : rowBytes;
  const out = new Uint8ClampedArray(rowBytes * height);
  for (let row = 0; row < height; row++) {
    const start = (isBottomUp ? height - 1 - row : row) * stride;
    out.set(data.subarray(start, start + rowBytes), row * rowBytes);
  }
  return out;
};

/** Renders the scene into a HalfFloat target, then through the output conversion into `output` */
const renderDirect = (
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  output: THREE.RenderTarget,
  samples: number,
  transparent: boolean
) => {
  const { width, height } = output;
  const sceneTarget = new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    samples,
    depthBuffer: true,
    generateMipmaps: false,
  });
  sceneTarget.texture.name = 'snapshotScene';
  const material = new THREE.NodeMaterial();
  material.name = 'snapshotOutput';
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // renderOutput() premultiplies its result: the snapshot stores straight alpha
  material.fragmentNode = unpremultiplyAlpha(
    texture(sceneTarget.texture).renderOutput(renderer.toneMapping, renderer.outputColorSpace)
  );
  const quad = new THREE.QuadMesh(material);
  const prevToneMapping = renderer.toneMapping;
  const prevColorSpace = renderer.outputColorSpace;
  try {
    // A render target is no output target: no tone mapping, working colour space
    renderer.setRenderTarget(sceneTarget);
    if (transparent) renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
    // The quad converts; the renderer adds nothing (the RenderPipeline.render() contract)
    renderer.setRenderTarget(output);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    quad.render(renderer);
  } finally {
    renderer.toneMapping = prevToneMapping;
    renderer.outputColorSpace = prevColorSpace;
    sceneTarget.dispose();
    material.dispose();
  }
};

/**
 * Renders a snapshot (see the module comment) and reads it back. After `InitEngine`. Turn it into
 * a file with {@link snapshotToBlobAsync}, or byte for byte with the dev files' `encodePNG`.
 * @param opts ({@link SnapshotOpts}) the size, and optionally the scene, camera and options
 * @returns ({@link Snapshot}) the pixels
 */
export const takeSnapshotAsync = async (opts: SnapshotOpts): Promise<Snapshot> => {
  const { width, height, hideDebugHelpers = true, transparent = false } = opts;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SNAPSHOT_SIZE ||
    height > MAX_SNAPSHOT_SIZE
  ) {
    throw new Error(
      `takeSnapshotAsync: the size must be whole pixels from 1 to ${MAX_SNAPSHOT_SIZE}, not ${width} × ${height}.`
    );
  }
  const renderer = getRenderer() as THREE.WebGPURenderer | null;
  if (!renderer?.hasInitialized()) {
    throw new Error(
      "takeSnapshotAsync: the renderer isn't initialized (snapshots run after InitEngine)."
    );
  }
  const viewDefaults = getViewSceneAndCamera();
  const scene = opts.scene ?? viewDefaults.scene;
  const camera = opts.camera ?? viewDefaults.camera;
  if (!scene || !camera)
    throw new Error('takeSnapshotAsync: there is no scene or camera to render.');

  const isPostFx =
    opts.postFx !== false &&
    !transparent &&
    isRuntimeViewActive() &&
    scene === getRootScene() &&
    camera === getActiveCamera();
  const postFxPipeline = isPostFx ? getActivePostFxPipeline() : null;

  // Saved state (restored below, before the readback)
  const prevTarget = renderer.getRenderTarget();
  const prevCubeFace = renderer.getActiveCubeFace();
  const prevMipmapLevel = renderer.getActiveMipmapLevel();
  const prevClearColor = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevPixelRatio = renderer.getPixelRatio();
  const prevBackground = scene.background;
  const prevBackgroundNode = scene.backgroundNode;
  const hidden: THREE.Object3D[] = [];
  if (hideDebugHelpers) {
    scene.traverseVisible((obj) => {
      if (obj !== scene && isDebugHelper(obj)) hidden.push(obj);
    });
  }

  const output = createOutputTarget(width, height);
  let restoreCamera: (() => void) | null = null;
  try {
    for (const obj of hidden) obj.visible = false;
    if (transparent) {
      scene.background = null;
      scene.backgroundNode = null;
    }
    restoreCamera = fitCamera(camera, width / height);
    advanceNodeFrame(renderer);
    if (postFxPipeline) {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      // Sizes the passes to the snapshot; the pipeline stays the scene's
      getActivePostFxPipeline();
      renderer.setRenderTarget(output);
      postFxPipeline.render();
    } else {
      const samples = opts.samples ?? (renderer.samples > 0 ? 4 : 0);
      renderDirect(renderer, scene, camera, output, samples, transparent);
    }
  } catch (err) {
    output.dispose();
    throw err;
  } finally {
    renderer.setRenderTarget(prevTarget, prevCubeFace, prevMipmapLevel);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    restoreCamera?.();
    if (transparent) {
      scene.background = prevBackground;
      scene.backgroundNode = prevBackgroundNode;
    }
    for (const obj of hidden) obj.visible = true;
    if (postFxPipeline) {
      renderer.setPixelRatio(prevPixelRatio);
      renderer.setSize(prevSize.x, prevSize.y, false);
      // The resize cleared the canvas: draw the frame again before the browser shows it
      renderFrameNow();
    }
  }

  try {
    return {
      width,
      height,
      data: await readRenderTargetRGBA8Async(output),
      postFx: Boolean(postFxPipeline),
    };
  } finally {
    output.dispose();
  }
};

export type SnapshotBlobOpts = {
  /** Default `image/png` (`image/webp`, `image/jpeg`: what the browser's canvas encodes) */
  type?: string;
  /** 0-1, for the lossy types */
  quality?: number;
};

/**
 * Encodes a snapshot through a canvas. A canvas stores premultiplied alpha, so a fully
 * transparent pixel loses its colour; the dev files' `encodePNG` keeps every byte.
 * @param snapshot ({@link Snapshot})
 * @param opts ({@link SnapshotBlobOpts}) the image type and quality
 */
export const snapshotToBlobAsync = async (
  { width, height, data }: Snapshot,
  { type = 'image/png', quality }: SnapshotBlobOpts = {}
) => {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.convertToBlob({ type, quality });
};
