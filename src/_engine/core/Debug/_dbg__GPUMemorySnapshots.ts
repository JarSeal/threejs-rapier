import type { Renderer } from 'three/webgpu';
import { getCurrentSceneId } from '../Scene';
import {
  getCurrentAllocationVisit,
  getLiveAllocations,
  getNextAllocationSeq,
} from './_dbg__GPUMemoryAllocations';
import type { AllocationKind } from './_dbg__GPUMemoryAllocations';
import { BOOT_OWNER, collectGPUAssets, type GPUAssetRow } from './_dbg__GPUMemoryOwners';

/**
 * One in-memory snapshot of the GPU memory figures and a live diff against it (p345 §2.5): for
 * leak hunting across scene switches (snapshot in scene A, go to B and back to A, diff).
 *
 * The leak list is by scene visit, not by scene id: whatever was created in the snapshot's visit
 * or a later one, other than the current visit, and is still allocated. So the second A's own
 * resources never hide what the first A left behind.
 */

export type GPUMemorySnapshot = {
  at: number;
  sceneId: string;
  /** The scene visit the snapshot was taken in */
  visit: number;
  /** A copy of `renderer.info.memory` */
  memory: Record<string, number>;
  /** Registered assets by row key */
  assets: Map<string, GPUAssetRow>;
  /** Allocations with a lower seq existed at the snapshot */
  nextSeq: number;
  /** Bytes of each allocation live at the snapshot, by seq */
  liveBytes: Map<number, number>;
};

export type MemoryChange = { key: string; before: number; after: number };

export type AssetChange = {
  key: string;
  id: string;
  kind: GPUAssetRow['kind'];
  owner: string;
  before: number;
  after: number;
};

export type AllocationGroup = {
  kind: AllocationKind;
  label: string;
  /** The scene and the scene visit it was created in */
  scene: string;
  visit: number;
  site?: string;
  count: number;
  bytes: number;
  /** Collected without a destroy call: still in three's totals */
  collected: number;
};

export type GPUMemoryDiff = {
  /** `info.memory` keys that changed */
  memory: MemoryChange[];
  /** Registered assets whose bytes changed (new, gone, grown or shrunk), largest change first */
  assets: AssetChange[];
  /** Created in the snapshot's scene visit or a later one, other than the current visit, and
   * still allocated: what a visit left behind, or something long-lived it created first */
  leftBehind: AllocationGroup[];
  /** Created since the snapshot in the current visit, still allocated (expected) */
  currentVisit: { count: number; bytes: number };
  /** Live at the snapshot, destroyed since */
  freed: { count: number; bytes: number };
};

let snapshot: GPUMemorySnapshot | null = null;

export const getGPUMemorySnapshot = () => snapshot;

export const clearGPUMemorySnapshot = () => {
  snapshot = null;
};

export const takeGPUMemorySnapshot = (renderer: Renderer) => {
  const liveBytes = new Map<number, number>();
  for (const [seq, allocation] of getLiveAllocations()) liveBytes.set(seq, allocation.bytes);
  snapshot = {
    at: Date.now(),
    sceneId: getCurrentSceneId() ?? BOOT_OWNER,
    visit: getCurrentAllocationVisit().visit,
    memory: { ...(renderer.info.memory as unknown as Record<string, number>) },
    assets: new Map(collectGPUAssets(renderer).map((row) => [row.key, row])),
    nextSeq: getNextAllocationSeq(),
    liveBytes,
  };
  return snapshot;
};

const absDesc =
  <T>(delta: (item: T) => number) =>
  (a: T, b: T) =>
    Math.abs(delta(b)) - Math.abs(delta(a));

/** The diff between the snapshot and now, or null without a snapshot. */
export const getGPUMemoryDiff = (renderer: Renderer): GPUMemoryDiff | null => {
  if (!snapshot) return null;
  const memoryNow = renderer.info.memory as unknown as Record<string, number>;
  const memory = Object.keys(memoryNow)
    .map((key) => ({ key, before: snapshot!.memory[key] ?? 0, after: memoryNow[key] }))
    .filter((change) => change.before !== change.after);

  const assets: AssetChange[] = [];
  const nowRows = new Map(collectGPUAssets(renderer).map((row) => [row.key, row]));
  for (const key of new Set([...snapshot.assets.keys(), ...nowRows.keys()])) {
    const then = snapshot.assets.get(key);
    const now = nowRows.get(key);
    const before = then?.bytes ?? 0;
    const after = now?.bytes ?? 0;
    if (before === after) continue;
    const row = (now ?? then)!;
    assets.push({ key, id: row.id, kind: row.kind, owner: row.owner, before, after });
  }
  assets.sort(absDesc((change) => change.after - change.before));

  const currentVisitNr = getCurrentAllocationVisit().visit;
  const groups = new Map<string, AllocationGroup>();
  const currentVisit = { count: 0, bytes: 0 };
  const live = getLiveAllocations();
  for (const allocation of live.values()) {
    if (allocation.visit < snapshot.visit) continue;
    if (allocation.visit === currentVisitNr) {
      if (allocation.seq < snapshot.nextSeq) continue;
      currentVisit.count++;
      currentVisit.bytes += allocation.bytes;
      continue;
    }
    const key = `${allocation.kind}|${allocation.label}|${allocation.visit}|${allocation.site ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: allocation.kind,
        label: allocation.label,
        scene: allocation.scene,
        visit: allocation.visit,
        ...(allocation.site ? { site: allocation.site } : {}),
        count: 0,
        bytes: 0,
        collected: 0,
      };
      groups.set(key, group);
    }
    group.count++;
    group.bytes += allocation.bytes;
    if (!allocation.ref.deref()) group.collected++;
  }
  const leftBehind = [...groups.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);

  const freed = { count: 0, bytes: 0 };
  for (const [seq, bytes] of snapshot.liveBytes) {
    if (live.has(seq)) continue;
    freed.count++;
    freed.bytes += bytes;
  }

  return { memory, assets, leftBehind, currentVisit, freed };
};
