import * as THREE from 'three/webgpu';
import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import type { SkyBoxSunDef } from '../../SkyBox/SkyBoxTypes';
import { isDayNightEnabled, isOn } from '../../SkyBox/SkyComposite';
import { getDayNightStartTime, turnWithSky } from '../../SkyBox/SkyTime';
import { getActiveCamera } from '../../CameraManager';
import {
  getElevationAzimuth,
  getSelectedIndex,
  isListOverrideAnArray,
  LAYER_PATHS,
  resetSkyBoxLayer,
  setSkyBoxParam,
  skyBoxProxy,
} from './_dbg__SkyBoxShared';
import { buildAutoColorItems, numberParam } from './_dbg__LayerFolderItems';
import { buildDiscLightFolder } from './_dbg__DiscLightFolder';
import {
  buildListItems,
  buildResetListButton,
  hasNoEntries,
  offSuffix,
  type ListConfig,
} from './_dbg__ListFolderItems';

/**
 * The Suns folder (p114): the active sky box's suns list (up to 4: select, add, duplicate,
 * remove) and the selected sun's position, disc, halo and light. suns[0] is the primary: with
 * day-night on, the time of day places it. An extra sun's elevation and azimuth are its own,
 * which with day-night and `rotateWithSky` are where it stands at the start time.
 */

const isOff = () => hasNoEntries('suns') || !skyBoxProxy.sun.enabled;
const isDayNight = () => isDayNightEnabled(getActiveSkyBox()?.def);
const isPrimary = () => getSelectedIndex('suns') === 0;
/** With day-night on, the time of day places the primary sun (the Day-night folder). */
const isPlacedByDayNight = () => isPrimary() && isDayNight();
/** An extra sun that turns with the sky: its sliders are its start-time position. */
const isTurningWithSky = () =>
  !isPrimary() && isDayNight() && Boolean(skyBoxProxy.sun.rotateWithSky);

const _direction = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const formatPosition = (direction: THREE.Vector3) => {
  const { elevation, azimuth } = getElevationAzimuth(direction);
  return `${elevation.toFixed(1)}°, ${azimuth.toFixed(1)}°`;
};

/** Read-only: where the selected (extra) sun is now. */
const info = {
  get position() {
    const active = getActiveSkyBox();
    const direction = active?.uniforms.suns[getSelectedIndex('suns')]?.direction.value;
    return direction ? formatPosition(direction) : '-';
  },
};

/**
 * A world direction as a sun's elevation and azimuth, for the sun at `index`: with day-night on
 * and an extra sun (which turns with the sky by default), turned back to the start time, so it
 * shows up where the direction points now.
 */
const toSunPosition = (direction: THREE.Vector3, index: number) => {
  const active = getActiveSkyBox();
  if (index > 0 && active && isDayNightEnabled(active.def)) {
    const { dayNight } = active.def;
    turnWithSky(
      dayNight,
      direction,
      active.time.timeOfDay,
      getDayNightStartTime(dayNight),
      direction
    );
  }
  return getElevationAzimuth(direction);
};

/** A new sun at the view direction. */
const createSun = (index: number): SkyBoxSunDef => {
  const camera = getActiveCamera();
  if (!camera) return {};
  return toSunPosition(camera.getWorldDirection(_direction), index);
};

const LIST: ListConfig<SkyBoxSunDef> = {
  list: 'suns',
  name: 'sun',
  addTitle: 'Add (at view)',
  describe: (sun, i) =>
    `${i + 1}${i === 0 ? ' (primary)' : ''}${offSuffix(sun)}${isOn(sun.light) ? ', light' : ''}`,
  create: createSun,
  // Next to the original (15° further round), and without a second shadow
  duplicate: (sun) => {
    const index = getSelectedIndex('suns');
    const current = getActiveSkyBox()?.uniforms.suns[index]?.direction.value;
    const direction = _direction.copy(current ?? UP);
    direction.applyAxisAngle(UP, THREE.MathUtils.degToRad(15));
    const copy: SkyBoxSunDef = { ...sun, ...toSunPosition(direction, index + 1) };
    if (copy.light) copy.light = { ...copy.light, castShadow: false };
    return copy;
  },
};

const buildSelectedSunFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.sun;
  const path = LAYER_PATHS.sun;
  const param = (
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    disabled: () => boolean = isOff
  ) => numberParam(target, 'sun', key, label, { min, max, step, disabled });
  return {
    type: 'folder',
    id: 'sun',
    title: 'Selected sun',
    hidden: () => hasNoEntries('suns'),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Disc enabled',
        onChange: (value, e) => setSkyBoxParam(`${path}.enabled`, 'sun enabled', Boolean(value), e),
      },
      param('elevation', 'Elevation (deg)', -90, 90, 0.01, isPlacedByDayNight),
      param('azimuth', 'Azimuth (deg)', 0, 360, 0.01, isPlacedByDayNight),
      {
        key: 'rotateWithSky',
        target,
        label: 'Turns with the sky',
        hidden: isPrimary,
        disabled: () => !isDayNight(),
        onChange: (value, e) =>
          setSkyBoxParam(`${path}.rotateWithSky`, 'rotate with sky', Boolean(value), e),
      },
      {
        key: 'position',
        target: info,
        label: 'Now at (elev, az)',
        readonly: true,
        interval: 250,
        hidden: () => !isTurningWithSky(),
      },
      param('discSize', 'Disc size', 0, 20, 0.01),
      param('discIntensity', 'Disc intensity', 0, 200, 0.1),
      param('glowIntensity', 'Glow intensity', 0, 20, 0.01),
      param('glowSize', 'Glow size (deg)', 0.1, 90, 0.1),
      ...buildAutoColorItems(target, 'sun', 'color', 'Color', isOff),
      // Its own reset: "Reset sun" below resets the whole sun, light included
      buildDiscLightFolder('sunLight'),
      {
        type: 'button',
        title: 'Reset sun',
        disabled: () => isListOverrideAnArray('suns'),
        onClick: () => resetSkyBoxLayer('sun'),
      },
    ],
  };
};

/** The Suns folder (see the file comment). */
export const buildSunsFolder = (): DebuggerPaneItem => ({
  type: 'folder',
  id: 'suns',
  title: 'Suns',
  hidden: () => !getActiveSkyBox(),
  content: [...buildListItems(LIST), buildSelectedSunFolder(), buildResetListButton(LIST)],
});
