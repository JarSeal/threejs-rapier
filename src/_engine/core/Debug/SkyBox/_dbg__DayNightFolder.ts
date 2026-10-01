import type { FolderApi, Pane } from 'tweakpane';
import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import {
  getActiveSkyBox,
  getDayNightSpeed,
  getMoonPhase,
  getSunElevation,
  getTimeOfDay,
  isDayNightPlaying,
  pauseDayNight,
  playDayNight,
  setDayNightSpeed,
  setTimeOfDay,
} from '../../SkyBox/SkyBox';
import { isDayNightEnabled } from '../../SkyBox/SkyComposite';
import { DAY_NIGHT_DEFAULTS } from '../../SkyBox/SkyTime';
import { envBakeStatsView } from './_dbg__EnvBakeStats';
import { getDefValue, resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { numberParam } from './_dbg__LayerFolderItems';

const isOff = () => !isDayNightEnabled(getActiveSkyBox()?.def);

// Transport: the running cycle (runtime only, like the Loop tab's play controls: never stored as
// an override, never recorded for undo). It drives the same API a game does.

const transport = { playing: false, speed: 1, timeOfDay: DAY_NIGHT_DEFAULTS.timeOfDay };

/** Set while the time slider is dragged: the cycle is paused, and resumes on release. */
let scrub: { wasPlaying: boolean } | null = null;

/** Syncs the transport controls from the running cycle (before every tab build and refresh). */
export const syncDayNightTransport = () => {
  transport.playing = isDayNightPlaying();
  transport.speed = getDayNightSpeed() ?? DAY_NIGHT_DEFAULTS.speed;
  transport.timeOfDay = getTimeOfDay() ?? DAY_NIGHT_DEFAULTS.timeOfDay;
};

const formatTime = (hours: number) => {
  const minutes = Math.floor(hours * 60) % (24 * 60);
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const MOON_PHASE_NAMES: [number, string][] = [
  [0.03, 'new'],
  [0.22, 'waxing crescent'],
  [0.28, 'first quarter'],
  [0.47, 'waxing gibbous'],
  [0.53, 'full'],
  [0.72, 'waning gibbous'],
  [0.78, 'last quarter'],
  [0.97, 'waning crescent'],
  [1, 'new'],
];

const formatMoonPhase = (phase: number | null) => {
  if (phase === null) return '- (no moon)';
  const name = MOON_PHASE_NAMES.find(([upTo]) => phase < upTo)?.[1] ?? 'new';
  return `${phase.toFixed(3)} (${name})`;
};

/** What the read-only bindings poll. */
const readouts = {
  get time() {
    const time = getTimeOfDay();
    return time === null ? '-' : formatTime(time);
  },
  get sunElevation() {
    const elevation = getSunElevation();
    return elevation === null ? '-' : `${((elevation * 180) / Math.PI).toFixed(1)}°`;
  },
  get moonPhase() {
    return formatMoonPhase(getMoonPhase());
  },
  get bakesPerSec() {
    return envBakeStatsView.bakesPerSec;
  },
};

const SPEED_BUTTONS: [string, number][] = [
  ['◀◀ ×−10', -10],
  ['◀ ×−1', -1],
  ['▶ ×1', 1],
  ['▶▶ ×10', 10],
  ['×100', 100],
];

/** One row of Tweakpane-styled speed buttons (a set speed also plays). It lives in a blade, so
 * it's disposed with the pane. */
const buildSpeedButtons = (parent: Pane | FolderApi) => {
  const blade = parent.addBlade({ view: 'separator' });
  const row = document.createElement('div');
  row.className = 'debuggerSkyTransportRow';
  for (const [title, speed] of SPEED_BUTTONS) {
    const button = document.createElement('button');
    button.className = 'tp-btnv_b';
    button.textContent = title;
    button.title = `Play at ×${speed}`;
    button.addEventListener('click', () => {
      setDayNightSpeed(speed);
      playDayNight();
      syncDayNightTransport();
      refresh();
    });
    row.appendChild(button);
  }
  blade.element.replaceChildren(row);
  const refresh = () => {
    row.classList.toggle('isDisabled', isOff());
  };
  refresh();
  return refresh;
};

const buildTransportFolder = (): DebuggerPaneItem => ({
  type: 'folder',
  id: 'dayNightTransport',
  title: 'Transport (runtime)',
  hidden: isOff,
  content: [
    { key: 'time', target: readouts, label: 'Time', readonly: true, interval: 250 },
    {
      key: 'sunElevation',
      target: readouts,
      label: 'Sun elevation',
      readonly: true,
      interval: 250,
    },
    { key: 'moonPhase', target: readouts, label: 'Moon phase', readonly: true, interval: 250 },
    {
      key: 'bakesPerSec',
      target: readouts,
      label: 'Bakes/s (10 s)',
      readonly: true,
      interval: 500,
    },
    {
      key: 'playing',
      target: transport,
      label: 'Playing',
      onChange: (value) => (value ? playDayNight() : pauseDayNight()),
    },
    { type: 'custom', build: buildSpeedButtons },
    {
      key: 'speed',
      target: transport,
      label: 'Speed',
      min: -100,
      max: 100,
      step: 0.1,
      onChange: (value) => setDayNightSpeed(Number(value)),
    },
    {
      key: 'timeOfDay',
      target: transport,
      label: 'Time of day (h)',
      min: 0,
      max: 24,
      step: 0.01,
      // Dragging pauses the cycle, and a playing one resumes on release
      onChange: (value, e) => {
        if (!scrub) {
          scrub = { wasPlaying: isDayNightPlaying() };
          pauseDayNight();
        }
        setTimeOfDay(Number(value));
        if (!e.last) return;
        if (scrub.wasPlaying) playDayNight();
        scrub = null;
      },
    },
  ],
});

// Config: the definition's values (stored as overrides and undoable, like every layer's)

const buildConfigFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.dayNight;
  const param = (key: string, label: string, min: number, max: number, step: number) =>
    numberParam(target, 'dayNight', key, label, { min, max, step, disabled: isOff });
  return {
    type: 'folder',
    id: 'dayNightConfig',
    title: 'Config',
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam('dayNight.enabled', 'day-night enabled', Boolean(value), e),
      },
      param('timeOfDay', 'Start time (h)', 0, 23.99, 0.01),
      {
        type: 'button',
        title: 'Use current time as start time',
        disabled: isOff,
        onClick: () => {
          const time = getTimeOfDay();
          if (time === null) return;
          const prev = getDefValue(getActiveSkyBox()?.def, 'dayNight.timeOfDay');
          setSkyBoxParam('dayNight.timeOfDay', 'start time', time, { prev });
        },
      },
      param('cycleDurationSec', 'Cycle duration (s)', 10, 7200, 1),
      param('speed', 'Start speed', -100, 100, 0.1),
      {
        key: 'playing',
        target,
        label: 'Plays on activation',
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('dayNight.playing', 'plays on activation', Boolean(value), e),
      },
      {
        key: 'timeSource',
        target,
        label: 'Time source',
        options: [
          { text: 'App loop (pauses with the app)', value: 'APP' },
          { text: 'Master loop', value: 'MAIN' },
          { text: 'Manual (setTimeOfDay only)', value: 'MANUAL' },
        ],
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('dayNight.timeSource', 'time source', value, e),
      },
      param('latitude', 'Latitude (deg)', -90, 90, 0.1),
      param('dayOfYear', 'Day of year', 1, 365, 1),
      param('axialTilt', 'Axial tilt (deg)', 0, 90, 0.01),
      param('northOffset', 'North offset (deg)', -180, 180, 0.1),
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('dayNight') },
    ],
  };
};

/** The active sky box's day-night cycle: the running cycle's transport and its definition. */
export const buildDayNightFolder = (): DebuggerPaneItem => ({
  type: 'folder',
  id: 'dayNight',
  title: 'Day-night',
  hidden: () => !getActiveSkyBox(),
  content: [buildTransportFolder(), buildConfigFolder()],
});
