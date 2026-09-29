import * as THREE from 'three/webgpu';
import { createDebuggerTab } from '../../debug/DebuggerGUI';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { BOX_EDGE_SEGMENT_COUNT, createLines, LineObject, writeBox3Edges } from '../LineManager';
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
const VISUALIZER_DEFAULT_COLOR = 0xff0000;

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

// --- VISUALIZER (docs/plans/p125_spatial-index-system-visualizer.md) ---
// One line, created once and hidden; the toggle only flips visibility and the `enabled`
// flag the refill system reads, so nothing is recreated per toggle.

const VISUALIZER_LINE_ID = 'SPATIAL_GRID_DEBUG_VISUALIZER';
// Ceiling for the FIXED line buffer. Occupied cells are bounded only by maxEntities
// (100k by default), far too much to pre-allocate for a debug overlay; past this the line
// drops the extra boxes and warns once.
const VISUALIZER_MAX_CELLS = 4096;

let visualizerLine: LineObject | null = null;
let visualizerEnabled = false;
let cellBounds = new Float32Array(VISUALIZER_MAX_CELLS * 6);
const scratchBox = new THREE.Box3();

const setVisualizerEnabled = (enabled: boolean) => {
  visualizerEnabled = enabled;
  visualizerLine?.setVisible(enabled);
};

/** A uniform write — no geometry rebuild. */
const setVisualizerColor = (color: number) => visualizerLine?.setColor(color);

/** Refills the wireframe from the grid's last rebuild. LATE_MAIN, so after the
 * APP_POST_PHYSICS rebuild. Only the default world is drawn — there is one line. */
const spatialGridVisualizerSystem = (world: ECSWorld) => {
  if (!visualizerEnabled || !visualizerLine || world !== getECSWorld()) return;

  // Re-read every frame: setSpatialGridCellSize swaps the grid instance.
  const grid = getSpatialGrid(world);
  let count = grid.getOccupiedCellBoundsInto(cellBounds);
  if (count * 6 > cellBounds.length) {
    // Rare (only when the count first outgrows the buffer). Everything past
    // VISUALIZER_MAX_CELLS is dropped by the FIXED line, with its own warning.
    cellBounds = new Float32Array(count * 6 * 2);
    count = grid.getOccupiedCellBoundsInto(cellBounds);
  }

  const writer = visualizerLine.beginWrite();
  for (let c = 0; c < count; c++) {
    const i = c * 6;
    scratchBox.min.set(cellBounds[i], cellBounds[i + 1], cellBounds[i + 2]);
    scratchBox.max.set(cellBounds[i + 3], cellBounds[i + 4], cellBounds[i + 5]);
    writeBox3Edges(writer, scratchBox);
  }
  visualizerLine.endWrite();
};

const initSpatialGridVisualizer = (enabled: boolean, color: number) => {
  visualizerLine = createLines({
    id: VISUALIZER_LINE_ID,
    capacity: VISUALIZER_MAX_CELLS * BOX_EDGE_SEGMENT_COUNT,
    growth: 'FIXED',
    // Up to 12 segments per occupied cell; instanced quads would cost far more than 1px lines.
    backend: 'THIN',
    // Created once and outlives scenes, so a scene switch must not dispose it.
    persistent: true,
  });
  setVisualizerColor(color);
  setVisualizerEnabled(enabled);

  ECSWorld.registerPlugin((world) => {
    world.addSystem(
      ECSSystemStage.LATE_MAIN,
      'spatialGridVisualizerSystem',
      spatialGridVisualizerSystem
    );
  });
};

export const _createSpatialGridDebugGUI = () => {
  const world = getECSWorld();
  const settings = {
    cellSize: DEFAULT_CELL_SIZE,
    visualizerEnabled: false,
    visualizerColor: VISUALIZER_DEFAULT_COLOR,
  };
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
    persistKeys: ['cellSize', 'visualizerEnabled', 'visualizerColor'],
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
            title: 'Visualizer',
            content: [
              {
                key: 'visualizerEnabled',
                label: 'Show grid wireframe',
                onChange: (value) => setVisualizerEnabled(Boolean(value)),
              },
              {
                key: 'visualizerColor',
                label: 'Wireframe color',
                view: 'color',
                onChange: (value) => setVisualizerColor(Number(value)),
              },
            ],
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
  initSpatialGridVisualizer(settings.visualizerEnabled, settings.visualizerColor);
};
