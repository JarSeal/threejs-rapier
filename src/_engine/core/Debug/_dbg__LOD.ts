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
import {
  getLodBias,
  getLodDebugOptions,
  getLodFrameStats,
  getLodMaxSelectionsPerFrame,
  setLodBias,
  setLodDebugOptions,
  setLodMaxSelectionsPerFrame,
} from '../Lod/LodSystem';
import {
  findNearestLodEntityInView,
  getLodEntityName,
  getOpenLodEntityWindowIds,
  toggleLodEntityWindow,
} from './Lod/_dbg__LodEntityWindow';
import {
  isLodOverlayEnabled,
  LOD_OVERLAY_COLOR_NAMES,
  setLodOverlayEnabled,
} from './Lod/_dbg__LodOverlay';

// The LOD tab (docs/plans/_DONE_p348_ecs-lod-selection.md §6): counts per level, the last frame's
// selections and applies, the selection's runtime overrides, the level overlay
// (Lod/_dbg__LodOverlay.ts) and the per-entity LOD windows (Lod/_dbg__LodEntityWindow.ts).
// Nothing is persisted: it's all for inspecting, and a reload starts from the app's values.
// Default world only.

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
    if (
      world.isDisabled(entityId) ||
      world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)
    ) {
      suffix = 'out of view';
    } else if (world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)) {
      suffix = 'culled';
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
  };
  const statsState = { selections: 0, lapFrames: 1, applies: 0, totalApplies: 0, selectionMs: 0 };
  const countsState = { text: '' };

  /** Levels of the entity with the most, which the counts and the force options list. */
  let levelCount = 1;
  let builtLevelCount = 0;

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

      const stats = getLodFrameStats(world);
      statsState.selections = stats.selections;
      statsState.lapFrames = stats.lapFrames;
      statsState.applies = stats.applies;
      statsState.totalApplies = stats.totalApplies;
      statsState.selectionMs = stats.selectionMs;

      const counts = countLevels();
      countsState.text = formatCounts(counts);
      levelCount = counts.levels.length;

      // Another level count (eg. a scene change): the force options and the counts' rows need
      // a rebuild. Deferred, since this runs inside a refresh or a build.
      if (builtLevelCount && levelCount !== builtLevelCount) {
        builtLevelCount = 0;
        queueMicrotask(() => updateDebuggerTab(TAB_ID, { rebuild: true }));
      }
    },
    content: () => {
      builtLevelCount = levelCount;
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
