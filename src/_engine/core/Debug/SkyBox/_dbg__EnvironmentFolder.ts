import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';

/** A COLOR base has no environment (and no PMREM to blur). */
const isColorBase = () => getActiveSkyBox()?.def.base.type === 'COLOR';

/** The active sky box's env layer: background blur and intensities. */
export const buildEnvironmentFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.env;
  return {
    type: 'folder',
    id: 'environment',
    title: 'Environment',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'backgroundRoughness',
        target,
        label: 'Background roughness',
        min: 0,
        max: 1,
        step: 0.001,
        hidden: isColorBase,
        onChange: (value, e) =>
          setSkyBoxParam('env.backgroundRoughness', 'background roughness', Number(value), e),
      },
      {
        key: 'backgroundIntensity',
        target,
        label: 'Background intensity',
        min: 0,
        max: 5,
        step: 0.01,
        onChange: (value, e) =>
          setSkyBoxParam('env.backgroundIntensity', 'background intensity', Number(value), e),
      },
      {
        key: 'environmentIntensity',
        target,
        label: 'Environment intensity',
        min: 0,
        max: 5,
        step: 0.01,
        hidden: isColorBase,
        onChange: (value, e) =>
          setSkyBoxParam('env.environmentIntensity', 'environment intensity', Number(value), e),
      },
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('env') },
    ],
  };
};
