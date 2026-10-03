import * as THREE from 'three/webgpu';
import { createDebuggerTab } from '../../debug/DebuggerGUI';
import { markDebugHelper } from '../../debug/Profiler';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import type { SpatialGrid } from '../Spatial/SpatialGrid';
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
const OVERSIZED_VISUALIZER_DEFAULT_COLOR = 0xffaa00;

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

// --- VISUALIZER (docs/plans/_DONE_p125_spatial-index-system-visualizer.md) ---
// Two overlays, each one line created once and hidden: the occupied cells, and the
// oversized tier's members (which bypass the grid, so they have no cell to draw). A toggle
// only flips visibility and the `enabled` flag the refill system reads, so nothing is
// recreated per toggle.

type BoxOverlay = {
  line: LineObject | null;
  enabled: boolean;
  bounds: Float32Array;
  /** Writes 6 floats per box into `out`, returns the box count (see SpatialGrid). */
  getBoundsInto: (grid: SpatialGrid, out: Float32Array) => number;
};

// Ceilings for the FIXED line buffers. Occupied cells are bounded only by maxEntities
// (100k by default), far too much to pre-allocate for a debug overlay; past these a line
// drops the extra boxes and warns once.
const VISUALIZER_MAX_CELLS = 4096;
const VISUALIZER_MAX_OVERSIZED = 256;

const cellOverlay: BoxOverlay = {
  line: null,
  enabled: false,
  bounds: new Float32Array(VISUALIZER_MAX_CELLS * 6),
  getBoundsInto: (grid, out) => grid.getOccupiedCellBoundsInto(out),
};
const oversizedOverlay: BoxOverlay = {
  line: null,
  enabled: false,
  bounds: new Float32Array(VISUALIZER_MAX_OVERSIZED * 6),
  getBoundsInto: (grid, out) => grid.getOversizedBoundsInto(out),
};
const scratchBox = new THREE.Box3();

const setOverlayEnabled = (overlay: BoxOverlay, enabled: boolean) => {
  overlay.enabled = enabled;
  overlay.line?.setVisible(enabled);
};

/** A uniform write — no geometry rebuild. */
const setOverlayColor = (overlay: BoxOverlay, color: number) => overlay.line?.setColor(color);

const refillOverlay = (overlay: BoxOverlay, grid: SpatialGrid) => {
  const line = overlay.line;
  if (!overlay.enabled || !line) return;

  let count = overlay.getBoundsInto(grid, overlay.bounds);
  if (count * 6 > overlay.bounds.length) {
    // Rare (only when the count first outgrows the buffer). Everything past the line's
    // capacity is dropped by the FIXED line, with its own warning.
    overlay.bounds = new Float32Array(count * 6 * 2);
    count = overlay.getBoundsInto(grid, overlay.bounds);
  }

  const b = overlay.bounds;
  const writer = line.beginWrite();
  for (let c = 0; c < count; c++) {
    const i = c * 6;
    scratchBox.min.set(b[i], b[i + 1], b[i + 2]);
    scratchBox.max.set(b[i + 3], b[i + 4], b[i + 5]);
    writeBox3Edges(writer, scratchBox);
  }
  line.endWrite();
};

/** Refills the overlays from the grid's last rebuild. LATE_MAIN, so after the
 * APP_POST_PHYSICS rebuild. Only the default world is drawn — there is one line each. */
const spatialGridVisualizerSystem = (world: ECSWorld) => {
  if (!(cellOverlay.enabled || oversizedOverlay.enabled) || world !== getECSWorld()) return;
  // Re-read every frame: setSpatialGridCellSize swaps the grid instance.
  const grid = getSpatialGrid(world);
  refillOverlay(cellOverlay, grid);
  refillOverlay(oversizedOverlay, grid);
};

const createOverlayLine = (id: string, maxBoxes: number) => {
  const line = createLines({
    id,
    capacity: maxBoxes * BOX_EDGE_SEGMENT_COUNT,
    growth: 'FIXED',
    // 12 segments per box; instanced quads would cost far more than 1px lines.
    backend: 'THIN',
    // Created once and outlives scenes, so a scene switch must not dispose it.
    persistent: true,
  });
  markDebugHelper(line.object3D);
  return line;
};

const initSpatialGridVisualizer = (settings: {
  visualizerEnabled: boolean;
  visualizerColor: number;
  oversizedVisualizerEnabled: boolean;
  oversizedVisualizerColor: number;
}) => {
  cellOverlay.line = createOverlayLine('SPATIAL_GRID_DEBUG_VISUALIZER', VISUALIZER_MAX_CELLS);
  oversizedOverlay.line = createOverlayLine(
    'SPATIAL_GRID_DEBUG_VISUALIZER_OVERSIZED',
    VISUALIZER_MAX_OVERSIZED
  );
  setOverlayColor(cellOverlay, settings.visualizerColor);
  setOverlayEnabled(cellOverlay, settings.visualizerEnabled);
  setOverlayColor(oversizedOverlay, settings.oversizedVisualizerColor);
  setOverlayEnabled(oversizedOverlay, settings.oversizedVisualizerEnabled);

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
    oversizedVisualizerEnabled: false,
    oversizedVisualizerColor: OVERSIZED_VISUALIZER_DEFAULT_COLOR,
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
    persistKeys: [
      'cellSize',
      'visualizerEnabled',
      'visualizerColor',
      'oversizedVisualizerEnabled',
      'oversizedVisualizerColor',
    ],
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
                onChange: (value) => setOverlayEnabled(cellOverlay, Boolean(value)),
              },
              {
                key: 'visualizerColor',
                label: 'Wireframe color',
                view: 'color',
                onChange: (value) => setOverlayColor(cellOverlay, Number(value)),
              },
              {
                key: 'oversizedVisualizerEnabled',
                label: 'Show oversized bounds',
                onChange: (value) => setOverlayEnabled(oversizedOverlay, Boolean(value)),
              },
              {
                key: 'oversizedVisualizerColor',
                label: 'Oversized color',
                view: 'color',
                onChange: (value) => setOverlayColor(oversizedOverlay, Number(value)),
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
  initSpatialGridVisualizer(settings);
};
