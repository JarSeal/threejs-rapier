import type { Renderer } from 'three/webgpu';
import { getCurrentSceneId } from '../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../SceneLoader';
import { BOOT_OWNER } from './_dbg__GPUMemoryOwners';

/**
 * Every GPU resource three's `renderer.info` tracks, recorded as it is created and dropped as it is
 * destroyed (p345 §2.5), so a snapshot diff can name what a scene left behind even when it is not a
 * registered asset (instance attributes, render targets, uniform buffers, programs).
 *
 * The tracker wraps `info`'s own create / destroy calls, installed when the renderer is created
 * (before its init()), so it sees everything three counts. Objects are held through WeakRefs: the
 * tracker never keeps a resource alive. One that is collected without a destroy call stays in
 * three's totals for good, and stays here, marked collected.
 */

export type AllocationKind =
  | 'texture'
  | 'attribute'
  | 'indexAttribute'
  | 'storageAttribute'
  | 'indirectStorageAttribute'
  | 'uniformBuffer'
  | 'program'
  | 'readbackBuffer';

export const ALLOCATION_KIND_LABELS: Record<AllocationKind, string> = {
  texture: 'Texture',
  attribute: 'Attribute',
  indexAttribute: 'Index attribute',
  storageAttribute: 'Storage attribute',
  indirectStorageAttribute: 'Indirect storage attr.',
  uniformBuffer: 'Uniform buffer',
  program: 'Program',
  readbackBuffer: 'Readback buffer',
};

export type Allocation = {
  /** Creation order, from 1 */
  seq: number;
  kind: AllocationKind;
  /** three's counted bytes */
  bytes: number;
  /** The scene loading or current when it was created, or {@link BOOT_OWNER} */
  scene: string;
  /** The scene visit it was created in (see {@link getCurrentAllocationVisit}) */
  visit: number;
  label: string;
  /** The first engine/app stack frame that led to it (only while call sites are recorded) */
  site?: string;
  ref: WeakRef<object>;
};

type MemoryMapEntry = number | { size: number };
type TrackedInfo = Renderer['info'] & {
  memoryMap: WeakMap<object, MemoryMapEntry>;
  [method: string]: unknown;
};

const live = new Map<number, Allocation>();
const byObject = new WeakMap<object, Allocation>();
let nextSeq = 1;
let isInstalled = false;
let isRecordingSites = false;

export const setRecordAllocationSites = (value: boolean) => {
  isRecordingSites = value;
};

/** The live allocations, in creation order. */
export const getLiveAllocations = () => live;

/** The seq the next allocation gets: everything below it existed when this was read. */
export const getNextAllocationSeq = () => nextSeq;

const current = { visit: 0, scene: '' };
let wasLoading = false;

/**
 * The scene visit allocations belong to now: the scene being loaded, else the current one. A new
 * visit starts when that scene changes or a load starts, so an A → B → A round trip is three
 * visits and what the first A left behind can be told from what the second A made. (Derived here
 * on each call: SceneLoader has no load-start hook.)
 */
export const getCurrentAllocationVisit = (): Readonly<typeof current> => {
  const isLoading = isCurrentlyLoading();
  const scene = (isLoading ? getNextSceneId() : null) ?? getCurrentSceneId() ?? BOOT_OWNER;
  if (scene !== current.scene || (isLoading && !wasLoading)) {
    current.visit++;
    current.scene = scene;
  }
  wasLoading = isLoading;
  return current;
};

/** Deep enough to get out of three's render call chain (V8 keeps 10 frames by default). */
const CALL_SITE_STACK_LIMIT = 50;

/** The first stack frame outside three and this file, as `path:line`. */
const getCallSite = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CALL_SITE_STACK_LIMIT;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  const lines = stack?.split('\n') ?? [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('/node_modules/') || line.includes('_dbg__GPUMemoryAllocations')) continue;
    const match = line.match(
      /\(?(?:https?:\/\/[^/]+)?\/?([^():\s]+?)(?:\?[^:]*)?:(\d+):\d+\)?\s*$/
    );
    if (match) return `${match[1]}:${match[2]}`;
  }
  return 'three';
};

type Labelled = {
  name?: string;
  isRenderTargetTexture?: boolean;
  isDepthTexture?: boolean;
  isCubeTexture?: boolean;
  width?: number;
  height?: number;
  depth?: number;
  isInterleavedBufferAttribute?: boolean;
  isInstancedBufferAttribute?: boolean;
  itemSize?: number;
  data?: { array?: ArrayLike<number> };
  array?: ArrayLike<number>;
  stage?: string;
};

const describe = (kind: AllocationKind, o: Labelled) => {
  if (kind === 'texture') {
    const what = o.isDepthTexture
      ? 'depth'
      : o.isRenderTargetTexture
        ? 'render target'
        : o.isCubeTexture
          ? 'cube'
          : 'texture';
    const size = `${o.width ?? '?'}×${o.height ?? '?'}${o.depth && o.depth > 1 ? `×${o.depth}` : ''}`;
    return `${o.name ? `"${o.name}" ` : ''}${what} ${size}`;
  }
  if (kind === 'uniformBuffer') return `group "${o.name ?? ''}"`;
  if (kind === 'program') return `${o.stage ?? ''} ${o.name ?? ''}`.trim();
  if (kind === 'readbackBuffer') return o.name || 'readback';
  const array = o.isInterleavedBufferAttribute ? o.data?.array : o.array;
  const type = `${o.isInterleavedBufferAttribute ? 'interleaved ' : ''}${o.isInstancedBufferAttribute ? 'instanced ' : ''}`;
  return `${o.name ? `"${o.name}" ` : ''}${type}×${o.itemSize ?? '?'} ${array?.constructor.name ?? ''}`.trim();
};

/** Wraps `renderer.info`'s create / destroy calls (once). Call before renderer.init(). */
export const installAllocationTracker = (renderer: Renderer) => {
  if (isInstalled) return;
  isInstalled = true;
  const info = renderer.info as TrackedInfo;

  const track = (create: string, kind: AllocationKind) => {
    const original = (info[create] as (o: object) => void).bind(info);
    info[create] = (o: object) => {
      original(o);
      const entry = info.memoryMap.get(o);
      const { visit, scene } = getCurrentAllocationVisit();
      const allocation: Allocation = {
        seq: nextSeq++,
        kind,
        bytes: entry === undefined ? 0 : typeof entry === 'number' ? entry : entry.size,
        scene,
        visit,
        label: describe(kind, o as Labelled),
        ...(isRecordingSites ? { site: getCallSite() } : {}),
        ref: new WeakRef(o),
      };
      byObject.set(o, allocation);
      live.set(allocation.seq, allocation);
    };
  };
  const untrack = (destroy: string) => {
    const original = (info[destroy] as (o: object) => void).bind(info);
    info[destroy] = (o: object) => {
      original(o);
      const allocation = byObject.get(o);
      if (!allocation) return;
      byObject.delete(o);
      live.delete(allocation.seq);
    };
  };

  track('createTexture', 'texture');
  track('createAttribute', 'attribute');
  track('createIndexAttribute', 'indexAttribute');
  track('createStorageAttribute', 'storageAttribute');
  track('createIndirectStorageAttribute', 'indirectStorageAttribute');
  track('createUniformBuffer', 'uniformBuffer');
  track('createProgram', 'program');
  track('createReadbackBuffer', 'readbackBuffer');
  untrack('destroyTexture');
  untrack('destroyAttribute');
  untrack('destroyUniformBuffer');
  untrack('destroyProgram');
  untrack('destroyReadbackBuffer');
};
