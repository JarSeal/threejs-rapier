import { describe, expect, test } from 'vitest';
import {
  CELL_AXIS_MAX,
  CELL_AXIS_MIN,
  cellBounds,
  isCellInRange,
  packCellKey,
  unpackCellKey,
  worldToCell,
} from './CellKey';

describe('worldToCell', () => {
  test('floors, so the cells around the origin are one cell wide', () => {
    const inv = 1 / 20;
    expect(worldToCell(0, inv)).toBe(0);
    expect(worldToCell(19.99, inv)).toBe(0);
    expect(worldToCell(20, inv)).toBe(1);
    expect(worldToCell(-0.01, inv)).toBe(-1);
    expect(worldToCell(-20, inv)).toBe(-1);
    expect(worldToCell(-20.01, inv)).toBe(-2);
  });
});

describe('packCellKey / unpackCellKey', () => {
  const corners = [CELL_AXIS_MIN, -1, 0, 1, CELL_AXIS_MAX];

  test('round trips every combination of the range’s edges and the origin', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (const x of corners) {
      for (const y of corners) {
        for (const z of corners) {
          const key = packCellKey(x, y, z);
          expect(Number.isSafeInteger(key)).toBe(true);
          expect(unpackCellKey(key, out)).toEqual({ x, y, z });
        }
      }
    }
  });

  test('gives distinct keys to distinct cells', () => {
    const keys = new Set<number>();
    for (const x of corners) {
      for (const y of corners) {
        for (const z of corners) keys.add(packCellKey(x, y, z));
      }
    }
    expect(keys.size).toBe(corners.length ** 3);
  });

  test('the key range is non-negative and stays under 2^53', () => {
    expect(packCellKey(CELL_AXIS_MIN, CELL_AXIS_MIN, CELL_AXIS_MIN)).toBe(0);
    expect(packCellKey(CELL_AXIS_MAX, CELL_AXIS_MAX, CELL_AXIS_MAX)).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER
    );
  });
});

describe('isCellInRange', () => {
  test('accepts the range and rejects one past it on each axis', () => {
    expect(isCellInRange(CELL_AXIS_MIN, 0, CELL_AXIS_MAX)).toBe(true);
    expect(isCellInRange(CELL_AXIS_MIN - 1, 0, 0)).toBe(false);
    expect(isCellInRange(0, CELL_AXIS_MAX + 1, 0)).toBe(false);
    expect(isCellInRange(0, 0, CELL_AXIS_MIN - 1)).toBe(false);
  });
});

describe('cellBounds', () => {
  test('writes the cell’s AABB at the offset', () => {
    const out = new Array<number>(8).fill(NaN);
    cellBounds(packCellKey(-1, 0, 2), 10, out, 2);
    expect(out).toEqual([NaN, NaN, -10, 0, 20, 0, 10, 30]);
  });

  test('a world point lies inside its own cell', () => {
    const cellSize = 7.5;
    const point = [-13.2, 0.4, 101.9];
    const [cx, cy, cz] = point.map((coord) => worldToCell(coord, 1 / cellSize));
    const [minX, minY, minZ, maxX, maxY, maxZ] = cellBounds(
      packCellKey(cx, cy, cz),
      cellSize,
      new Float32Array(6)
    );
    expect(point[0]).toBeGreaterThanOrEqual(minX);
    expect(point[0]).toBeLessThan(maxX);
    expect(point[1]).toBeGreaterThanOrEqual(minY);
    expect(point[1]).toBeLessThan(maxY);
    expect(point[2]).toBeGreaterThanOrEqual(minZ);
    expect(point[2]).toBeLessThan(maxZ);
  });
});
