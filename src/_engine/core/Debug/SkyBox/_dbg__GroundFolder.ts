import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { numberParam } from './_dbg__LayerFolderItems';

const isOff = () => !skyBoxProxy.ground.enabled;

/** The active sky box's ground: the lower hemisphere's colour (also the ambient light's AUTO
 * ground colour). */
export const buildGroundFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.ground;
  return {
    type: 'folder',
    id: 'ground',
    title: 'Ground',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam('ground.enabled', 'ground enabled', Boolean(value), e),
      },
      {
        key: 'color',
        target,
        label: 'Color',
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('ground.color', 'ground color', value, e),
      },
      numberParam(target, 'ground', 'horizonBlend', 'Horizon blend', {
        min: 0,
        max: 0.5,
        step: 0.001,
        disabled: isOff,
      }),
      numberParam(target, 'ground', 'height', 'Height (deg below)', {
        min: -30,
        max: 30,
        step: 0.01,
        disabled: isOff,
      }),
      {
        key: 'useAtmosphereHorizon',
        target,
        label: 'Aerial perspective',
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('ground.useAtmosphereHorizon', 'aerial perspective', Boolean(value), e),
      },
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('ground') },
    ],
  };
};
