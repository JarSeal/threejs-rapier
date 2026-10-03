/**
 * Shared cell maths for every cell-keyed spatial structure (docs/plans/p346_spatial-domains.md
 * §3.4): SpatialGrid, and later the streaming cells (p353) and static instance cells (p308). For
 * a given cell size, a cell key means the same cell everywhere.
 *
 * Keys are packed with multiplication rather than bitwise ops, so the key stays a JS safe integer
 * (<= 2^53) instead of silently wrapping at 32 bits — see docs/plans/_DONE_p050_spatial-index.md
 * §2.4. 17 bits/axis is the largest budget whose cube fits under 2^53.
 */

export const CELL_AXIS_BITS = 17;
export const CELL_AXIS_SIZE = 1 << CELL_AXIS_BITS; // 131072 cells per axis
export const CELL_AXIS_OFFSET = CELL_AXIS_SIZE >> 1; // centers the range on the origin
export const CELL_AXIS_MIN = -CELL_AXIS_OFFSET;
export const CELL_AXIS_MAX = CELL_AXIS_OFFSET - 1;

export interface CellCoords {
  x: number;
  y: number;
  z: number;
}

/** The cell coordinate of a world coordinate on one axis, for `invCellSize = 1 / cellSize`. */
export function worldToCell(coord: number, invCellSize: number): number {
  // Math.floor, not `| 0`/Math.trunc — truncation rounds toward zero and
  // makes the cell straddling the origin double-width on each axis (§2.4).
  return Math.floor(coord * invCellSize);
}

/** Whether a cell coordinate can be packed. Outside this range keys collide (misbucket). */
export function isCellInRange(cx: number, cy: number, cz: number): boolean {
  return (
    cx >= CELL_AXIS_MIN &&
    cx <= CELL_AXIS_MAX &&
    cy >= CELL_AXIS_MIN &&
    cy <= CELL_AXIS_MAX &&
    cz >= CELL_AXIS_MIN &&
    cz <= CELL_AXIS_MAX
  );
}

/** Packs a cell coordinate into one safe-integer key. No range check (see `isCellInRange`). */
export function packCellKey(cx: number, cy: number, cz: number): number {
  return (
    (cx + CELL_AXIS_OFFSET) * CELL_AXIS_SIZE * CELL_AXIS_SIZE +
    (cy + CELL_AXIS_OFFSET) * CELL_AXIS_SIZE +
    (cz + CELL_AXIS_OFFSET)
  );
}

/** Inverse of `packCellKey`, written into `out` (returned). */
export function unpackCellKey(key: number, out: CellCoords): CellCoords {
  // CELL_AXIS_SIZE is a power of two, so these divisions are exact on the (safe-integer) key.
  out.x = Math.floor(key / (CELL_AXIS_SIZE * CELL_AXIS_SIZE)) - CELL_AXIS_OFFSET;
  out.y = (Math.floor(key / CELL_AXIS_SIZE) % CELL_AXIS_SIZE) - CELL_AXIS_OFFSET;
  out.z = (key % CELL_AXIS_SIZE) - CELL_AXIS_OFFSET;
  return out;
}

const _cell: CellCoords = { x: 0, y: 0, z: 0 };

/**
 * A cell's world-space AABB, written as 6 floats (`minX, minY, minZ, maxX, maxY, maxZ`) into
 * `out` at `offset`. Returns `out`.
 */
export function cellBounds<T extends Float32Array | number[]>(
  key: number,
  cellSize: number,
  out: T,
  offset = 0
): T {
  const c = unpackCellKey(key, _cell);
  out[offset] = c.x * cellSize;
  out[offset + 1] = c.y * cellSize;
  out[offset + 2] = c.z * cellSize;
  out[offset + 3] = (c.x + 1) * cellSize;
  out[offset + 4] = (c.y + 1) * cellSize;
  out[offset + 5] = (c.z + 1) * cellSize;
  return out;
}
