import * as THREE from 'three/webgpu';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { getSvgIcon } from '../UI/icons/SvgIcon';
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
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';

const LS_KEY = 'AEK_debugSpatialGrid';
const DEFAULT_CELL_SIZE = 20;
const VISUALIZER_DEFAULT_COLOR = 0xff0000;

type LSData = { cellSize: number; visualizerEnabled: boolean; visualizerColor: number };
const DEFAULT_LS_DATA: LSData = {
  cellSize: DEFAULT_CELL_SIZE,
  visualizerEnabled: false,
  visualizerColor: VISUALIZER_DEFAULT_COLOR,
};

// Merged over the defaults: saves from before the visualizer existed only hold cellSize.
const readLSData = (): LSData => ({ ...DEFAULT_LS_DATA, ...(lsGetItem(LS_KEY, {}) as LSData) });

// Read-merge-write, so saving one field neither drops the others nor brings back values
// that the "clear tab" button removed.
const saveLSData = (patch: Partial<LSData>) => lsSetItem(LS_KEY, { ...readLSData(), ...patch });

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
let visualizerColor = VISUALIZER_DEFAULT_COLOR;
let cellBounds = new Float32Array(VISUALIZER_MAX_CELLS * 6);
const scratchBox = new THREE.Box3();

const setVisualizerEnabled = (enabled: boolean) => {
  visualizerEnabled = enabled;
  visualizerLine?.setVisible(enabled);
};

/** A uniform write — no geometry rebuild. */
const setVisualizerColor = (color: number) => {
  visualizerColor = color;
  visualizerLine?.setColor(color);
};

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

const initSpatialGridVisualizer = (saved: LSData) => {
  visualizerLine = createLines({
    id: VISUALIZER_LINE_ID,
    capacity: VISUALIZER_MAX_CELLS * BOX_EDGE_SEGMENT_COUNT,
    growth: 'FIXED',
    // Up to 12 segments per occupied cell; instanced quads would cost far more than 1px lines.
    backend: 'THIN',
    // Created once and outlives scenes, so a scene switch must not dispose it.
    persistent: true,
  });
  setVisualizerColor(saved.visualizerColor);
  setVisualizerEnabled(saved.visualizerEnabled);

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
  const savedLSData = readLSData();
  if (savedLSData.cellSize !== DEFAULT_CELL_SIZE) {
    setSpatialGridCellSize(world, savedLSData.cellSize);
  }

  initSpatialGridVisualizer(savedLSData);

  const icon = getSvgIcon('spatialGrid');
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
        `${icon} Spatial Index`,
        [clearTabBtn]
      );

      const cellSizeState = { cellSize: savedLSData.cellSize };
      pane
        .addBinding(cellSizeState, 'cellSize', { label: 'Cell size', min: 0.1, step: 0.5 })
        .on('change', (ev) => {
          setSpatialGridCellSize(world, ev.value);
          saveLSData({ cellSize: ev.value });
        });

      const oracleState = { enabled: isSpatialGridOracleEnabled(world) };
      pane
        .addBinding(oracleState, 'enabled', {
          label: 'Brute-force oracle',
        })
        .on('change', (ev) => setSpatialGridOracleEnabled(world, ev.value));

      const visualizerState = { enabled: visualizerEnabled, color: visualizerColor };
      const visualizerFolder = pane.addFolder({ title: 'Visualizer', expanded: true });
      visualizerFolder
        .addBinding(visualizerState, 'enabled', { label: 'Show grid wireframe' })
        .on('change', (ev) => {
          setVisualizerEnabled(ev.value);
          saveLSData({ visualizerEnabled: ev.value });
        });
      visualizerFolder
        .addBinding(visualizerState, 'color', { label: 'Wireframe color', view: 'color' })
        .on('change', (ev) => {
          setVisualizerColor(ev.value);
          saveLSData({ visualizerColor: ev.value });
        });

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
      // that's only open some of the time anyway. createDebuggerTab's container()
      // re-runs on every tab click (it isn't built once and hidden/shown), so this
      // must be cleared on teardown or revisiting the tab leaks a new interval each
      // time. container's own onRemoveCmp is already used internally (by
      // createNewDebuggerPane) to dispose the Tweakpane instance, so this is added
      // as its own child rather than overwriting that.
      refreshStats();
      const intervalId = setInterval(refreshStats, 500);
      container.add({ onRemoveCmp: () => clearInterval(intervalId) });

      return container;
    },
  });
};
