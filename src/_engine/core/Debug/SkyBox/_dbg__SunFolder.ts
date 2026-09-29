import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { isDayNightEnabled } from '../../SkyBox/SkyComposite';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { buildAutoColorItems, numberParam } from './_dbg__LayerFolderItems';
import { buildDiscLightFolder } from './_dbg__DiscLightFolder';

const isOff = () => !skyBoxProxy.sun.enabled;
/** With day-night on, the time of day places the sun (the Day-night folder, p113 Phase 5). */
const isPlacedByDayNight = () => isDayNightEnabled(getActiveSkyBox()?.def);

/** The active sky box's primary sun (suns[0]): its position, which drives the atmosphere even
 * with the disc off, and its disc and halo. */
export const buildSunFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.sun;
  const param = (
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    disabled?: () => boolean
  ) => numberParam(target, 'sun', key, label, { min, max, step, disabled });
  return {
    type: 'folder',
    id: 'sun',
    title: 'Sun',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Disc enabled',
        onChange: (value, e) => setSkyBoxParam('suns.0.enabled', 'sun enabled', Boolean(value), e),
      },
      param('elevation', 'Elevation (deg)', -90, 90, 0.01, isPlacedByDayNight),
      param('azimuth', 'Azimuth (deg)', 0, 360, 0.01, isPlacedByDayNight),
      param('discSize', 'Disc size', 0, 20, 0.01, isOff),
      param('discIntensity', 'Disc intensity', 0, 200, 0.1, isOff),
      param('glowIntensity', 'Glow intensity', 0, 20, 0.01, isOff),
      param('glowSize', 'Glow size (deg)', 0.1, 90, 0.1, isOff),
      ...buildAutoColorItems(target, 'sun', 'color', 'Color', isOff),
      // Its own reset: "Reset layer" below resets the whole sun, light included
      buildDiscLightFolder('sunLight'),
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('sun') },
    ],
  };
};
