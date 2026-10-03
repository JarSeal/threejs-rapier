import * as THREE from 'three/webgpu';
import type { Renderer } from 'three/webgpu';
import {
  _getGPUMemorySources,
  registerGPUMemorySource,
  type GPUMemoryResource,
} from '../../debug/GPUMemory';
import { lwarn } from '../../utils/Logger';
import { getPostFxBuiltChain } from '../PostFX';
import { getRenderer } from '../Renderer';
import { getCurrentSceneId, getRootScene } from '../Scene';
import { getActiveSkyBox } from '../SkyBox/SkyBox';
import { getEnvBake } from '../SkyBox/SkyEnvironment';
import { getStaticLayers } from '../SkyBox/SkyStaticLayers';
import { getLiveAllocations } from './_dbg__GPUMemoryAllocations';
import { getUncountedCubeBytes } from './_dbg__GPUMemoryOwners';

/**
 * GPU memory sources (p345 §2.3): engine and app GPU resources that aren't registered assets,
 * resolved to three's own bytes, so they add up with the "By owner" assets to
 * `info.memory.total`.
 *
 * A render target's internal depth texture and the attributes three builds from an array (eg. an
 * instance matrix's interleaved attributes) are not reachable from the object a source hands
 * over, so they are found through the allocation tracker's live objects.
 */

/** The owner of sources registered without one. */
export const ENGINE_OWNER = 'engine';

type MemoryMapEntry = number | { size: number; type: string };

export type GPUMemorySourceRow = {
  id: string;
  label: string;
  owner: string;
  bytes: number;
  /** Bytes per `info.memory` size category key ('texturesSize', 'attributesSize', …) */
  bySize: Record<string, number>;
  /** GPU objects counted */
  count: number;
  /** An estimate of what three leaves out of them (cube textures, {@link getUncountedCubeBytes}) */
  uncounted: number;
};

const ATTRIBUTE_KINDS = new Set([
  'attribute',
  'indexAttribute',
  'storageAttribute',
  'indirectStorageAttribute',
]);

/** The tracked objects a source's object stands for: textures by their render target, attributes
 * by their array. Built once per collect. */
const buildTrackedIndex = () => {
  const byRenderTarget = new Map<object, object[]>();
  const byArray = new Map<object, object[]>();
  const add = (map: Map<object, object[]>, key: object, o: object) => {
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  };
  for (const allocation of getLiveAllocations().values()) {
    const o = allocation.ref.deref();
    if (!o) continue;
    if (allocation.kind === 'texture') {
      const renderTarget = (o as THREE.Texture).renderTarget;
      if (renderTarget) add(byRenderTarget, renderTarget, o);
    } else if (ATTRIBUTE_KINDS.has(allocation.kind)) {
      // An interleaved attribute's `array` is its buffer's
      const array = (o as THREE.BufferAttribute).array;
      if (array) add(byArray, array, o);
    }
  }
  return { byRenderTarget, byArray };
};

const warnedSources = new Set<string>();

/**
 * Every registered source with three's bytes, largest first. `counted` holds the GPU objects
 * already counted (by the "By owner" assets): those count 0 here, and each one counted here is
 * added to it, so a GPU object two sources share counts once, for the first.
 */
export const collectGPUMemorySources = (
  renderer: Renderer,
  counted: Set<object>
): GPUMemorySourceRow[] => {
  const memoryMap = (renderer.info as unknown as { memoryMap: WeakMap<object, MemoryMapEntry> })
    .memoryMap;
  const tracked = buildTrackedIndex();
  const rows: GPUMemorySourceRow[] = [];

  for (const source of _getGPUMemorySources().values()) {
    const owner = typeof source.owner === 'function' ? source.owner() : source.owner;
    const row: GPUMemorySourceRow = {
      id: source.id,
      label: source.label,
      owner: owner || ENGINE_OWNER,
      bytes: 0,
      bySize: {},
      count: 0,
      uncounted: 0,
    };
    rows.push(row);

    /** @param target the render target `o` belongs to (a cube target's texture has no size) */
    const countObject = (o: object | null | undefined, target?: THREE.RenderTarget) => {
      if (!o || counted.has(o)) return;
      const entry = memoryMap.get(o);
      if (entry === undefined) return;
      counted.add(o);
      const bytes = typeof entry === 'number' ? entry : entry.size;
      const sizeKey = typeof entry === 'number' ? 'texturesSize' : `${entry.type}Size`;
      row.bySize[sizeKey] = (row.bySize[sizeKey] ?? 0) + bytes;
      row.bytes += bytes;
      row.count++;
      if ((o as THREE.Texture).isTexture) {
        row.uncounted += getUncountedCubeBytes(renderer, o as THREE.Texture, bytes, target);
      }
    };
    const countAttribute = (
      attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
    ) => {
      countObject(attribute);
      for (const o of tracked.byArray.get(attribute.array) ?? []) countObject(o);
    };
    const countResource = (resource: GPUMemoryResource | null | undefined) => {
      if (!resource) return;
      if ((resource as THREE.RenderTarget).isRenderTarget) {
        const target = resource as THREE.RenderTarget;
        for (const texture of target.textures) countObject(texture, target);
        countObject(target.depthTexture, target);
        for (const o of tracked.byRenderTarget.get(target) ?? []) countObject(o, target);
      } else if ((resource as THREE.Texture).isTexture) {
        countObject(resource);
      } else if ((resource as THREE.BufferGeometry).isBufferGeometry) {
        const geometry = resource as THREE.BufferGeometry;
        for (const name in geometry.attributes) countAttribute(geometry.attributes[name]);
        if (geometry.index) countAttribute(geometry.index);
      } else {
        countAttribute(resource as THREE.BufferAttribute);
      }
    };

    try {
      for (const resource of source.getResources()) countResource(resource);
    } catch (err) {
      if (warnedSources.has(source.id)) continue;
      warnedSources.add(source.id);
      lwarn(`[GPU memory] Source "${source.id}" threw, its row may be incomplete.`, err);
    }
  }

  return rows.sort((a, b) => b.bytes - a.bytes);
};

// --- ENGINE SOURCES ---

/** PMREMGenerator's working set (private in three r186): what a long-lived generator keeps. */
type PMREMGeneratorInternals = {
  _pingPongRenderTarget: THREE.RenderTarget | null;
  _lodMeshes: THREE.Mesh[];
  _backgroundBox: THREE.Mesh | null;
};

/** A shadow map's VSM blur targets, kept on the map when it's an array (three r186, ShadowNode). */
type ShadowMapInternals = {
  _vsmShadowMapVertical?: THREE.RenderTarget;
  _vsmShadowMapHorizontal?: THREE.RenderTarget;
};

/** A ShadowNode's targets (three r186): a VSM shadow keeps its blur pair here, not on the map. */
type ShadowNodeInternals = {
  shadowMap: THREE.RenderTarget | null;
  vsmShadowMapVertical: THREE.RenderTarget | null;
  vsmShadowMapHorizontal: THREE.RenderTarget | null;
};

/** Each shadow map's ShadowNode. three keeps a light's node in a module-private WeakMap, so a
 * light's VSM blur pair can't be reached from the light. */
const shadowNodesByMap = new WeakMap<THREE.RenderTarget, ShadowNodeInternals>();
let isShadowNodeSetupWrapped = false;

/** Records every ShadowNode against the map its setupShadow() assigns to `light.shadow.map`.
 * Shadows set up before this ran are missed until they are set up again. */
const wrapShadowNodeSetup = () => {
  if (isShadowNodeSetupWrapped) return;
  isShadowNodeSetupWrapped = true;
  const proto = THREE.ShadowNode.prototype as unknown as {
    setupShadow: (this: ShadowNodeInternals, builder: unknown) => unknown;
  };
  const setupShadow = proto.setupShadow;
  proto.setupShadow = function (builder) {
    const result = setupShadow.call(this, builder);
    if (this.shadowMap) shadowNodesByMap.set(this.shadowMap, this);
    return result;
  };
};

const getSkyBoxOwner = () => getActiveSkyBox()?.sceneId;

const collectFromRootScene = <T>(fn: (o: THREE.Object3D, out: T[]) => void) => {
  const out: T[] = [];
  getRootScene()?.traverse((o) => fn(o, out));
  return out;
};

/**
 * The render targets a node graph holds: every node reachable through its children, checked for
 * own properties that are render targets or arrays of them. That covers TSL's PassNode
 * (`renderTarget`) and the effect nodes, which keep theirs in private fields (eg. BloomNode's
 * `_renderTargetsHorizontal`), without knowing any of them by name.
 */
const collectNodeRenderTargets = (root: THREE.Node) => {
  const targets = new Set<THREE.RenderTarget>();
  const visited = new Set<THREE.Node>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const value of Object.values(node)) {
      if ((value as THREE.RenderTarget | null)?.isRenderTarget) {
        targets.add(value as THREE.RenderTarget);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if ((item as THREE.RenderTarget | null)?.isRenderTarget) targets.add(item);
        }
      }
    }
    for (const child of node.getChildren()) stack.push(child);
  }
  return targets;
};

/** Registers the engine's own sources (once, from the GPU memory tab's creation, before the
 * first render). Viewports register their own (Viewports.ts). */
export const registerEngineGPUMemorySources = () => {
  wrapShadowNodeSetup();

  registerGPUMemorySource({
    id: 'renderer.output',
    label: 'Renderer output target (MSAA, output pass)',
    // The renderer's own full-canvas target, per output target (three r186, private)
    getResources: () =>
      (
        getRenderer() as unknown as {
          _frameBufferTargets?: Map<unknown, THREE.RenderTarget>;
        } | null
      )?._frameBufferTargets?.values() ?? [],
  });

  registerGPUMemorySource({
    id: 'postFx',
    label: 'PostFX chain',
    owner: getCurrentSceneId,
    getResources: () => {
      const outputNode = getPostFxBuiltChain()?.pipeline.outputNode;
      return outputNode ? collectNodeRenderTargets(outputNode) : [];
    },
  });

  registerGPUMemorySource({
    id: 'shadowMaps',
    label: 'Shadow maps',
    owner: getCurrentSceneId,
    getResources: () =>
      collectFromRootScene<THREE.RenderTarget | null | undefined>((o, out) => {
        // Also a light that stopped casting: its map stays allocated
        const light = o as THREE.Light & { shadow?: THREE.LightShadow };
        const map = light.isLight ? light.shadow?.map : null;
        if (!map) return;
        const internals = map as unknown as ShadowMapInternals;
        const node = shadowNodesByMap.get(map);
        out.push(
          map,
          internals._vsmShadowMapVertical,
          internals._vsmShadowMapHorizontal,
          node?.vsmShadowMapVertical,
          node?.vsmShadowMapHorizontal
        );
      }),
  });

  registerGPUMemorySource({
    id: 'instancedMeshes',
    label: 'Instance buffers (InstancedMesh)',
    owner: getCurrentSceneId,
    getResources: () =>
      collectFromRootScene<THREE.InstancedBufferAttribute | null>((o, out) => {
        const mesh = o as THREE.InstancedMesh;
        if (mesh.isInstancedMesh) out.push(mesh.instanceMatrix, mesh.instanceColor);
      }),
  });

  registerGPUMemorySource({
    id: 'skyBox.envBake',
    label: 'Sky box env bake',
    owner: getSkyBoxOwner,
    getResources: function* () {
      const bake = getEnvBake();
      if (!bake) return;
      yield bake.target;
      const generator = bake.generator as unknown as PMREMGeneratorInternals;
      yield generator._pingPongRenderTarget;
      for (const mesh of generator._lodMeshes) yield mesh.geometry;
      yield generator._backgroundBox?.geometry;
    },
  });

  registerGPUMemorySource({
    id: 'skyBox.staticLayers',
    label: 'Sky box nebula cube',
    owner: getSkyBoxOwner,
    getResources: function* () {
      const bake = getStaticLayers();
      if (!bake) return;
      yield bake.target;
      yield bake.mesh.geometry;
    },
  });

  registerGPUMemorySource({
    id: 'skyBox.pmrem',
    label: 'Sky box PMREM (texture sky)',
    owner: getSkyBoxOwner,
    getResources: function* () {
      const active = getActiveSkyBox();
      // A composite sky box's environment is the env bake's target
      if (!active || active.isComposite) return;
      const environment = active.textures.environment;
      yield environment?.renderTarget ?? environment;
    },
  });
};
