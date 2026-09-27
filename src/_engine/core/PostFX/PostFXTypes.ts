// Type-only module, so app-side PostFX pass `.tsl.ts` files can import it without pulling in runtime code.
// Uses three/webgpu's Node class type, not the loose three/tsl `Node` shim in types/three-node-material-helpers.d.ts.
import type * as THREE from 'three/webgpu';
import type { PostFxAsset } from '../../schemas/postFxSchema';

/** Everything a PostFX pass needs from the engine to build its node. */
export type PostFxPassContext = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** The shared TSL scene pass (the scene render that feeds the chain). */
  scenePass: THREE.PassNode;
  /** Output of the previous PostFX pass in the chain (the scene color for the first one), what this pass should build on. */
  colorNode: THREE.Node<'vec4'>;
  /** Unmodified scene buffers, for PostFX passes that need the raw G-buffer. */
  sceneColorNode: THREE.Node<'vec4'>;
  /** View-space normals and depth, from a non-MSAA pre-pass (sampleable like regular textures, unlike the MSAA scene pass's own depth). Lazy: reading either one is what adds the pre-pass, an extra scene render. */
  sceneNormalNode: THREE.Node;
  sceneDepthNode: THREE.Node;
};

/** What a PostFX pass may return instead of a bare Node, when it needs lifecycle hooks. */
export type PostFxPassApi = {
  /** The node this PostFX pass contributes to the chain. */
  node: THREE.Node<'vec4'>;
  /** Nodes whose updateBefore() cost is attributed to this PostFX pass when profiling. Defaults to [node]. */
  profileNodes?: THREE.Node[];
  /** Live param write-through, used by the debugger (docs/plans/p071_post-fx-debugger-ui.md). */
  setParam?: (key: string, value: unknown) => void;
  onSetSize?: (width: number, height: number) => void;
  onDispose?: () => void;
};

/** The contract-named `fxNode` export of a PostFX pass's `.tsl.ts` file. */
export type PostFxPassFn = (
  params: Record<string, unknown>,
  ctx: PostFxPassContext,
  defines?: Record<string, unknown>
) => THREE.Node<'vec4'> | PostFxPassApi;

/** A PostFX pass as it arrives in the scene data, after the gatherer has inlined it. */
export type PostFxPassProps = Omit<PostFxAsset, '$schema' | '__sourcePath' | '__saveData'>;

/** The currently built PostFX chain, as the debug profiler sees it. */
export type PostFxBuiltChain = {
  pipeline: THREE.RenderPipeline;
  /** The PostFX passes in the chain (enabled and built), in chain order. */
  postFxPasses: { id: string; profileNodes: THREE.Node[] }[];
};

/** Per-PostFX pass measurement (smoothed ms per frame), see getPostFxPassStats(). */
export type PostFxPassStats = {
  id: string;
  /** JS-side time in the PostFX pass's profileNodes' updateBefore(): render target setup,
   * uniform updates, draw dispatch. 0 for pure in-chain math PostFX passes. */
  cpuMs: number;
  /** GPU time of the render passes this PostFX pass issued, null when gpuAttribution is
   * 'shared' or GPU timing is unavailable. */
  gpuMs: number | null;
  /** 'exact': the PostFX pass issued render passes of its own, measured on their own.
   * 'shared': pure in-chain math, evaluated inside the final composite quad together with every
   * other 'shared' PostFX pass, so it can't be separated on the GPU (see compositeGpuMs). */
  gpuAttribution: 'exact' | 'shared';
};

/** PostFX measurement results, see getPostFxPassStats(). */
export type PostFxStats = {
  /** Whether GPU timing is available (timestamp queries supported by the device). */
  gpuAvailable: boolean;
  /** Measured frames (CPU) and frames with resolved GPU timestamps. */
  cpuSamples: number;
  gpuSamples: number;
  /** GPU time of the scene pass (render passes not issued by any PostFX pass). */
  sceneGpuMs: number | null;
  /** GPU time of the final composite quad, which includes every 'shared' PostFX pass. */
  compositeGpuMs: number | null;
  postFxPasses: PostFxPassStats[];
};
