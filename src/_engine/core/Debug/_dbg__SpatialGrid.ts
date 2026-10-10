import * as THREE from 'three/webgpu';
import {
  createDebuggerTab,
  persistDebuggerTabValue,
  updateDebuggerTab,
} from '../../debug/DebuggerGUI';
import { markDebugHelper } from '../../debug/Profiler';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../ECS/SystemStages';
import type { SpatialGrid } from '../Spatial/SpatialGrid';
import type { LineObject } from '../LineManager';
import { BOX_EDGE_SEGMENT_COUNT, createLines, writeBox3Edges } from '../LineManager';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { getCurrentSceneId } from '../Scene';
import {
  DEFAULT_SPATIAL_DOMAIN,
  getLastRebuildDurationMs,
  getOracleCheckedQueryCount,
  getOracleMismatchCount,
  getSpatialDomain,
  getSpatialDomainIds,
  getSpatialDomainOptions,
  getSpatialDomainRebuildStats,
  getSpatialDomainSceneId,
  isSpatialGridOracleEnabled,
  reapplySpatialDomainOptions,
  setSpatialDomainOptionsOverride,
  setSpatialGridOracleEnabled,
} from '../Spatial/SpatialIndexSystem';

const TAB_ID = 'spatialGridControls';
const formatInt = (v: number) => v.toFixed(0);
const LS_KEY = 'AEK_debugSpatialGrid';

/** One domain's tab settings (docs/plans/_DONE_p346_spatial-domains.md §3.6). */
type DomainDebugSettings = {
  /** Overrides the cell size of the domain's world settings; absent = the app's. */
  cellSize?: number;
  /**
   * Overrides the cell size of a scene's settings, by scene id; absent = the app's (never the
   * world value, docs/plans/_DONE_p349_scene-scoped-spatial-domains.md §3.5).
   */
  cellSizeByScene?: Record<string, number>;
  showCells: boolean;
  cellsColor: number;
  showOversized: boolean;
  oversizedColor: number;
};

// DEFAULT keeps the colors the single-grid tab had; other domains get a pair from this list by
// their id, so a domain's color stays the same across reloads and registration orders.
const DEFAULT_DOMAIN_COLORS: [number, number] = [0xff0000, 0xffaa00];
const DOMAIN_COLORS: [number, number][] = [
  [0x00c8ff, 0x0066ff],
  [0x66ff33, 0x009933],
  [0xff33cc, 0x9900cc],
  [0xffff00, 0xcc9900],
  [0x00ffaa, 0x008866],
  [0xffffff, 0x999999],
];

const hashId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash);
};

const defaultDomainSettings = (id: string): DomainDebugSettings => {
  const [cellsColor, oversizedColor] =
    id === DEFAULT_SPATIAL_DOMAIN
      ? DEFAULT_DOMAIN_COLORS
      : DOMAIN_COLORS[hashId(id) % DOMAIN_COLORS.length];
  return { showCells: false, cellsColor, showOversized: false, oversizedColor };
};

const state: { selectedDomain: string; domains: Record<string, DomainDebugSettings> } = {
  selectedDomain: DEFAULT_SPATIAL_DOMAIN,
  domains: {},
};

/** A domain's settings, for reading (defaults when it has none saved). */
const getSettings = (id: string) => state.domains[id] ?? defaultDomainSettings(id);

/** A domain's settings, for writing (created from the defaults). */
const editSettings = (id: string) => (state.domains[id] ??= defaultDomainSettings(id));

const persistDomainSettings = () => persistDebuggerTabValue(TAB_ID, 'domains');

/** The saved cell size of domain `id`'s settings with scope `sceneId` (undefined = the world settings). */
const getSavedCellSize = (id: string, sceneId: string | undefined) => {
  const settings = state.domains[id];
  return sceneId === undefined ? settings?.cellSize : settings?.cellSizeByScene?.[sceneId];
};

/** Clears the saved cell size of domain `id`'s settings with scope `sceneId`. */
const clearSavedCellSize = (id: string, sceneId: string | undefined) => {
  const settings = state.domains[id];
  if (!settings) return;
  if (sceneId === undefined) {
    delete settings.cellSize;
    return;
  }
  const byScene = settings.cellSizeByScene;
  if (!byScene) return;
  delete byScene[sceneId];
  if (Object.keys(byScene).length === 0) delete settings.cellSizeByScene;
};

/**
 * Before domains, the tab saved one grid's settings as flat keys. They become DEFAULT's entry
 * (the cell size only when it differed from the old default, 20).
 */
const migrateLegacySettings = () => {
  // An object default makes lsGetItem parse the JSON
  const saved = lsGetItem(LS_KEY, {}) as Record<string, unknown> | null;
  if (!saved || typeof saved !== 'object' || 'domains' in saved || 'selectedDomain' in saved) {
    return;
  }
  const legacyKeys = [
    'cellSize',
    'visualizerEnabled',
    'visualizerColor',
    'oversizedVisualizerEnabled',
    'oversizedVisualizerColor',
  ];
  if (!legacyKeys.some((key) => key in saved)) return;

  const defaults = defaultDomainSettings(DEFAULT_SPATIAL_DOMAIN);
  const entry: DomainDebugSettings = {
    showCells: Boolean(saved.visualizerEnabled ?? defaults.showCells),
    cellsColor: Number(saved.visualizerColor ?? defaults.cellsColor),
    showOversized: Boolean(saved.oversizedVisualizerEnabled ?? defaults.showOversized),
    oversizedColor: Number(saved.oversizedVisualizerColor ?? defaults.oversizedColor),
  };
  if (typeof saved.cellSize === 'number' && saved.cellSize !== 20) entry.cellSize = saved.cellSize;
  lsSetItem(LS_KEY, { domains: { [DEFAULT_SPATIAL_DOMAIN]: entry } });
};

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

const formatFramesSinceRebuild = (frames: number) =>
  frames < 0 ? 'never' : frames === 0 ? 'this frame' : `${frames} frames ago`;

/** Lines per domain in {@link formatDomainSummary}. */
const DOMAIN_SUMMARY_LINES = 2;

/**
 * Two short lines per domain (the value column is narrow): its policy and members, then its
 * rebuilds out of the frames since it was registered and the last rebuild's cost. Shows at a
 * glance which domains rebuild every frame (p346 Phase 3).
 */
function formatDomainSummary(world: ECSWorld, ids: string[]): string {
  return ids
    .map((id) => {
      const opts = getSpatialDomainOptions(world, id);
      if (!opts) return `${id}\n  not registered`;
      const stats = getSpatialDomainRebuildStats(world, id);
      // DEFAULT has settings without a grid (p349 §3.6)
      if (!stats) return `${id} ${opts.update}\n  no grid`;
      const members = getSpatialDomain(world, id)?.memberCount ?? 0;
      return (
        `${id} ${opts.update} ${members}\n` +
        `  ${stats.rebuildCount}/${stats.frameCount} · ${stats.lastRebuildMs.toFixed(3)} ms`
      );
    })
    .join('\n');
}

// --- VISUALIZER (docs/plans/_DONE_p125_spatial-index-system-visualizer.md) ---
// Two overlays per domain, each one line created on the domain's first use and then only
// hidden: the occupied cells, and the oversized tier's members (which bypass the grid, so they
// have no cell to draw). Each domain has its own colors, so several can be shown at once. A
// toggle only flips visibility and the `enabled` flag the refill system reads, so nothing is
// recreated per toggle.

type BoxOverlay = {
  line: LineObject;
  enabled: boolean;
  bounds: Float32Array;
  /** Writes 6 floats per box into `out`, returns the box count (see SpatialGrid). */
  getBoundsInto: (grid: SpatialGrid, out: Float32Array) => number;
};

type DomainOverlays = { domainId: string; cells: BoxOverlay; oversized: BoxOverlay };

// Ceilings for the FIXED line buffers. Occupied cells are bounded only by a domain's
// maxMembers (100k for DEFAULT by default), far too much to pre-allocate for a debug overlay;
// past these a line drops the extra boxes and warns once.
const VISUALIZER_MAX_CELLS = 4096;
const VISUALIZER_MAX_OVERSIZED = 256;

const domainOverlays: DomainOverlays[] = [];
const scratchBox = new THREE.Box3();

const setOverlayEnabled = (overlay: BoxOverlay, enabled: boolean) => {
  overlay.enabled = enabled;
  overlay.line.setVisible(enabled);
};

/** `grid` undefined: the domain isn't registered (any more), so the line is emptied. */
const refillOverlay = (overlay: BoxOverlay, grid: SpatialGrid | undefined) => {
  if (!overlay.enabled) return;
  const line = overlay.line;
  if (!grid) {
    line.beginWrite();
    line.endWrite();
    return;
  }

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

/** Refills the shown overlays from their domain's last rebuild. LATE_MAIN, so after the
 * APP_POST_PHYSICS rebuild. Only the default world is drawn — there is one line each. */
const spatialGridVisualizerSystem = (world: ECSWorld) => {
  if (domainOverlays.length === 0 || world !== getECSWorld()) return;
  for (let i = 0; i < domainOverlays.length; i++) {
    const overlays = domainOverlays[i];
    if (!overlays.cells.enabled && !overlays.oversized.enabled) continue;
    // Re-read every frame: re-registering a domain replaces its grid, unregistering drops it
    const grid = getSpatialDomain(world, overlays.domainId);
    refillOverlay(overlays.cells, grid);
    refillOverlay(overlays.oversized, grid);
  }
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

const getOverlays = (domainId: string) => domainOverlays.find((o) => o.domainId === domainId);

const ensureOverlays = (domainId: string): DomainOverlays => {
  const existing = getOverlays(domainId);
  if (existing) return existing;
  // DEFAULT keeps the line ids it had before domains
  const suffix = domainId === DEFAULT_SPATIAL_DOMAIN ? '' : `_${domainId}`;
  const overlays: DomainOverlays = {
    domainId,
    cells: {
      line: createOverlayLine(`SPATIAL_GRID_DEBUG_VISUALIZER${suffix}`, VISUALIZER_MAX_CELLS),
      enabled: false,
      bounds: new Float32Array(VISUALIZER_MAX_CELLS * 6),
      getBoundsInto: (grid, out) => grid.getOccupiedCellBoundsInto(out),
    },
    oversized: {
      line: createOverlayLine(
        `SPATIAL_GRID_DEBUG_VISUALIZER_OVERSIZED${suffix}`,
        VISUALIZER_MAX_OVERSIZED
      ),
      enabled: false,
      bounds: new Float32Array(VISUALIZER_MAX_OVERSIZED * 6),
      getBoundsInto: (grid, out) => grid.getOversizedBoundsInto(out),
    },
  };
  domainOverlays.push(overlays);
  return overlays;
};

/** Applies a domain's saved overlay settings. Its lines are created on the first one shown. */
const syncOverlays = (domainId: string) => {
  const settings = getSettings(domainId);
  if (!settings.showCells && !settings.showOversized && !getOverlays(domainId)) return;
  const overlays = ensureOverlays(domainId);
  // Color writes are uniform writes, no geometry rebuild
  overlays.cells.line.setColor(settings.cellsColor);
  setOverlayEnabled(overlays.cells, settings.showCells);
  overlays.oversized.line.setColor(settings.oversizedColor);
  setOverlayEnabled(overlays.oversized, settings.showOversized);
};

export const _createSpatialGridDebugGUI = () => {
  const world = getECSWorld();
  // Before createDebuggerTab, which hydrates `state` from the saved settings
  migrateLegacySettings();

  // The shown domain's values, which the bindings show. Synced on every refresh.
  const selected = {
    domain: DEFAULT_SPATIAL_DOMAIN,
    scope: '',
    cellSize: 0,
    maxMembers: 0,
    update: '',
    showCells: false,
    cellsColor: 0,
    showOversized: false,
    oversizedColor: 0,
    oracle: false,
  };
  const statsState = {
    memberCount: 0,
    oversizedCount: 0,
    occupiedCellCount: 0,
    maxIndexedRadius: 0,
    lastRebuildMs: 0,
    rebuilds: '',
    lastRebuilt: '',
    oracleChecked: 0,
    oracleMismatches: 0,
  };
  const histogramState = { text: '(no occupied cells)' };
  const summaryState = { text: '' };

  // DEFAULT always is: its settings exist without its grid (p349 §3.6)
  const isRegistered = (id: string) => Boolean(getSpatialDomainOptions(world, id));
  const getDomainLabel = (id: string) =>
    !isRegistered(id)
      ? `${id} (not registered)`
      : getSpatialDomain(world, id)
        ? id
        : `${id} (no grid)`;
  const getSceneId = () => getCurrentSceneId() ?? undefined;

  /**
   * Registered domains first (DEFAULT leading), then the unregistered ones with a cell size
   * saved for the current scene or id-wide, so it can be seen and cleared (p349 §3.5).
   */
  const listDomainIds = () => {
    const sceneId = getSceneId();
    return [
      ...new Set([
        DEFAULT_SPATIAL_DOMAIN,
        ...getSpatialDomainIds(world),
        ...Object.keys(state.domains).filter(
          (id) =>
            getSavedCellSize(id, undefined) !== undefined ||
            (sceneId !== undefined && getSavedCellSize(id, sceneId) !== undefined)
        ),
      ]),
    ];
  };
  const getDomainListKey = () => listDomainIds().map(getDomainLabel).join(',');
  let builtDomainListKey = '';

  /**
   * The domain the tab shows: the saved selection while it's listed, else DEFAULT. The saved
   * selection is kept, so it's shown again when its domain is registered again.
   */
  const getShownDomain = () =>
    listDomainIds().includes(state.selectedDomain) ? state.selectedDomain : DEFAULT_SPATIAL_DOMAIN;
  const isShownRegistered = () => isRegistered(getShownDomain());

  /**
   * The scope (scene id, undefined = world) the tab edits domain `id`'s cell size in: that of
   * the settings in use. For an unregistered domain, that of the saved value it shows.
   */
  const getEditScope = (id: string) => {
    if (isRegistered(id)) return getSpatialDomainSceneId(world, id);
    const sceneId = getSceneId();
    return sceneId !== undefined && state.domains[id]?.cellSizeByScene?.[sceneId] !== undefined
      ? sceneId
      : undefined;
  };

  /** Writes one overlay setting of the shown domain from the bound proxy. */
  const setOverlaySetting =
    (key: 'showCells' | 'cellsColor' | 'showOversized' | 'oversizedColor') =>
    (value: unknown, e: { last: boolean }) => {
      const id = getShownDomain();
      const settings = editSettings(id);
      if (key === 'showCells' || key === 'showOversized') settings[key] = Boolean(value);
      else settings[key] = Number(value);
      syncOverlays(id);
      if (e.last) persistDomainSettings();
    };

  createDebuggerTab({
    id: TAB_ID,
    title: 'Spatial index',
    icon: 'spatialGrid',
    lsKey: LS_KEY,
    state,
    persistKeys: ['selectedDomain', 'domains'],
    onClearLS: () => {
      state.selectedDomain = DEFAULT_SPATIAL_DOMAIN;
      state.domains = {};
      for (let i = 0; i < domainOverlays.length; i++) syncOverlays(domainOverlays[i].domainId);
      // Back to the cell sizes the app registered
      for (const id of getSpatialDomainIds(world)) reapplySpatialDomainOptions(world, id);
      updateDebuggerTab(TAB_ID, { rebuild: true });
    },
    // Debug-only polling: simplest way to keep a live readout current without wiring a
    // subscriber through the rebuild system (it only runs while the tab is visible)
    refreshIntervalMs: 500,
    onRefresh: () => {
      const id = getShownDomain();
      const opts = getSpatialDomainOptions(world, id);
      const settings = getSettings(id);
      const scope = getEditScope(id);
      selected.domain = id;
      selected.scope = scope === undefined ? 'world' : `scene: ${scope}`;
      selected.cellSize = opts?.cellSize ?? getSavedCellSize(id, scope) ?? 0;
      selected.maxMembers = opts?.maxMembers ?? 0;
      selected.update = opts ? opts.update : 'not registered';
      selected.showCells = settings.showCells;
      selected.cellsColor = settings.cellsColor;
      selected.showOversized = settings.showOversized;
      selected.oversizedColor = settings.oversizedColor;
      selected.oracle = isSpatialGridOracleEnabled(world, id);

      const grid = getSpatialDomain(world, id);
      const stats = grid?.getStats();
      statsState.memberCount = stats?.memberCount ?? 0;
      statsState.oversizedCount = stats?.oversizedCount ?? 0;
      statsState.occupiedCellCount = stats?.occupiedCellCount ?? 0;
      statsState.maxIndexedRadius = stats?.maxIndexedRadius ?? 0;
      statsState.lastRebuildMs = getLastRebuildDurationMs(world, id);
      const rebuildStats = getSpatialDomainRebuildStats(world, id);
      statsState.rebuilds = rebuildStats
        ? `${rebuildStats.rebuildCount} in ${rebuildStats.frameCount} frames`
        : '-';
      statsState.lastRebuilt = rebuildStats
        ? formatFramesSinceRebuild(rebuildStats.framesSinceRebuild)
        : '-';
      summaryState.text = formatDomainSummary(world, listDomainIds());
      statsState.oracleChecked = getOracleCheckedQueryCount(world, id);
      statsState.oracleMismatches = getOracleMismatchCount(world, id);
      histogramState.text = formatOccupancyHistogram(grid?.getCellOccupancyCounts() ?? []);

      // A domain registered, unregistered or saved since the build, or a scene change: the
      // dropdown needs a rebuild. Deferred, since this runs inside a refresh or a build.
      if (builtDomainListKey && getDomainListKey() !== builtDomainListKey) {
        builtDomainListKey = '';
        queueMicrotask(() => updateDebuggerTab(TAB_ID, { rebuild: true }));
      }
    },
    content: () => {
      builtDomainListKey = getDomainListKey();
      selected.domain = getShownDomain();
      return [
        {
          pane: true,
          content: [
            {
              // A proxy of the saved selection, which may not be listed (see getShownDomain)
              key: 'domain',
              target: selected,
              label: 'Domain',
              options: listDomainIds().map((id) => ({ value: id, text: getDomainLabel(id) })),
              onChange: (value) => {
                state.selectedDomain = String(value);
                persistDebuggerTabValue(TAB_ID, 'selectedDomain');
                // The refresh syncs the bound values to the newly selected domain
                updateDebuggerTab(TAB_ID);
              },
            },
            { key: 'scope', target: selected, label: 'Scope', readonly: true },
            {
              key: 'cellSize',
              target: selected,
              label: 'Cell size',
              min: 0.1,
              step: 0.5,
              // Editable for DEFAULT without a grid too: the edit applies at its next build
              disabled: () => !isShownRegistered(),
              onChange: (value, e) => {
                // Re-creating the grid per drag tick would be costly (DEFAULT holds 100k slots)
                if (!e.last) return;
                const id = getShownDomain();
                const sceneId = getEditScope(id);
                const settings = editSettings(id);
                if (sceneId === undefined) settings.cellSize = Number(value);
                else (settings.cellSizeByScene ??= {})[sceneId] = Number(value);
                persistDomainSettings();
                reapplySpatialDomainOptions(world, id);
                updateDebuggerTab(TAB_ID);
              },
            },
            {
              type: 'button',
              title: "Reset to the app's cell size",
              // Only the shown scope's value, so a reset never changes another scene
              disabled: () => {
                const id = getShownDomain();
                return getSavedCellSize(id, getEditScope(id)) === undefined;
              },
              onClick: () => {
                const id = getShownDomain();
                clearSavedCellSize(id, getEditScope(id));
                persistDomainSettings();
                reapplySpatialDomainOptions(world, id);
                // Rebuilt: an unregistered domain without a saved value leaves the dropdown
                updateDebuggerTab(TAB_ID, { rebuild: true });
              },
            },
            {
              key: 'maxMembers',
              target: selected,
              label: 'Max members',
              readonly: true,
              format: formatInt,
            },
            { key: 'update', target: selected, label: 'Update', readonly: true },
            {
              key: 'oracle',
              target: selected,
              label: 'Brute-force oracle',
              onChange: (value) => {
                setSpatialGridOracleEnabled(world, Boolean(value), getShownDomain());
              },
            },
            {
              type: 'folder',
              title: 'Visualizer',
              content: [
                {
                  key: 'showCells',
                  target: selected,
                  label: 'Show grid wireframe',
                  onChange: setOverlaySetting('showCells'),
                },
                {
                  key: 'cellsColor',
                  target: selected,
                  label: 'Wireframe color',
                  view: 'color',
                  onChange: setOverlaySetting('cellsColor'),
                },
                {
                  key: 'showOversized',
                  target: selected,
                  label: 'Show oversized bounds',
                  onChange: setOverlaySetting('showOversized'),
                },
                {
                  key: 'oversizedColor',
                  target: selected,
                  label: 'Oversized color',
                  view: 'color',
                  onChange: setOverlaySetting('oversizedColor'),
                },
              ],
            },
            {
              type: 'folder',
              title: 'Live stats',
              content: [
                {
                  key: 'memberCount',
                  target: statsState,
                  label: 'Members',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'oversizedCount',
                  target: statsState,
                  label: 'Oversized',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'occupiedCellCount',
                  target: statsState,
                  label: 'Occupied cells',
                  readonly: true,
                  format: formatInt,
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
                  key: 'rebuilds',
                  target: statsState,
                  label: 'Rebuilds',
                  readonly: true,
                },
                {
                  key: 'lastRebuilt',
                  target: statsState,
                  label: 'Last rebuilt',
                  readonly: true,
                },
                {
                  key: 'oracleChecked',
                  target: statsState,
                  label: 'Oracle queries',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'oracleMismatches',
                  target: statsState,
                  label: 'Oracle mismatches',
                  readonly: true,
                  format: formatInt,
                },
              ],
            },
            {
              key: 'text',
              target: summaryState,
              // Members, then rebuilds / frames since registration and the last rebuild's cost
              label: 'All domains',
              readonly: true,
              multiline: true,
              // The list changes only with a rebuild of the tab (see onRefresh)
              rows: Math.min(listDomainIds().length * DOMAIN_SUMMARY_LINES, 12),
              interval: 0,
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
      ];
    },
  });

  // The saved cell sizes apply to every registration in the default world from here on (the
  // tab only covers that world), and to the domains registered before the tab. Each scope gets
  // only its own value: a scene's settings never get the world value.
  setSpatialDomainOptionsOverride((w, requested, sceneId) => {
    const cellSize = w === world ? getSavedCellSize(requested.id, sceneId) : undefined;
    return cellSize === undefined ? requested : { ...requested, cellSize };
  });
  for (const id of getSpatialDomainIds(world)) reapplySpatialDomainOptions(world, id);

  for (const id of Object.keys(state.domains)) syncOverlays(id);
  ECSWorld.registerPlugin((w) => {
    w.addSystem(
      ECSSystemStage.LATE_MAIN,
      'spatialGridVisualizerSystem',
      spatialGridVisualizerSystem
    );
  });
};
