import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { buildAutoColorItems, numberParam } from './_dbg__LayerFolderItems';

const isOff = () => !skyBoxProxy.atmosphere.enabled;

/** The active sky box's atmosphere (Preetham scattering, driven by the Sun folder's sun). */
export const buildAtmosphereFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.atmosphere;
  const param = (key: string, label: string, min: number, max: number, step: number) =>
    numberParam(target, 'atmosphere', key, label, { min, max, step, disabled: isOff });
  return {
    type: 'folder',
    id: 'atmosphere',
    title: 'Atmosphere',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam('atmosphere.enabled', 'atmosphere enabled', Boolean(value), e),
      },
      param('turbidity', 'Turbidity', 0, 20, 0.01),
      param('rayleigh', 'Rayleigh', 0, 4, 0.001),
      param('mieCoefficient', 'Mie coefficient', 0, 0.1, 0.0001),
      param('mieDirectionalG', 'Mie directional G', 0, 0.999, 0.001),
      param('exposure', 'Exposure (sky only)', 0, 4, 0.001),
      param('sunIntensity', 'Sun intensity', 0, 5, 0.01),
      param('twilightLength', 'Twilight length', 0.05, 4, 0.01),
      ...buildAutoColorItems(target, 'atmosphere', 'nightSkyColor', 'Night sky color', isOff),
      {
        key: 'horizonTint',
        target,
        label: 'Horizon tint',
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('atmosphere.horizonTint', 'horizon tint', value, e),
      },
      {
        key: 'zenithTint',
        target,
        label: 'Zenith tint',
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('atmosphere.zenithTint', 'zenith tint', value, e),
      },
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('atmosphere') },
    ],
  };
};
