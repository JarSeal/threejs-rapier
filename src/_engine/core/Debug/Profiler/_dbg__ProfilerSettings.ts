import { CMP } from '../../../utils/CMP';
import type { DebuggerTabDef } from '../../../debug/DebuggerGUI';
import {
  PROFILER_LS_KEY,
  PROFILER_UI_LS_KEY,
  PROFILER_UPDATE_RATES_HZ,
  type ProfilerOverviewMetricEntry,
  type ProfilerSettings,
} from '../../../debug/Profiler';
import {
  escapeProfilerHtml as esc,
  getDefaultOverviewMetrics,
  getOverviewMetricLabel,
} from './_dbg__ProfilerOverview';

export const PROFILER_SETTINGS_TAB_ID = 'profilerSettings';

export const PROFILER_SETTINGS_PERSIST_KEYS = [
  'updateRateHz',
  'overviewMetrics',
  'openFromStatsPanels',
  'enabledInProdTest',
  'measureGpu',
] as const satisfies readonly (keyof ProfilerSettings)[];

type SettingsTabOpts = {
  settings: ProfilerSettings;
  /** A setting changed (already written and persisted): apply it. */
  onChange: (key: keyof ProfilerSettings) => void;
  /** Changes settings outside the pane bindings: persists and applies them. */
  setSettings: (partial: Partial<ProfilerSettings>) => void;
  /** The clear-LS button removed the stored settings. */
  onClearLS: () => void;
};

const UPDATE_RATE_OPTIONS = Object.fromEntries(
  PROFILER_UPDATE_RATES_HZ.map((hz) => [`${hz} Hz`, hz])
) as Record<string, number>;

const isDefaultMetricList = (list: ProfilerOverviewMetricEntry[]) =>
  JSON.stringify(list) === JSON.stringify(getDefaultOverviewMetrics());

/**
 * The Overview rows editor: a visibility checkbox and ▲ / ▼ per row, and "Reset to default". A
 * plain CMP list (the debugger list has no reordering). Re-rendered by the tab refresh that
 * every change triggers; its click handler survives the re-render.
 */
const createMetricListEditor = (opts: SettingsTabOpts) => {
  const renderList = () => {
    const list = opts.settings.overviewMetrics;
    let rows = '';
    for (let i = 0; i < list.length; i++) {
      const { id, visible } = list[i];
      const label = esc(getOverviewMetricLabel(id));
      rows +=
        `<li${visible ? '' : ' class="isHidden"'}>` +
        `<label><input type="checkbox" data-action="toggle" data-index="${i}"` +
        `${visible ? ' checked' : ''}> ${label}</label>` +
        `<button data-action="up" data-index="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>` +
        `<button data-action="down" data-index="${i}" title="Move down"` +
        `${i === list.length - 1 ? ' disabled' : ''}>▼</button></li>`;
    }
    const resetDisabled = isDefaultMetricList(list) ? ' disabled' : '';
    return (
      `<div class="profilerMetricList"><div class="profilerMetricListHead">` +
      `<h4>Overview rows</h4>` +
      `<button data-action="reset" title="Default rows and order"${resetDisabled}>Reset to default</button>` +
      `</div><ol>${rows}</ol></div>`
    );
  };

  const onClick = (e: Event) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!target || (target as HTMLButtonElement).disabled) return;
    const { action, index: indexAttr } = target.dataset;
    if (action === 'reset') {
      opts.setSettings({ overviewMetrics: getDefaultOverviewMetrics() });
      return;
    }
    const index = Number(indexAttr);
    const next = opts.settings.overviewMetrics.map((entry) => ({ ...entry }));
    if (!next[index]) return;
    if (action === 'toggle') {
      next[index].visible = !next[index].visible;
    } else {
      const other = action === 'up' ? index - 1 : index + 1;
      if (!next[other]) return;
      [next[index], next[other]] = [next[other], next[index]];
    }
    opts.setSettings({ overviewMetrics: next });
  };

  return CMP({ html: renderList, onClick });
};

/**
 * The Settings tab: the update rate, what the Overview shows, measuring, the entry points and
 * prodTest.
 * @param opts ({@link SettingsTabOpts})
 */
export const createProfilerSettingsTabDef = (
  opts: SettingsTabOpts
): DebuggerTabDef<ProfilerSettings> => ({
  id: PROFILER_SETTINGS_TAB_ID,
  title: 'Settings',
  icon: 'gear',
  orderNr: 100,
  lsKey: PROFILER_LS_KEY,
  uiLsKey: PROFILER_UI_LS_KEY,
  state: opts.settings,
  persistKeys: PROFILER_SETTINGS_PERSIST_KEYS,
  onClearLS: opts.onClearLS,
  content: () => [
    {
      pane: true,
      content: [
        {
          type: 'folder',
          id: 'general',
          title: 'General',
          content: [
            {
              key: 'updateRateHz',
              label: 'Update rate',
              options: UPDATE_RATE_OPTIONS,
              onChange: () => opts.onChange('updateRateHz'),
            },
          ],
        },
        {
          type: 'folder',
          id: 'measuring',
          title: 'Measuring',
          content: [
            {
              key: 'measureGpu',
              label: 'Measure GPU time',
              onChange: () => opts.onChange('measureGpu'),
            },
          ],
        },
      ],
    },
    createMetricListEditor(opts),
    {
      pane: true,
      content: [
        {
          type: 'folder',
          id: 'entryPoints',
          title: 'Entry points',
          content: [
            {
              key: 'openFromStatsPanels',
              label: 'Open from stats panels',
              onChange: () => opts.onChange('openFromStatsPanels'),
            },
          ],
        },
        {
          type: 'folder',
          id: 'prodTest',
          title: 'Production test mode',
          content: [
            {
              key: 'enabledInProdTest',
              label: 'Enable in prodTest',
              onChange: () => opts.onChange('enabledInProdTest'),
            },
          ],
        },
      ],
    },
    CMP({
      class: 'profilerNote',
      text:
        '"Enable in prodTest" is read when prodTest starts: the profiler then loads there, an ' +
        'open window stays open over the play button, and the on-screen tools get its button ' +
        '(when they are shown in prodTest).',
    }),
  ],
});
