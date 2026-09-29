import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { isDayNightEnabled } from '../../SkyBox/SkyComposite';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { numberParam } from './_dbg__LayerFolderItems';
import { buildDiscLightFolder } from './_dbg__DiscLightFolder';

const isOff = () => !skyBoxProxy.moon.enabled;
/** With day-night on, the time of day and the phase place the moon. */
const isPlacedByDayNight = () => isOff() || isDayNightEnabled(getActiveSkyBox()?.def);
/** The cycle settings only matter with day-night. */
const isNotCycling = () => isOff() || !isDayNightEnabled(getActiveSkyBox()?.def);

/** The active sky box's moon (moons[0]): its position without day-night, its disc and phase,
 * and its light. */
export const buildMoonFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.moon;
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
    title: 'Moon',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam('moons.0.enabled', 'moon enabled', Boolean(value), e),
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
        onChange: (value, e) => setSkyBoxParam('moons.0.phaseMode', 'phase mode', value, e),
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
        onChange: (value, e) => setSkyBoxParam('moons.0.color', 'moon color', value, e),
      },
      param('limbDarkening', 'Limb darkening', 0, 1, 0.001),
      param('earthshine', 'Earthshine', 0, 1, 0.001),
      buildDiscLightFolder('moonLight'),
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('moon') },
    ],
  };
};
