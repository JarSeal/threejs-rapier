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
  colorNode: THREE.Node;
  /** Unmodified scene buffers, for PostFX passes that need the raw G-buffer. */
  sceneColorNode: THREE.Node;
  /** View-space normals. Lazy: reading it is what adds the normal MRT output to the scene pass. */
  sceneNormalNode: THREE.Node;
  sceneDepthNode: THREE.Node;
};

/** What a PostFX pass may return instead of a bare Node, when it needs lifecycle hooks. */
export type PostFxPassApi = {
  /** The node this PostFX pass contributes to the chain. */
  node: THREE.Node;
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
) => THREE.Node | PostFxPassApi;

/** A PostFX pass as it arrives in the scene data, after the gatherer has inlined it. */
export type PostFxPassProps = Omit<PostFxAsset, '$schema' | '__sourcePath' | '__saveData'>;
