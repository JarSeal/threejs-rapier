import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { numberParam, tupleParams } from './_dbg__LayerFolderItems';

const isOff = () => !skyBoxProxy.stars.enabled;
const isMilkyWayOff = () => isOff() || !skyBoxProxy.milkyWay.enabled;

/** The active sky box's stars, their twinkle and the Milky Way. */
export const buildStarsFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.stars;
  const param = (key: string, label: string, min: number, max: number, step: number) =>
    numberParam(target, 'stars', key, label, { min, max, step, disabled: isOff });
  return {
    type: 'folder',
    id: 'stars',
    title: 'Stars',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) => setSkyBoxParam('stars.enabled', 'stars enabled', Boolean(value), e),
      },
      param('density', 'Density', 0, 1, 0.001),
      param('brightness', 'Brightness', 0, 10, 0.01),
      param('size', 'Size', 0, 10, 0.01),
      param('colorVariance', 'Color variance', 0, 1, 0.001),
      numberParam(skyBoxProxy.starsTwinkle, 'starsTwinkle', 'amount', 'Twinkle amount', {
        min: 0,
        max: 1,
        step: 0.001,
        disabled: isOff,
      }),
      numberParam(skyBoxProxy.starsTwinkle, 'starsTwinkle', 'frequency', 'Twinkle frequency', {
        min: 0,
        max: 10,
        step: 0.01,
        disabled: isOff,
      }),
      ...tupleParams(target, 'stars', 'fadeRange', ['Show from sun (deg)', 'Full at sun (deg)'], {
        min: -30,
        max: 10,
        step: 0.1,
        disabled: isOff,
      }),
      {
        key: 'rotateWithSky',
        target,
        label: 'Rotate with sky (day-night)',
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('stars.rotateWithSky', 'rotate with sky', Boolean(value), e),
      },
      {
        key: 'seed',
        target,
        label: 'Seed',
        min: 0,
        max: 1000,
        step: 1,
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('stars.seed', 'seed', Math.round(Number(value)), e),
      },
      {
        type: 'folder',
        id: 'milkyWay',
        title: 'Milky Way',
        content: [
          {
            key: 'enabled',
            target: skyBoxProxy.milkyWay,
            label: 'Enabled',
            disabled: isOff,
            onChange: (value, e) =>
              setSkyBoxParam('stars.milkyWay.enabled', 'milky way enabled', Boolean(value), e),
          },
          numberParam(skyBoxProxy.milkyWay, 'milkyWay', 'intensity', 'Intensity', {
            min: 0,
            max: 2,
            step: 0.001,
            disabled: isMilkyWayOff,
          }),
          numberParam(skyBoxProxy.milkyWay, 'milkyWay', 'width', 'Width (deg)', {
            min: 0.1,
            max: 90,
            step: 0.1,
            disabled: isMilkyWayOff,
          }),
        ],
      },
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('stars') },
    ],
  };
};
