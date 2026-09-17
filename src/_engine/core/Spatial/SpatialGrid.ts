import { IS_DEBUG_ENV } from '../Config';
import { lwarn } from '../../utils/Logger';

/**
 * Standalone, instantiable "what's near this point/volume" primitive.
 * See docs/plans/_DONE_p050_spatial-index.md for the full design rationale.
 *
 * Phase 1 scope (per that plan's §11): the grid itself only. It has no ECS
 * wiring, no membership hooks, and nothing else in the engine references it
 * yet. Positions/radii are pushed in explicitly via addMember/updatePosition/
 * updateRadius — a later phase wires those calls to ECS Transform data and
 * component-add/remove hooks.
 */

export interface ReadonlyVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SpatialGridOptions {
  /** World-space edge length of one grid cell. Tune against the occupancy histogram (§9 of the plan). */
  cellSize: number;
  /** Fixed capacity: how many members this grid instance can hold at once. */
  maxMembers: number;
  /** Members whose radius exceeds `cellSize * oversizedRadiusMultiplier` go into the oversized tier instead of a grid cell (default 2, per §4). */
  oversizedRadiusMultiplier?: number;
}

export interface SpatialGridStats {
  memberCount: number;
  oversizedCount: number;
  occupiedCellCount: number;
  maxIndexedRadius: number;
}

// Packed with multiplication rather than bitwise ops, so the key stays a
// JS safe integer (<= 2^53) instead of silently wrapping at 32 bits — see
// docs/plans/_DONE_p050_spatial-index.md §2.4. 17 bits/axis is the largest budget
// whose cube fits under 2^53.
const CELL_AXIS_BITS = 17;
const CELL_AXIS_SIZE = 1 << CELL_AXIS_BITS; // 131072 cells per axis
const CELL_AXIS_OFFSET = CELL_AXIS_SIZE >> 1; // centers the range on the origin
const CELL_AXIS_MIN = -CELL_AXIS_OFFSET;
const CELL_AXIS_MAX = CELL_AXIS_OFFSET - 1;

function worldToCell(coord: number, invCellSize: number): number {
  // Math.floor, not `| 0`/Math.trunc — truncation rounds toward zero and
  // makes the cell straddling the origin double-width on each axis (§2.4).
  return Math.floor(coord * invCellSize);
}

export class SpatialGrid {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly maxMembers: number;
  private readonly oversizedRadiusThreshold: number;
  private hasWarnedOutOfRange = false;

  private readonly entityToSlot = new Map<number, number>();
  private readonly slotToEntity: Int32Array;
  private liveCount = 0;

  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly radius: Float32Array;
  private readonly isOversized: Uint8Array;
  private readonly oversizedSlots = new Set<number>();
  private maxIndexedRadius = 0;

  /**
   * Packed world-cell key each slot landed in at the last rebuild. Not read
   * by anything in Phase 1 (the dynamic index does a full rebuild every
   * frame) — kept from day one so a future incremental-update pass (§6) can
   * diff against it without a data-model change. A plain number, not a
   * fixed-width typed array, because the packed key intentionally exceeds
   * 32 bits (see CELL_AXIS_BITS above).
   */
  private readonly lastCell: number[];

  // CSR rebuild artifacts, reallocated only when they need to grow.
  private readonly cellOfCompact: Uint32Array; // compact (non-oversized) member index -> dense cell index
  private readonly memberSlotByCompactIndex: Uint32Array; // compact member index -> slot
  private compactCount = 0;
  private readonly cellKeyToIndex = new Map<number, number>();
  private counts: Uint32Array;
  private cellStart: Uint32Array;
  private readonly items: Uint32Array; // dense cell index's members, as slots
  private occupiedCellCount = 0;

  // Dedup stamps: forward-compatible with multi-cell insert (Phase 4). With
  // today's origin-only insert a member can only ever be in one cell, so
  // this never actually filters anything yet — it's here so Phase 4 doesn't
  // need a data-model change, only a query-time behavior change.
  private readonly queryStamp: Uint32Array;
  private currentStamp = 0;

  // Bound once so queryInto/queryAABBInto never allocate a closure per call.
  private queryIntoOut: Uint32Array | null = null;
  private queryIntoCount = 0;
  private readonly queryIntoVisitor = (entityId: number): void => {
    if (this.queryIntoCount < this.queryIntoOut!.length) {
      this.queryIntoOut![this.queryIntoCount] = entityId;
    }
    this.queryIntoCount++;
  };

  constructor(opts: SpatialGridOptions) {
    this.cellSize = opts.cellSize;
    this.invCellSize = 1 / opts.cellSize;
    this.maxMembers = opts.maxMembers;
    this.oversizedRadiusThreshold = opts.cellSize * (opts.oversizedRadiusMultiplier ?? 2);

    this.slotToEntity = new Int32Array(this.maxMembers).fill(-1);
    this.posX = new Float32Array(this.maxMembers);
    this.posY = new Float32Array(this.maxMembers);
    this.posZ = new Float32Array(this.maxMembers);
    this.radius = new Float32Array(this.maxMembers);
    this.isOversized = new Uint8Array(this.maxMembers);
    this.lastCell = new Array(this.maxMembers).fill(NaN);

    this.cellOfCompact = new Uint32Array(this.maxMembers);
    this.memberSlotByCompactIndex = new Uint32Array(this.maxMembers);
    this.counts = new Uint32Array(0);
    this.cellStart = new Uint32Array(1);
    this.items = new Uint32Array(this.maxMembers);

    this.queryStamp = new Uint32Array(this.maxMembers);
  }

  addMember(entityId: number, x: number, y: number, z: number, radius: number): void {
    if (this.entityToSlot.has(entityId)) {
      this.updatePosition(entityId, x, y, z);
      this.updateRadius(entityId, radius);
      return;
    }
    if (this.liveCount >= this.maxMembers) {
      throw new Error(`SpatialGrid capacity (${this.maxMembers}) exceeded`);
    }
    const slot = this.liveCount++;
    this.entityToSlot.set(entityId, slot);
    this.slotToEntity[slot] = entityId;
    this.posX[slot] = x;
    this.posY[slot] = y;
    this.posZ[slot] = z;
    this.lastCell[slot] = NaN;
    this._setRadius(slot, radius);
    this._recomputeMaxIndexedRadius();
  }

  removeMember(entityId: number): void {
    const slot = this.entityToSlot.get(entityId);
    if (slot === undefined) return;

    const lastSlot = this.liveCount - 1;
    if (slot !== lastSlot) {
      this.posX[slot] = this.posX[lastSlot];
      this.posY[slot] = this.posY[lastSlot];
      this.posZ[slot] = this.posZ[lastSlot];
      this.radius[slot] = this.radius[lastSlot];
      this.isOversized[slot] = this.isOversized[lastSlot];
      this.lastCell[slot] = this.lastCell[lastSlot];
      if (this.oversizedSlots.has(lastSlot)) {
        this.oversizedSlots.delete(lastSlot);
        this.oversizedSlots.add(slot);
      } else {
        this.oversizedSlots.delete(slot);
      }
      const movedEntity = this.slotToEntity[lastSlot];
      this.slotToEntity[slot] = movedEntity;
      this.entityToSlot.set(movedEntity, slot);
    } else {
      this.oversizedSlots.delete(slot);
    }

    this.slotToEntity[lastSlot] = -1;
    this.entityToSlot.delete(entityId);
    this.liveCount--;
    this._recomputeMaxIndexedRadius();
  }

  updatePosition(entityId: number, x: number, y: number, z: number): void {
    const slot = this.entityToSlot.get(entityId);
    if (slot === undefined) return;
    this.posX[slot] = x;
    this.posY[slot] = y;
    this.posZ[slot] = z;
  }

  /** Radii change rarely (§4) — this is not a hot-path call. */
  updateRadius(entityId: number, radius: number): void {
    const slot = this.entityToSlot.get(entityId);
    if (slot === undefined) return;
    this._setRadius(slot, radius);
    this._recomputeMaxIndexedRadius();
  }

  has(entityId: number): boolean {
    return this.entityToSlot.has(entityId);
  }

  get memberCount(): number {
    return this.liveCount;
  }

  getStats(): SpatialGridStats {
    return {
      memberCount: this.liveCount,
      oversizedCount: this.oversizedSlots.size,
      occupiedCellCount: this.occupiedCellCount,
      maxIndexedRadius: this.maxIndexedRadius,
    };
  }

  /** Debug tooling only (§9 of the plan) — per-occupied-cell member counts as of the last rebuild, for tuning cellSize against an occupancy histogram. */
  getCellOccupancyCounts(): number[] {
    const counts = new Array<number>(this.occupiedCellCount);
    for (let c = 0; c < this.occupiedCellCount; c++) {
      counts[c] = this.cellStart[c + 1] - this.cellStart[c];
    }
    return counts;
  }

  private _setRadius(slot: number, radius: number): void {
    this.radius[slot] = radius;
    const oversized = radius > this.oversizedRadiusThreshold;
    this.isOversized[slot] = oversized ? 1 : 0;
    if (oversized) this.oversizedSlots.add(slot);
    else this.oversizedSlots.delete(slot);
  }

  private _recomputeMaxIndexedRadius(): void {
    let max = 0;
    for (let slot = 0; slot < this.liveCount; slot++) {
      if (!this.isOversized[slot] && this.radius[slot] > max) max = this.radius[slot];
    }
    this.maxIndexedRadius = max;
  }

  private _packCellKey(cx: number, cy: number, cz: number): number {
    if (
      IS_DEBUG_ENV &&
      !this.hasWarnedOutOfRange &&
      (cx < CELL_AXIS_MIN ||
        cx > CELL_AXIS_MAX ||
        cy < CELL_AXIS_MIN ||
        cy > CELL_AXIS_MAX ||
        cz < CELL_AXIS_MIN ||
        cz > CELL_AXIS_MAX)
    ) {
      this.hasWarnedOutOfRange = true;
      lwarn(
        `SpatialGrid: cell coordinate (${cx}, ${cy}, ${cz}) is outside the packable range ` +
          `(±${CELL_AXIS_OFFSET} per axis at cellSize ${this.cellSize}). Entities out here will ` +
          `silently misbucket. Increase cellSize or split into a per-domain grid (plan §5.1).`
      );
    }
    return (
      (cx + CELL_AXIS_OFFSET) * CELL_AXIS_SIZE * CELL_AXIS_SIZE +
      (cy + CELL_AXIS_OFFSET) * CELL_AXIS_SIZE +
      (cz + CELL_AXIS_OFFSET)
    );
  }

  /** Rebuilds the CSR buckets from current member positions. Call once per frame for a dynamic grid (§8). */
  rebuild(): void {
    this.compactCount = 0;
    for (let slot = 0; slot < this.liveCount; slot++) {
      if (this.isOversized[slot]) continue;
      this.memberSlotByCompactIndex[this.compactCount++] = slot;
    }

    this.cellKeyToIndex.clear();
    let nextCellIndex = 0;
    for (let i = 0; i < this.compactCount; i++) {
      const slot = this.memberSlotByCompactIndex[i];
      const cx = worldToCell(this.posX[slot], this.invCellSize);
      const cy = worldToCell(this.posY[slot], this.invCellSize);
      const cz = worldToCell(this.posZ[slot], this.invCellSize);
      const key = this._packCellKey(cx, cy, cz);
      this.lastCell[slot] = key;
      let cellIndex = this.cellKeyToIndex.get(key);
      if (cellIndex === undefined) {
        cellIndex = nextCellIndex++;
        this.cellKeyToIndex.set(key, cellIndex);
      }
      this.cellOfCompact[i] = cellIndex;
    }
    this.occupiedCellCount = nextCellIndex;

    if (this.counts.length < this.occupiedCellCount) {
      this.counts = new Uint32Array(this.occupiedCellCount);
      this.cellStart = new Uint32Array(this.occupiedCellCount + 1);
    } else {
      this.counts.fill(0, 0, this.occupiedCellCount);
    }

    for (let i = 0; i < this.compactCount; i++) {
      this.counts[this.cellOfCompact[i]]++;
    }
    let sum = 0;
    for (let c = 0; c < this.occupiedCellCount; c++) {
      this.cellStart[c] = sum;
      sum += this.counts[c];
    }
    this.cellStart[this.occupiedCellCount] = sum;

    // Reuse `counts` as per-cell write cursors — no extra allocation.
    const cursor = this.counts;
    for (let c = 0; c < this.occupiedCellCount; c++) cursor[c] = this.cellStart[c];
    for (let i = 0; i < this.compactCount; i++) {
      const cell = this.cellOfCompact[i];
      this.items[cursor[cell]++] = this.memberSlotByCompactIndex[i];
    }
  }

  /** Zero-allocation candidate visit for a sphere query. Candidates only — caller does the exact test (§7). */
  queryVisit(p: ReadonlyVec3, r: number, visit: (entityId: number) => void): void {
    const expanded = r + this.maxIndexedRadius;
    this._walkCellRange(
      p.x - expanded,
      p.x + expanded,
      p.y - expanded,
      p.y + expanded,
      p.z - expanded,
      p.z + expanded,
      visit
    );
  }

  /** Zero-allocation candidate visit for an AABB query. Candidates only — caller does the exact test (§7). */
  queryAABBVisit(min: ReadonlyVec3, max: ReadonlyVec3, visit: (entityId: number) => void): void {
    const e = this.maxIndexedRadius;
    this._walkCellRange(min.x - e, max.x + e, min.y - e, max.y + e, min.z - e, max.z + e, visit);
  }

  /** Same as queryVisit but writes into `out` and returns the candidate count (may exceed out.length; extras are dropped). */
  queryInto(p: ReadonlyVec3, r: number, out: Uint32Array): number {
    this.queryIntoOut = out;
    this.queryIntoCount = 0;
    this.queryVisit(p, r, this.queryIntoVisitor);
    return this.queryIntoCount;
  }

  /** Same as queryAABBVisit but writes into `out` and returns the candidate count (may exceed out.length; extras are dropped). */
  queryAABBInto(min: ReadonlyVec3, max: ReadonlyVec3, out: Uint32Array): number {
    this.queryIntoOut = out;
    this.queryIntoCount = 0;
    this.queryAABBVisit(min, max, this.queryIntoVisitor);
    return this.queryIntoCount;
  }

  private _walkCellRange(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    visit: (entityId: number) => void
  ): void {
    this.currentStamp++;
    const stamp = this.currentStamp;

    const minCx = worldToCell(minX, this.invCellSize);
    const maxCx = worldToCell(maxX, this.invCellSize);
    const minCy = worldToCell(minY, this.invCellSize);
    const maxCy = worldToCell(maxY, this.invCellSize);
    const minCz = worldToCell(minZ, this.invCellSize);
    const maxCz = worldToCell(maxZ, this.invCellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const cellIndex = this.cellKeyToIndex.get(this._packCellKey(cx, cy, cz));
          if (cellIndex === undefined) continue;
          const start = this.cellStart[cellIndex];
          const end = this.cellStart[cellIndex + 1];
          for (let k = start; k < end; k++) {
            const slot = this.items[k];
            if (this.queryStamp[slot] === stamp) continue;
            this.queryStamp[slot] = stamp;
            visit(this.slotToEntity[slot]);
          }
        }
      }
    }

    for (const slot of this.oversizedSlots) {
      if (this.queryStamp[slot] === stamp) continue;
      this.queryStamp[slot] = stamp;
      visit(this.slotToEntity[slot]);
    }
  }
}
