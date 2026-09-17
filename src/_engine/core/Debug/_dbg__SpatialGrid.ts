import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { getECSWorld } from '../ECS';
import {
  getLastRebuildDurationMs,
  getOracleMismatchCount,
  getSpatialGrid,
  isSpatialGridOracleEnabled,
  setSpatialGridCellSize,
  setSpatialGridOracleEnabled,
} from '../Spatial/SpatialIndexSystem';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';

const LS_KEY = 'AEK_debugSpatialGrid';
const DEFAULT_CELL_SIZE = 20;

type LSData = { cellSize: number };

/**
 * Debug-only occupancy histogram: how many members each occupied cell
 * holds, bucketed by exact count. Meant to guide cellSize tuning (§9 of
 * docs/plans/p050_spatial-index.md) — a handful of very full cells next to
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
  const savedLSData = lsGetItem(LS_KEY, { cellSize: DEFAULT_CELL_SIZE }) as LSData;
  if (savedLSData.cellSize !== DEFAULT_CELL_SIZE) {
    setSpatialGridCellSize(world, savedLSData.cellSize);
  }

  const icon = getSvgIcon('aspectRatio');
  createDebuggerTab({
    id: 'spatialGridControls',
    buttonText: icon,
    title: 'Spatial index',
    orderNr: 16,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY),
        onClear: () => lsRemoveItem(LS_KEY),
        watchKey: LS_KEY,
      });
      const { container, debugGUI: pane } = createNewDebuggerPane(
        'spatialGrid',
        `${icon} Spatial Index (docs/plans/p050_spatial-index.md)`,
        [clearTabBtn]
      );

      const cellSizeState = { cellSize: savedLSData.cellSize };
      pane
        .addBinding(cellSizeState, 'cellSize', { label: 'Cell size', min: 0.1, step: 0.5 })
        .on('change', (ev) => {
          setSpatialGridCellSize(world, ev.value);
          lsSetItem(LS_KEY, { cellSize: ev.value });
        });

      const oracleState = { enabled: isSpatialGridOracleEnabled(world) };
      pane
        .addBinding(oracleState, 'enabled', {
          label: 'Brute-force oracle',
        })
        .on('change', (ev) => setSpatialGridOracleEnabled(world, ev.value));

      const statsState = {
        memberCount: 0,
        oversizedCount: 0,
        occupiedCellCount: 0,
        maxIndexedRadius: 0,
        lastRebuildMs: 0,
        oracleMismatches: 0,
      };
      const statsFolder = pane.addFolder({ title: 'Live stats', expanded: true });
      statsFolder.addBinding(statsState, 'memberCount', { label: 'Members', readonly: true });
      statsFolder.addBinding(statsState, 'oversizedCount', { label: 'Oversized', readonly: true });
      statsFolder.addBinding(statsState, 'occupiedCellCount', {
        label: 'Occupied cells',
        readonly: true,
      });
      statsFolder.addBinding(statsState, 'maxIndexedRadius', {
        label: 'Max indexed radius',
        readonly: true,
      });
      statsFolder.addBinding(statsState, 'lastRebuildMs', {
        label: 'Last rebuild (ms)',
        readonly: true,
        format: (v) => v.toFixed(3),
      });
      statsFolder.addBinding(statsState, 'oracleMismatches', {
        label: 'Oracle mismatches',
        readonly: true,
      });

      const histogramState = { text: '(no occupied cells)' };
      pane.addBinding(histogramState, 'text', {
        label: 'Occupancy histogram',
        readonly: true,
        multiline: true,
        rows: 8,
        interval: 0,
      });

      const refreshStats = () => {
        const grid = getSpatialGrid(world);
        const stats = grid.getStats();
        statsState.memberCount = stats.memberCount;
        statsState.oversizedCount = stats.oversizedCount;
        statsState.occupiedCellCount = stats.occupiedCellCount;
        statsState.maxIndexedRadius = stats.maxIndexedRadius;
        statsState.lastRebuildMs = getLastRebuildDurationMs(world);
        statsState.oracleMismatches = getOracleMismatchCount(world);
        histogramState.text = formatOccupancyHistogram(grid.getCellOccupancyCounts());
        pane.refresh();
      };
      // Debug-only polling — simplest way to keep a live readout current
      // without wiring a subscriber through the rebuild system for a panel
      // that's only open some of the time anyway.
      refreshStats();
      setInterval(refreshStats, 500);

      return container;
    },
  });
};
