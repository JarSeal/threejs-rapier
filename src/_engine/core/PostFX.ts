/**
 * PostFX system (docs/plans/p070_post-fx-system.md): an ordered, per-scene chain of authored
 * PostFX passes (a `<name>.postFx.json` + `<name>.tsl.ts` pair each), rendered through a TSL
 * `RenderPipeline` instead of `renderer.render()` while it is switched on.
 *
 * Naming rule: one item of the chain is always a "PostFX pass" (`PostFxPass`, `postFxPass`,
 * `postFxPasses`), never a bare `pass`. TSL's `pass()` / `PassNode` is something else: the scene
 * render that feeds the chain, which is always called `scenePass` here.
 *
 * Changing the enabled PostFX pass set rebuilds the node chain (a shader recompile, so a
 * one-frame hitch), but a disabled PostFX pass then costs nothing. Switching the whole stack
 * off keeps the pipeline warm, so switching it back on does not recompile. The chain is also
 * rebuilt when the active camera changes (eg. the debug fly camera is toggled), because the TSL
 * scene pass binds its camera at construction. Resizing needs no rebuild.
 */
import * as THREE from 'three/webgpu';
import { mrt, normalView, output, pass } from 'three/tsl';
import { getConfig, IS_DEBUG_ENV } from './Config';
import { getRenderer } from './Renderer';
import {
  getCurrentSceneId,
  getGeneratedAppData,
  getRootScene,
  getSceneOpts,
  registerOnAllSceneEnterings,
  registerOnAllSceneExits,
} from './Scene';
import { getActiveCamera } from './CameraManager';
import { postFxFileObjects } from '../generatedAppFns';
import { lerror, llog, lwarn } from '../utils/Logger';
import type {
  PostFxPassApi,
  PostFxPassContext,
  PostFxPassFn,
  PostFxPassProps,
} from './PostFX/PostFXTypes';
import type { DebugData } from '../schemas/_helperSchemas';

type PostFxPassState = {
  id: string;
  props: PostFxPassProps;
  enabled: boolean;
  fxNode: PostFxPassFn;
  /** What fxNode returned in the current build (null when not in the chain). */
  api: PostFxPassApi | null;
};

/** A PostFX pass as listed by getPostFxPasses() (for the debugger, p071). */
export type PostFxPassInfo = {
  id: string;
  enabled: boolean;
  debugData?: DebugData;
  params: Record<string, unknown>;
};

let isMasterEnabled = false;
let isEnabled = false;
let postFxSceneId: string | null = null;
let postFxPasses: PostFxPassState[] = [];
let enabledPostFxPassCount = 0;
let pipeline: THREE.RenderPipeline | null = null;
let scenePass: THREE.PassNode | null = null;
/** The camera the current build's scene pass renders with. */
let builtCamera: THREE.Camera | null = null;
let needsRebuild = true;
const lastSize = new THREE.Vector2(-1, -1);
const curSize = new THREE.Vector2();

/**
 * Initializes the PostFX system. Nothing is built here: the pipeline is only created the
 * first time a scene's PostFX chain is actually rendered.
 */
export const initPostFX = () => {
  isMasterEnabled = getConfig().postFx?.enabled !== false;

  // The PostFX chain is scene-scoped: set up on every scene enter, released on every exit
  registerOnAllSceneExits('postFxSceneExit', disposePostFx);
  registerOnAllSceneEnterings('postFxSceneEnter', () => {
    const sceneId = getCurrentSceneId();
    if (sceneId) buildPostFxForScene(sceneId);
  });
};

const resolvePostFxPass = (
  entry: PostFxPassProps | string,
  sceneId: string
): PostFxPassState | null => {
  let props = entry;
  if (typeof props === 'string') {
    // Only dev builds carry the asset registries (the gatherer inlines scene PostFX passes)
    const registry = (
      getGeneratedAppData() as unknown as { postFx?: Record<string, PostFxPassProps> }
    ).postFx;
    const found = registry?.[props];
    if (!found) {
      lwarn(`Could not find PostFX pass with id "${props}" (scene "${sceneId}"), skipping it.`);
      return null;
    }
    props = found;
  }

  const fxNode = (postFxFileObjects as Record<string, { fxNode?: PostFxPassFn }>)[props.id]?.fxNode;
  if (!fxNode) {
    lwarn(
      `Could not locate the "fxNode" export for PostFX pass "${props.id}" (scene "${sceneId}"), skipping it. A PostFX pass needs a *.postFx.json file whose tslFile exports "fxNode" (PostFX passes written inline in a scene file are not supported).`
    );
    return null;
  }

  // Copied, so runtime param edits never write into the generated data
  return {
    id: props.id,
    props: { ...props, params: { ...props.params } },
    enabled: props.enabled !== false,
    fxNode,
    api: null,
  };
};

const countEnabledPostFxPasses = () => {
  enabledPostFxPassCount = 0;
  for (let i = 0; i < postFxPasses.length; i++) {
    if (postFxPasses[i].enabled) enabledPostFxPassCount++;
  }
};

/** Disposes the current build's nodes, but keeps the pipeline and the PostFX pass list. */
const disposePostFxNodes = () => {
  for (let i = 0; i < postFxPasses.length; i++) {
    postFxPasses[i].api?.onDispose?.();
    postFxPasses[i].api = null;
  }
  scenePass?.dispose();
  scenePass = null;
  builtCamera = null;
};

const buildPostFxPipeline = (
  renderer: THREE.WebGPURenderer,
  rootScene: THREE.Scene,
  camera: THREE.Camera
) => {
  disposePostFxNodes();

  const newScenePass = pass(rootScene, camera);
  const sceneColorNode = newScenePass.getTextureNode('output');
  let sceneNormalNode: THREE.Node | null = null;
  // A fresh object per PostFX pass (not a spread copy, which would trigger the getters)
  const createContext = (colorNode: THREE.Node): PostFxPassContext => ({
    renderer,
    scene: rootScene,
    camera,
    scenePass: newScenePass,
    colorNode,
    sceneColorNode,
    // Lazy, so the normal render target only exists when a PostFX pass actually reads it
    get sceneNormalNode() {
      if (!sceneNormalNode) {
        newScenePass.setMRT(mrt({ output, normal: normalView }));
        sceneNormalNode = newScenePass.getTextureNode('normal');
      }
      return sceneNormalNode;
    },
    get sceneDepthNode() {
      return newScenePass.getTextureNode('depth');
    },
  });

  let colorNode: THREE.Node = sceneColorNode;
  for (let i = 0; i < postFxPasses.length; i++) {
    const postFxPass = postFxPasses[i];
    if (!postFxPass.enabled) continue;
    try {
      const result = postFxPass.fxNode(
        postFxPass.props.params || {},
        createContext(colorNode),
        postFxPass.props.staticDefines
      );
      postFxPass.api = (result as THREE.Node).isNode
        ? { node: result as THREE.Node }
        : (result as PostFxPassApi);
      colorNode = postFxPass.api.node;
    } catch (err) {
      lerror(`Could not build PostFX pass "${postFxPass.id}", leaving it out of the chain.`, err);
    }
  }

  if (!pipeline) pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = colorNode;
  pipeline.needsUpdate = true;
  scenePass = newScenePass;
  builtCamera = camera;
  lastSize.set(-1, -1);
  needsRebuild = false;

  if (IS_DEBUG_ENV) {
    const ids = postFxPasses.filter((p) => p.api).map((p) => p.id);
    llog(`[PostFX] Built the PostFX chain (scene "${postFxSceneId}"): ${ids.join(' → ')}`);
  }
};

/** Calls the PostFX passes' onSetSize hooks when the drawing buffer size has changed. */
const updatePostFxSize = (renderer: THREE.WebGPURenderer) => {
  renderer.getDrawingBufferSize(curSize);
  if (curSize.equals(lastSize)) return;
  lastSize.copy(curSize);
  for (let i = 0; i < postFxPasses.length; i++) {
    postFxPasses[i].api?.onSetSize?.(curSize.x, curSize.y);
  }
};

/**
 * Returns the PostFX render pipeline to render the frame with, or null when the frame should
 * be rendered directly (PostFX is switched off, or no PostFX pass is enabled). (Re)builds the
 * pipeline when needed, so this is meant to be called once per frame, by renderScene().
 * @returns (THREE.RenderPipeline | null)
 */
export const getActivePostFxPipeline = () => {
  if (!isMasterEnabled || !isEnabled || !enabledPostFxPassCount) return null;
  const renderer = getRenderer();
  const camera = getActiveCamera();
  if (!renderer || !camera) return null;
  if (needsRebuild || !pipeline || camera !== builtCamera) {
    const rootScene = getRootScene();
    if (!rootScene) return null;
    buildPostFxPipeline(renderer, rootScene, camera);
  }
  updatePostFxSize(renderer);
  return pipeline;
};

/**
 * Sets up the PostFX pass chain of a scene (from its scene options: `postFx` and
 * `postFxEnabled`), replacing (and disposing) the previous one.
 * @param sceneId (string) scene id
 * @returns ({@link PostFxPassInfo}[]) the scene's PostFX passes
 */
export const buildPostFxForScene = (sceneId: string) => {
  disposePostFx();
  const opts = getSceneOpts(sceneId);
  const entries = opts?.postFx || [];
  const ids = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const postFxPass = resolvePostFxPass(entries[i], sceneId);
    if (!postFxPass) continue;
    if (ids.has(postFxPass.id)) {
      lwarn(`Duplicate PostFX pass "${postFxPass.id}" in scene "${sceneId}", skipping it.`);
      continue;
    }
    ids.add(postFxPass.id);
    postFxPasses.push(postFxPass);
  }
  countEnabledPostFxPasses();
  postFxSceneId = sceneId;
  isEnabled = opts?.postFxEnabled !== false;
  return getPostFxPasses();
};

/**
 * Switches the current scene's whole PostFX stack on or off (live). Has no effect when
 * AppConfig.postFx.enabled is false.
 * @param enabled (boolean)
 */
export const setPostFxEnabled = (enabled: boolean) => {
  if (enabled && !isMasterEnabled) {
    lwarn('PostFX is disabled in the app config (AppConfig.postFx.enabled), it stays off.');
  }
  isEnabled = enabled;
};

/**
 * Whether the current scene's PostFX stack is switched on (and allowed by the app config).
 * @returns boolean
 */
export const isPostFxEnabled = () => isMasterEnabled && isEnabled;

/**
 * Toggles the current scene's whole PostFX stack on / off.
 * @returns boolean (the new state)
 */
export const togglePostFx = () => {
  setPostFxEnabled(!isEnabled);
  return isPostFxEnabled();
};

const getPostFxPass = (id: string) => {
  const postFxPass = postFxPasses.find((p) => p.id === id);
  if (!postFxPass) {
    lwarn(`Could not find PostFX pass "${id}" in the current scene ("${postFxSceneId}").`);
  }
  return postFxPass;
};

/**
 * Adds or removes a PostFX pass from the chain (rebuilds the chain on the next frame).
 * @param id (string) PostFX pass id
 * @param enabled (boolean)
 */
export const setPostFxPassEnabled = (id: string, enabled: boolean) => {
  const postFxPass = getPostFxPass(id);
  if (!postFxPass || postFxPass.enabled === enabled) return;
  postFxPass.enabled = enabled;
  countEnabledPostFxPasses();
  needsRebuild = true;
};

/**
 * Toggles a PostFX pass in / out of the chain.
 * @param id (string) PostFX pass id
 * @returns boolean (the new state, false if the PostFX pass was not found)
 */
export const togglePostFxPass = (id: string) => {
  const postFxPass = getPostFxPass(id);
  if (!postFxPass) return false;
  setPostFxPassEnabled(id, !postFxPass.enabled);
  return postFxPass.enabled;
};

/**
 * Returns the current scene's PostFX passes in chain order.
 * @returns ({@link PostFxPassInfo}[])
 */
export const getPostFxPasses = (): PostFxPassInfo[] =>
  postFxPasses.map((p) => ({
    id: p.id,
    enabled: p.enabled,
    debugData: p.props.debugData,
    params: { ...p.props.params },
  }));

/**
 * Sets a PostFX pass param live. Goes through the PostFX pass's own setParam when it has one,
 * otherwise the chain is rebuilt (the param is only read at build time).
 * @param id (string) PostFX pass id
 * @param key (string) param key
 * @param value (unknown) param value
 */
export const setPostFxPassParam = (id: string, key: string, value: unknown) => {
  const postFxPass = getPostFxPass(id);
  if (!postFxPass) return;
  if (!postFxPass.props.params) postFxPass.props.params = {};
  postFxPass.props.params[key] = value;
  if (postFxPass.api?.setParam) {
    postFxPass.api.setParam(key, value);
  } else if (postFxPass.enabled) {
    needsRebuild = true;
  }
};

/** Forces the PostFX chain to be rebuilt on the next rendered frame. */
export const invalidatePostFxPipeline = () => {
  needsRebuild = true;
};

/** Disposes the PostFX pipeline, its nodes, and the current scene's PostFX pass list. */
export const disposePostFx = () => {
  disposePostFxNodes();
  pipeline?.dispose();
  pipeline = null;
  postFxPasses = [];
  enabledPostFxPassCount = 0;
  postFxSceneId = null;
  isEnabled = false;
  needsRebuild = true;
};
