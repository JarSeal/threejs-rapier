import { CMP } from '../../../utils/CMP';
import type { DebuggerTabDef } from '../../../debug/DebuggerGUI';
import {
  PROFILER_LS_KEY,
  PROFILER_UI_LS_KEY,
  PROFILER_UPDATE_RATES_HZ,
  type ProfilerSettings,
} from '../../../debug/Profiler';

export const PROFILER_SETTINGS_TAB_ID = 'profilerSettings';

export const PROFILER_SETTINGS_PERSIST_KEYS = [
  'updateRateHz',
  'openFromStatsPanels',
  'enabledInProdTest',
  'measureGpu',
] as const satisfies readonly (keyof ProfilerSettings)[];

type SettingsTabOpts = {
  settings: ProfilerSettings;
  /** A setting changed (already written and persisted): apply it. */
  onChange: (key: keyof ProfilerSettings) => void;
  /** The clear-LS button removed the stored settings. */
  onClearLS: () => void;
};

const UPDATE_RATE_OPTIONS = Object.fromEntries(
  PROFILER_UPDATE_RATES_HZ.map((hz) => [`${hz} Hz`, hz])
) as Record<string, number>;

/**
 * The Settings tab: the update rate, the entry points and prodTest.
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
