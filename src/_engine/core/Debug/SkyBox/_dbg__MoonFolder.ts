import * as THREE from 'three/webgpu';
import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import type { SkyBoxMoonDef } from '../../SkyBox/SkyBoxTypes';
import { isDayNightEnabled, isOn } from '../../SkyBox/SkyComposite';
import { MOON_DEFAULTS } from '../../SkyBox/layers/moon';
import { getActiveCamera } from '../../CameraManager';
import {
  getElevationAzimuth,
  isListOverrideAnArray,
  LAYER_PATHS,
  resetSkyBoxLayer,
  setSkyBoxParam,
  skyBoxProxy,
} from './_dbg__SkyBoxShared';
import { numberParam } from './_dbg__LayerFolderItems';
import { buildDiscLightFolder } from './_dbg__DiscLightFolder';
import {
  buildListItems,
  buildResetListButton,
  hasNoEntries,
  offSuffix,
  type ListConfig,
} from './_dbg__ListFolderItems';

/**
 * The Moons folder (p114): the active sky box's moons list (up to 2: select, add, duplicate,
 * remove) and the selected moon's position without day-night, its disc and phase, and its
 * light. With day-night on, each moon has its own orbit: the time of day and its phase place it.
 */

const isOff = () => hasNoEntries('moons') || !skyBoxProxy.moon.enabled;
/** With day-night on, the time of day and the phase place the moon. */
const isPlacedByDayNight = () => isOff() || isDayNightEnabled(getActiveSkyBox()?.def);
/** The cycle settings only matter with day-night. */
const isNotCycling = () => isOff() || !isDayNightEnabled(getActiveSkyBox()?.def);

const _direction = new THREE.Vector3();

/** A phase `quarter`s of a cycle further on, in [0, 1). */
const addToPhase = (phase: number | undefined, quarters: number) =>
  Math.round((((phase ?? MOON_DEFAULTS.phase) + quarters * 0.25) % 1) * 1000) / 1000;

const LIST: ListConfig<SkyBoxMoonDef> = {
  list: 'moons',
  name: 'moon',
  describe: (moon, i) =>
    `${i + 1}${offSuffix(moon)}, phase ${moon.phase ?? MOON_DEFAULTS.phase}${isOn(moon.light) ? ', light' : ''}`,
  // A quarter moon, at the view without day-night (with it, the orbit places it)
  create: () => {
    const camera = getActiveCamera();
    const moon: SkyBoxMoonDef = { phase: 0.25 };
    return camera
      ? { ...moon, ...getElevationAzimuth(camera.getWorldDirection(_direction)) }
      : moon;
  },
  // A quarter of a cycle on (a different place in the sky), and without a second shadow
  duplicate: (moon) => {
    const copy: SkyBoxMoonDef = {
      ...moon,
      phase: addToPhase(moon.phase, 1),
      azimuth: ((moon.azimuth ?? MOON_DEFAULTS.azimuth) + 15) % 360,
    };
    if (copy.light) copy.light = { ...copy.light, castShadow: false };
    return copy;
  },
};

const buildSelectedMoonFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.moon;
  const path = LAYER_PATHS.moon;
  const param = (
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    disabled: () => boolean = isOff
  ) => numberParam(target, 'moon', key, label, { min, max, step, disabled });
  return {
    type: 'folder',
    id: 'moon',
    title: 'Selected moon',
    hidden: () => hasNoEntries('moons'),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam(`${path}.enabled`, 'moon enabled', Boolean(value), e),
      },
      param('elevation', 'Elevation (deg)', -90, 90, 0.01, isPlacedByDayNight),
      param('azimuth', 'Azimuth (deg)', 0, 360, 0.01, isPlacedByDayNight),
      param('phase', 'Phase (0 new, 0.5 full)', 0, 0.999, 0.001),
      {
        key: 'phaseMode',
        target,
        label: 'Phase mode',
        options: [
          { text: 'Fixed', value: 'FIXED' },
          { text: 'Cycle (day-night)', value: 'CYCLE' },
        ],
        disabled: isNotCycling,
        onChange: (value, e) => setSkyBoxParam(`${path}.phaseMode`, 'phase mode', value, e),
      },
      param('lunarCycleDays', 'Lunar cycle (days)', 1, 60, 0.01, isNotCycling),
      param('inclination', 'Inclination (deg)', 0, 30, 0.1, isNotCycling),
      param('discSize', 'Disc size', 0, 20, 0.01),
      param('intensity', 'Intensity', 0, 50, 0.01),
      {
        key: 'color',
        target,
        label: 'Color',
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam(`${path}.color`, 'moon color', value, e),
      },
      param('limbDarkening', 'Limb darkening', 0, 1, 0.001),
      param('earthshine', 'Earthshine', 0, 1, 0.001),
      buildDiscLightFolder('moonLight'),
      {
        type: 'button',
        title: 'Reset moon',
        disabled: () => isListOverrideAnArray('moons'),
        onClick: () => resetSkyBoxLayer('moon'),
      },
    ],
  };
};

/** The Moons folder (see the file comment). */
export const buildMoonsFolder = (): DebuggerPaneItem => ({
  type: 'folder',
  id: 'moons',
  title: 'Moons',
  hidden: () => !getActiveSkyBox(),
  content: [...buildListItems(LIST), buildSelectedMoonFolder(), buildResetListButton(LIST)],
});
