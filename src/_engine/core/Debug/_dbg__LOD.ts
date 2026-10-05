import { createDebuggerTab, updateDebuggerTab } from '../../debug/DebuggerGUI';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { getConfig } from '../Config';
import {
  getLodBias,
  getLodDebugOptions,
  getLodFrameStats,
  setLodBias,
  setLodDebugOptions,
} from '../Lod/LodSystem';

// The LOD tab (docs/plans/p348_ecs-lod-selection.md §6): counts per level, the last frame's
// selections and applies, and the selection's runtime overrides. Nothing is persisted: the bias,
// freeze, forced level and camera are for inspecting, and a reload starts from the app's values.
// Default world only.

const TAB_ID = 'lodControls';
const formatInt = (v: number) => v.toFixed(0);

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
  const controls = { bias: 1, freeze: false, forceLevel: -1, useActiveCamera: false };
  const statsState = { selections: 0, applies: 0, totalApplies: 0, selectionMs: 0 };
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
      controls.bias = getLodBias();
      controls.freeze = opts.freeze;
      controls.forceLevel = opts.forceLevel;
      controls.useActiveCamera = opts.useActiveCamera;

      const stats = getLodFrameStats(world);
      statsState.selections = stats.selections;
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
          ],
        },
      ];
    },
  });
};
