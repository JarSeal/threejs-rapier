import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { bakeEnvironment, getActiveSkyBox } from '../../SkyBox/SkyBox';
import { isDayNightEnabled } from '../../SkyBox/SkyComposite';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { numberParam } from './_dbg__LayerFolderItems';
import { envBakeStatsView } from './_dbg__EnvBakeStats';

/** A direct-path COLOR base has no environment (and no PMREM to blur). */
const hasNoEnvironment = () => !getActiveSkyBox()?.nodes.environment;
/** Only the composite path has an env bake. */
const isNotComposite = () => !getActiveSkyBox()?.isComposite;
/** The re-bake budget only applies to the day-night cycle's movement. */
const isNotDayNight = () => !isDayNightEnabled(getActiveSkyBox()?.def);

const SIZE_OPTIONS = [64, 128, 256, 512].map((size) => ({ text: String(size), value: size }));

const buildBakeFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.env;
  return {
    type: 'folder',
    id: 'environmentBake',
    title: 'Env bake',
    hidden: isNotComposite,
    content: [
      {
        key: 'size',
        target,
        label: 'Size',
        options: SIZE_OPTIONS,
        onChange: (value, e) => setSkyBoxParam('env.size', 'env size', Number(value), e),
      },
      {
        key: 'dynamic',
        target,
        label: 'Dynamic (re-bake on changes)',
        onChange: (value, e) => setSkyBoxParam('env.dynamic', 'dynamic', Boolean(value), e),
      },
      numberParam(target, 'env', 'updateAngleDeg', 'Day-night: re-bake angle (deg)', {
        min: 0,
        max: 10,
        step: 0.1,
        hidden: isNotDayNight,
      }),
      numberParam(target, 'env', 'maxUpdatesPerSec', 'Day-night: max re-bakes/s', {
        min: 0,
        max: 10,
        step: 0.1,
        hidden: isNotDayNight,
      }),
      { type: 'button', title: 'Re-bake now', onClick: bakeEnvironment },
      { type: 'separator' },
      { key: 'bakes', target: envBakeStatsView, label: 'Bakes', readonly: true, interval: 500 },
      {
        key: 'bakesPerSec',
        target: envBakeStatsView,
        label: 'Bakes/s (10 s)',
        readonly: true,
        interval: 500,
      },
      { key: 'cpuMs', target: envBakeStatsView, label: 'CPU ms', readonly: true, interval: 500 },
      { key: 'gpuMs', target: envBakeStatsView, label: 'GPU ms', readonly: true, interval: 500 },
    ],
  };
};

/** The active sky box's env layer: background blur, intensities and the env bake. */
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
        hidden: hasNoEnvironment,
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
        hidden: hasNoEnvironment,
        onChange: (value, e) =>
          setSkyBoxParam('env.environmentIntensity', 'environment intensity', Number(value), e),
      },
      buildBakeFolder(),
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('env') },
    ],
  };
};
