import { createDebuggerTab } from '../../debug/DebuggerGUI';
import { getECSWorld } from '../ECS';
import {
  getLastRebuildDurationMs,
  getOracleMismatchCount,
  getSpatialGrid,
  isSpatialGridOracleEnabled,
  setSpatialGridCellSize,
  setSpatialGridOracleEnabled,
} from '../Spatial/SpatialIndexSystem';

const LS_KEY = 'AEK_debugSpatialGrid';
const DEFAULT_CELL_SIZE = 20;

/**
 * Debug-only occupancy histogram: how many members each occupied cell
 * holds, bucketed by exact count. Meant to guide cellSize tuning (§9 of
 * docs/plans/_DONE_p050_spatial-index.md) — a handful of very full cells next to
 * many single-member ones is the signal that cellSize is too large (or an
 * area is genuinely dense and belongs in the oversized tier instead).
 */
function formatOccupancyHistogram(counts: number[]): string {
  if (counts.length === 0) return '(no occupied cells)';

  const freq = new Map<number, number>();
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const c of counts) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
    if (c < min) min = c;
    if (c > max) max = c;
    sum += c;
  }
  const avg = sum / counts.length;
  const maxFreq = Math.max(...freq.values());

  const lines = [`cells: ${counts.length}  min: ${min}  max: ${max}  avg: ${avg.toFixed(2)}`];
  for (const k of [...freq.keys()].sort((a, b) => a - b)) {
    const f = freq.get(k) ?? 0;
    const barLen = Math.max(1, Math.round((f / maxFreq) * 20));
    lines.push(`${String(k).padStart(4)} members: ${'#'.repeat(barLen)} (${f})`);
  }
  return lines.join('\n');
}

export const _createSpatialGridDebugGUI = () => {
  const world = getECSWorld();
  const settings = { cellSize: DEFAULT_CELL_SIZE };
  // Live values (not persisted), synced from the grid on every refresh
  const oracleState = { enabled: false };
  const statsState = {
    memberCount: 0,
    oversizedCount: 0,
    occupiedCellCount: 0,
    maxIndexedRadius: 0,
    lastRebuildMs: 0,
    oracleMismatches: 0,
  };
  const histogramState = { text: '(no occupied cells)' };

  createDebuggerTab({
    id: 'spatialGridControls',
    title: 'Spatial index',
    icon: 'spatialGrid',
    lsKey: LS_KEY,
    state: settings,
    persistKeys: ['cellSize'],
    // Debug-only polling: simplest way to keep a live readout current without wiring a
    // subscriber through the rebuild system (it only runs while the tab is visible)
    refreshIntervalMs: 500,
    onRefresh: () => {
      const grid = getSpatialGrid(world);
      const stats = grid.getStats();
      oracleState.enabled = isSpatialGridOracleEnabled(world);
      statsState.memberCount = stats.memberCount;
      statsState.oversizedCount = stats.oversizedCount;
      statsState.occupiedCellCount = stats.occupiedCellCount;
      statsState.maxIndexedRadius = stats.maxIndexedRadius;
      statsState.lastRebuildMs = getLastRebuildDurationMs(world);
      statsState.oracleMismatches = getOracleMismatchCount(world);
      histogramState.text = formatOccupancyHistogram(grid.getCellOccupancyCounts());
    },
    content: () => [
      {
        pane: true,
        content: [
          {
            key: 'cellSize',
            label: 'Cell size',
            min: 0.1,
            step: 0.5,
            onChange: (value) => setSpatialGridCellSize(world, Number(value)),
          },
          {
            key: 'enabled',
            target: oracleState,
            label: 'Brute-force oracle',
            onChange: (value) => setSpatialGridOracleEnabled(world, Boolean(value)),
          },
          {
            type: 'folder',
            title: 'Live stats',
            content: [
              { key: 'memberCount', target: statsState, label: 'Members', readonly: true },
              { key: 'oversizedCount', target: statsState, label: 'Oversized', readonly: true },
              {
                key: 'occupiedCellCount',
                target: statsState,
                label: 'Occupied cells',
                readonly: true,
              },
              {
                key: 'maxIndexedRadius',
                target: statsState,
                label: 'Max indexed radius',
                readonly: true,
              },
              {
                key: 'lastRebuildMs',
                target: statsState,
                label: 'Last rebuild (ms)',
                readonly: true,
                format: (v: number) => v.toFixed(3),
              },
              {
                key: 'oracleMismatches',
                target: statsState,
                label: 'Oracle mismatches',
                readonly: true,
              },
            ],
          },
          {
            key: 'text',
            target: histogramState,
            label: 'Occupancy histogram',
            readonly: true,
            multiline: true,
            rows: 8,
            interval: 0,
          },
        ],
      },
    ],
  });

  // Hydrated at registration
  if (settings.cellSize !== DEFAULT_CELL_SIZE) setSpatialGridCellSize(world, settings.cellSize);
};
