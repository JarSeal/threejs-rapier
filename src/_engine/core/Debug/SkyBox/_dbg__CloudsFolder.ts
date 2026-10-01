import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { numberParam, tupleParams } from './_dbg__LayerFolderItems';

/** Clouds need the atmosphere. */
const needsAtmosphere = () => !skyBoxProxy.atmosphere.enabled;
const isOff = () => !skyBoxProxy.clouds.enabled || needsAtmosphere();

/** The active sky box's clouds (SkyMesh's, lit and seen through the atmosphere). */
export const buildCloudsFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.clouds;
  const param = (key: string, label: string, min: number, max: number, step: number) =>
    numberParam(target, 'clouds', key, label, { min, max, step, disabled: isOff });
  return {
    type: 'folder',
    id: 'clouds',
    title: 'Clouds',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled (needs the atmosphere)',
        disabled: needsAtmosphere,
        onChange: (value, e) =>
          setSkyBoxParam('clouds.enabled', 'clouds enabled', Boolean(value), e),
      },
      param('coverage', 'Coverage', 0, 1, 0.001),
      param('density', 'Density', 0, 4, 0.001),
      param('scale', 'Scale', 0, 0.002, 0.000001),
      param('speed', 'Speed', 0, 0.0005, 0.000001),
      param('elevation', 'Elevation', 0, 1, 0.001),
      {
        key: 'color',
        target,
        label: 'Color',
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('clouds.color', 'clouds color', value, e),
      },
      ...tupleParams(target, 'clouds', 'windDirection', ['Wind x', 'Wind z'], {
        min: -5,
        max: 5,
        step: 0.01,
        disabled: isOff,
      }),
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('clouds') },
    ],
  };
};
