import {
  addDebugToast,
  createDebuggerTab,
  debuggerListCMP,
  type DebuggerListItem,
  updateDebuggerTab,
} from '../../debug/DebuggerGUI';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { getConfig } from '../Config';
import { getDevFilesStatus } from '../../debug/DevFiles';
import { getImpostorRecords, type ImpostorRecord } from '../Lod/Impostors/ImpostorRegistry';
import { doesTextureExist, getTexture } from '../Texture';
import {
  getLodBias,
  getLodDebugOptions,
  getLodFadeSeconds,
  getLodFrameStats,
  getLodMaxSelectionsPerFrame,
  setLodBias,
  setLodDebugOptions,
  setLodFadeSeconds,
  setLodMaxSelectionsPerFrame,
} from '../Lod/LodSystem';
import {
  findNearestLodEntityInView,
  getLodEntityName,
  getOpenLodEntityWindowIds,
  toggleLodEntityWindow,
} from './Lod/_dbg__LodEntityWindow';
import {
  exportImpostorsAsync,
  getImpostorExportState,
  isImpostorExportRunning,
  isImpostorKindExported,
  type ImpostorExportState,
} from './Lod/_dbg__ImpostorExport';
import {
  isLodOverlayEnabled,
  LOD_OVERLAY_COLOR_NAMES,
  setLodOverlayEnabled,
} from './Lod/_dbg__LodOverlay';

// The LOD tab (docs/plans/_DONE_p348_ecs-lod-selection.md §6): counts per level, the last frame's
// selections, applies and fades, the selection's runtime overrides, the fades' duration and time
// scale (docs/plans/_DONE_p351_impostor-billboard-lod.md Phase 2), the level overlay
// (Lod/_dbg__LodOverlay.ts), the per-entity LOD windows (Lod/_dbg__LodEntityWindow.ts) and the
// impostors generated in this session with their Export (p351 Phase 4,
// Lod/_dbg__ImpostorExport.ts). Nothing is persisted: it's all for inspecting, and a reload starts
// from the app's values. Default world only.

const TAB_ID = 'lodControls';
const formatInt = (v: number) => v.toFixed(0);

/** The cap's choices; -1 stands for Infinity (no cap) in the list. */
const MAX_SELECTIONS_OPTIONS = [100, 250, 500, 1000, 2500, 5000, 10000];
const toCapOption = (max: number) => (max === Infinity ? -1 : max);

/** Rows the mesh list shows at most (a scene can have thousands of LOD meshes). */
const MAX_LIST_ROWS = 100;

/** The overlay's colour per level, as legend lines. */
const formatLegend = (levelCount: number) =>
  Array.from({ length: levelCount }, (_, i) => {
    const name = LOD_OVERLAY_COLOR_NAMES[Math.min(i, LOD_OVERLAY_COLOR_NAMES.length - 1)];
    return `${`Level ${i}`.padEnd(12)}${name}`;
  }).join('\n');

/** The default world's LOD meshes (not pool instances: those are too many to list; "Nearest in
 * view" reaches them), the first MAX_LIST_ROWS. */
const getMeshListData = (): DebuggerListItem[] => {
  const world = getECSWorld();
  const items: DebuggerListItem[] = [];
  let more = 0;
  for (const [entityId, lod] of world.getStorage(ComponentType.LOD)) {
    if (lod._target) continue;
    if (items.length >= MAX_LIST_ROWS) {
      more++;
      continue;
    }
    let suffix = `L${Math.max(lod.applied, 0)}`;
    const isFading = world.hasComponent(entityId, ComponentType.TAG_LOD_TRANSITIONING);
    if (
      world.isDisabled(entityId) ||
      world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)
    ) {
      suffix = 'out of view';
    } else if (world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)) {
      suffix = isFading ? 'fading out' : 'culled';
    } else if (isFading) {
      suffix += ' fading';
    }
    items.push({
      itemId: String(entityId),
      title: getLodEntityName(entityId, world),
      subTitle: `[${entityId}]`,
      suffix,
    });
  }
  if (more) {
    items.push({
      itemId: 'more',
      title: `…and ${more} more`,
      disabled: true,
      titlePlaceholder: true,
    });
  }
  return items;
};

/** The fixed lines of the counts text after the level lines. */
const COUNT_EXTRA_LINES = 3;

/** Entities per shown level, plus the hidden ones by reason. */
type LodCounts = { levels: number[]; lodCulled: number; outOfView: number; total: number };

/**
 * Counts the default world's LOD entities. Shown ones by the level they show (one not selected
 * yet, or without levels, shows the mesh as created: level 0), hidden ones by why: out of view
 * (disabled or frustum-culled, keeping their level) or LOD-culled.
 */
const countLevels = (): LodCounts => {
  const world = getECSWorld();
  const counts: LodCounts = { levels: [0], lodCulled: 0, outOfView: 0, total: 0 };
  for (const [entityId, lod] of world.getStorage(ComponentType.LOD)) {
    counts.total++;
    const levelCount = Math.max(lod._levels.length, 1);
    while (counts.levels.length < levelCount) counts.levels.push(0);
    if (
      world.isDisabled(entityId) ||
      world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)
    ) {
      counts.outOfView++;
    } else if (world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)) {
      counts.lodCulled++;
    } else {
      counts.levels[Math.max(lod.applied, 0)]++;
    }
  }
  return counts;
};

const formatCounts = (counts: LodCounts) => {
  const row = (label: string, value: number) => `${label.padEnd(12)}${String(value).padStart(7)}`;
  return [
    ...counts.levels.map((n, i) => row(`Level ${i}`, n)),
    row('LOD culled', counts.lodCulled),
    row('Out of view', counts.outOfView),
    row('Total', counts.total),
  ].join('\n');
};

const IMPOSTOR_KIND_NAMES: Record<ImpostorRecord['kind'], string> = {
  OCTAHEDRAL: 'Octahedral',
  CROSS_QUADS: 'Cross-quads',
};

const IMPOSTOR_EXPORT_STATE_NAMES: Record<ImpostorExportState, string> = {
  NO_SOURCE: 'no source to export',
  NOT_EXPORTED: 'not exported',
  EXPORTED: 'export up to date',
  STALE: 'export stale',
  OTHER_FORMAT: 'export in another format',
};

/** Whether the impostor can be exported now: it has a source and its kind exports */
const isImpostorExportable = (record: ImpostorRecord) =>
  Boolean(record.source) && isImpostorKindExported(record.kind);

/** An impostor's row text: its kind, where it came from and its export, its atlas and bake time */
const formatImpostorRow = (record: ImpostorRecord) => {
  const albedoId = `${record.id}.albedo`;
  const albedo = doesTextureExist(albedoId) ? getTexture(albedoId) : undefined;
  const image = albedo?.image as { width?: number; height?: number } | undefined;
  const size = image?.width ? `${image.width}×${image.height}` : 'no atlas';
  const origin = record.origin === 'BAKED' ? 'baked' : 'loaded from its export';
  const exportState = isImpostorKindExported(record.kind)
    ? IMPOSTOR_EXPORT_STATE_NAMES[getImpostorExportState(record)]
    : 'no export yet';
  const bake = record.bakeMs === null ? 'no bake' : `${record.bakeMs.toFixed(0)} ms bake`;
  return `${IMPOSTOR_KIND_NAMES[record.kind]}, ${origin}\n${exportState}\n${size}, ${bake}`;
};

/** Characters a line of a readonly text shows in the drawer */
const TEXT_COLUMNS = 24;
const DEV_FILES_ROWS = 3;

/** `text` wrapped at word boundaries into at most `rows` lines of TEXT_COLUMNS */
const wrapText = (text: string, rows: number) => {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= TEXT_COLUMNS) {
      lines[last] += ` ${word}`;
    } else {
      lines.push(word);
    }
  }
  if (lines.length > rows) {
    lines.length = rows;
    lines[rows - 1] = `${lines[rows - 1].slice(0, TEXT_COLUMNS - 1)}…`;
  }
  return lines.join('\n');
};

/** What the impostor rows were built for: a rebuild follows a change */
const getImpostorsSignature = () =>
  getImpostorRecords()
    .map((record) => `${record.id}:${record.kind}:${record.origin}`)
    .join('|');

export const _createLodDebugGUI = () => {
  const world = getECSWorld();

  // Proxies of the runtime values, synced on every refresh (app code can change them too)
  const controls = {
    overlay: false,
    bias: 1,
    maxSelections: -1,
    freeze: false,
    forceLevel: -1,
    useActiveCamera: false,
    fadeSeconds: 0.25,
    fadeTimeScale: 1,
  };
  const statsState = {
    selections: 0,
    lapFrames: 1,
    applies: 0,
    totalApplies: 0,
    selectionMs: 0,
    fading: 0,
    fadeMs: 0,
  };
  const getAppFadeSeconds = () => getConfig().lod?.fadeSeconds ?? 0.25;
  const countsState = { text: '' };

  /** Levels of the entity with the most, which the counts and the force options list. */
  let levelCount = 1;
  let builtLevelCount = 0;
  /** The impostors the rows were built for (null: not built) */
  let builtImpostors: string | null = null;
  const impostorRows: Record<string, { text: string }> = {};
  const devFilesState = { text: 'Checking…' };

  createDebuggerTab({
    id: TAB_ID,
    title: 'LOD',
    icon: 'lod',
    // Nothing is persisted; the disabled button keeps the heading like the other tabs'
    clearLSButton: true,
    refreshIntervalMs: 500,
    onRefresh: () => {
      const opts = getLodDebugOptions();
      controls.overlay = isLodOverlayEnabled();
      controls.bias = getLodBias();
      controls.maxSelections = toCapOption(getLodMaxSelectionsPerFrame());
      controls.freeze = opts.freeze;
      controls.forceLevel = opts.forceLevel;
      controls.useActiveCamera = opts.useActiveCamera;
      controls.fadeSeconds = getLodFadeSeconds();
      controls.fadeTimeScale = opts.fadeTimeScale;

      const stats = getLodFrameStats(world);
      statsState.selections = stats.selections;
      statsState.lapFrames = stats.lapFrames;
      statsState.applies = stats.applies;
      statsState.totalApplies = stats.totalApplies;
      statsState.selectionMs = stats.selectionMs;
      statsState.fading = stats.fading;
      statsState.fadeMs = stats.fadeMs;

      const counts = countLevels();
      countsState.text = formatCounts(counts);
      levelCount = counts.levels.length;

      for (const record of getImpostorRecords()) {
        const row = impostorRows[record.id];
        if (row) row.text = formatImpostorRow(record);
      }

      // Another level count (eg. a scene change): the force options and the counts' rows need
      // a rebuild, as do other impostors' rows. Deferred, since this runs inside a refresh or a
      // build.
      const isLevelCountChanged = builtLevelCount && levelCount !== builtLevelCount;
      const isImpostorsChanged =
        builtImpostors !== null && builtImpostors !== getImpostorsSignature();
      if (isLevelCountChanged || isImpostorsChanged) {
        builtLevelCount = 0;
        builtImpostors = null;
        queueMicrotask(() => updateDebuggerTab(TAB_ID, { rebuild: true }));
      }
    },
    onOpen: () => {
      let isOpen = true;
      // Asked on every mount: the server can restart with other settings
      getDevFilesStatus().then((status) => {
        if (!isOpen) return;
        devFilesState.text = wrapText(
          status.available
            ? 'Export writes the files into the repo.'
            : `Export downloads the files: ${status.message}.`,
          DEV_FILES_ROWS
        );
        updateDebuggerTab(TAB_ID);
      });
      return () => {
        isOpen = false;
      };
    },
    content: () => {
      builtLevelCount = levelCount;
      builtImpostors = getImpostorsSignature();
      const records = getImpostorRecords();
      for (const id of Object.keys(impostorRows)) delete impostorRows[id];
      for (const record of records) impostorRows[record.id] = { text: formatImpostorRow(record) };
      // A forced level past every entity's last stays listed while it is set
      const forceOptionCount = Math.max(levelCount, controls.forceLevel + 1);
      // A cap the app set that isn't one of the choices is listed too
      const capOptions = MAX_SELECTIONS_OPTIONS.includes(controls.maxSelections)
        ? MAX_SELECTIONS_OPTIONS
        : [...MAX_SELECTIONS_OPTIONS, controls.maxSelections]
            .filter((v) => v > 0)
            .sort((a, b) => a - b);
      const legendState = { text: formatLegend(levelCount) };
      return [
        {
          pane: true,
          content: [
            {
              key: 'text',
              target: countsState,
              label: 'Entities',
              readonly: true,
              multiline: true,
              rows: levelCount + COUNT_EXTRA_LINES,
              interval: 0,
            },
            {
              type: 'folder',
              title: 'Last frame',
              content: [
                {
                  key: 'selections',
                  target: statsState,
                  label: 'Selections',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'lapFrames',
                  target: statsState,
                  label: 'Frames per lap',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'applies',
                  target: statsState,
                  label: 'Level swaps',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'totalApplies',
                  target: statsState,
                  label: 'Swaps in total',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'selectionMs',
                  target: statsState,
                  label: 'Selection (ms)',
                  readonly: true,
                  format: (v: number) => v.toFixed(3),
                },
                {
                  key: 'fading',
                  target: statsState,
                  label: 'Fading',
                  readonly: true,
                  format: formatInt,
                },
                {
                  key: 'fadeMs',
                  target: statsState,
                  label: 'Fades (ms)',
                  readonly: true,
                  format: (v: number) => v.toFixed(3),
                },
              ],
            },
            {
              type: 'folder',
              title: 'Selection',
              content: [
                {
                  key: 'bias',
                  target: controls,
                  label: 'Global bias',
                  min: 0.1,
                  max: 4,
                  step: 0.05,
                  onChange: (value) => setLodBias(Number(value)),
                },
                {
                  type: 'button',
                  title: "Reset to the app's bias",
                  disabled: () => getLodBias() === (getConfig().lod?.bias ?? 1),
                  onClick: () => {
                    setLodBias(getConfig().lod?.bias ?? 1);
                    updateDebuggerTab(TAB_ID);
                  },
                },
                {
                  key: 'maxSelections',
                  target: controls,
                  label: 'Max selections / frame',
                  options: [
                    { value: -1, text: 'No cap' },
                    ...capOptions.map((value) => ({ value, text: String(value) })),
                  ],
                  onChange: (value) => {
                    const max = Number(value);
                    setLodMaxSelectionsPerFrame(max < 0 ? Infinity : max);
                  },
                },
                {
                  type: 'button',
                  title: "Reset to the app's cap",
                  disabled: () =>
                    getLodMaxSelectionsPerFrame() ===
                    (getConfig().lod?.maxSelectionsPerFrame ?? Infinity),
                  onClick: () => {
                    setLodMaxSelectionsPerFrame(getConfig().lod?.maxSelectionsPerFrame ?? Infinity);
                    updateDebuggerTab(TAB_ID, { rebuild: true });
                  },
                },
                {
                  key: 'freeze',
                  target: controls,
                  label: 'Freeze',
                  // A forced level wins over freeze
                  disabled: () => controls.forceLevel >= 0,
                  onChange: (value) => setLodDebugOptions({ freeze: Boolean(value) }),
                },
                {
                  key: 'forceLevel',
                  target: controls,
                  label: 'Force level',
                  options: [
                    { value: -1, text: 'Off' },
                    ...Array.from({ length: forceOptionCount }, (_, i) => ({
                      value: i,
                      text: `Level ${i}`,
                    })),
                  ],
                  onChange: (value) => {
                    setLodDebugOptions({ forceLevel: Number(value) });
                    // Freeze's disabled state follows
                    updateDebuggerTab(TAB_ID);
                  },
                },
                {
                  key: 'useActiveCamera',
                  target: controls,
                  label: 'Use active camera',
                  onChange: (value) => setLodDebugOptions({ useActiveCamera: Boolean(value) }),
                },
              ],
            },
            {
              type: 'folder',
              title: 'Fades',
              content: [
                {
                  // The global value: a LOD's own fadeSeconds wins (the LOD window shows which)
                  key: 'fadeSeconds',
                  target: controls,
                  label: 'Fade seconds (0 = pop)',
                  min: 0,
                  max: 2,
                  step: 0.05,
                  onChange: (value) => setLodFadeSeconds(Number(value)),
                },
                {
                  type: 'button',
                  title: "Reset to the app's fade",
                  disabled: () => getLodFadeSeconds() === getAppFadeSeconds(),
                  onClick: () => {
                    setLodFadeSeconds(getAppFadeSeconds());
                    updateDebuggerTab(TAB_ID);
                  },
                },
                {
                  key: 'fadeTimeScale',
                  target: controls,
                  label: 'Time scale (0 = hold)',
                  min: 0,
                  max: 1,
                  step: 0.01,
                  onChange: (value) => setLodDebugOptions({ fadeTimeScale: Number(value) }),
                },
                {
                  type: 'button',
                  title: 'Real time',
                  disabled: () => getLodDebugOptions().fadeTimeScale === 1,
                  onClick: () => {
                    setLodDebugOptions({ fadeTimeScale: 1 });
                    updateDebuggerTab(TAB_ID);
                  },
                },
              ],
            },
            {
              type: 'folder',
              title: 'Overlay',
              content: [
                {
                  key: 'overlay',
                  target: controls,
                  label: 'Level boxes',
                  onChange: (value) => setLodOverlayEnabled(Boolean(value)),
                },
                {
                  key: 'text',
                  target: legendState,
                  label: 'Colours',
                  readonly: true,
                  multiline: true,
                  rows: levelCount,
                  interval: 0,
                },
              ],
            },
            {
              type: 'folder',
              title: 'Impostors',
              content: [
                {
                  key: 'text',
                  target: devFilesState,
                  label: 'Dev files',
                  readonly: true,
                  multiline: true,
                  rows: DEV_FILES_ROWS,
                  interval: 0,
                },
                ...records.flatMap((record) => [
                  { type: 'separator' as const },
                  {
                    key: 'text',
                    target: impostorRows[record.id],
                    label: record.id,
                    readonly: true,
                    multiline: true,
                    rows: 3,
                    interval: 0,
                  },
                  {
                    type: 'button' as const,
                    title:
                      isImpostorKindExported(record.kind) &&
                      getImpostorExportState(record) !== 'NOT_EXPORTED'
                        ? 'Re-export'
                        : 'Export',
                    disabled: () => isImpostorExportRunning() || !isImpostorExportable(record),
                    onClick: () => {
                      exportImpostorsAsync([record.id]).then(() => updateDebuggerTab(TAB_ID));
                      updateDebuggerTab(TAB_ID);
                    },
                  },
                ]),
                { type: 'separator' },
                {
                  type: 'button',
                  title: 'Export all',
                  hidden: () => !records.length,
                  disabled: () => isImpostorExportRunning() || !records.some(isImpostorExportable),
                  onClick: () => {
                    const ids = records.filter(isImpostorExportable).map((record) => record.id);
                    exportImpostorsAsync(ids).then(() => updateDebuggerTab(TAB_ID));
                    updateDebuggerTab(TAB_ID);
                  },
                },
                {
                  key: 'text',
                  target: { text: 'No impostors generated in this scene.' },
                  label: '',
                  readonly: true,
                  hidden: () => records.length > 0,
                  interval: 0,
                },
              ],
            },
            {
              type: 'folder',
              title: 'Inspect',
              content: [
                {
                  type: 'button',
                  title: 'Nearest in view',
                  onClick: () => {
                    const entityId = findNearestLodEntityInView(world);
                    if (entityId === undefined) {
                      addDebugToast({ message: 'No LOD entity in view.' });
                      return;
                    }
                    toggleLodEntityWindow(entityId);
                    updateDebuggerTab(TAB_ID);
                  },
                },
              ],
            },
          ],
        },
        debuggerListCMP({
          id: 'lodMeshes',
          heading: 'Meshes with a LOD',
          emptyText: 'No meshes with a LOD (pool instances: "Nearest in view").',
          data: getMeshListData,
          selectedItemId: getOpenLodEntityWindowIds,
          perItemConfig: {
            onClick: (itemId) => {
              if (itemId === 'more') return;
              toggleLodEntityWindow(Number(itemId));
              // The row selection follows the window
              queueMicrotask(() => updateDebuggerTab(TAB_ID));
            },
          },
        }),
      ];
    },
  });
};
