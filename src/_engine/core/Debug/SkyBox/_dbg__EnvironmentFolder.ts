import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import {
  _isSkyCompositeForced,
  _setSkyCompositeForced,
  bakeEnvironment,
  getActiveSkyBox,
} from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { envBakeStatsView, isContinuousEnvBake, setContinuousEnvBake } from './_dbg__EnvBakeStats';

/** A direct-path COLOR base has no environment (and no PMREM to blur). */
const hasNoEnvironment = () => !getActiveSkyBox()?.nodes.environment;
/** Only the composite path has an env bake. */
const isNotComposite = () => !getActiveSkyBox()?.isComposite;

const SIZE_OPTIONS = [64, 128, 256, 512].map((size) => ({ text: String(size), value: size }));

// "Force composite path" and "Re-bake every frame" are measuring tools for p112/p113; p113
// Phase 2 removes them once its bake measurements are recorded.

const buildBakeFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.env;
  const continuous = { on: isContinuousEnvBake() };
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
      { type: 'button', title: 'Re-bake now', onClick: bakeEnvironment },
      { type: 'separator' },
      { key: 'bakes', target: envBakeStatsView, label: 'Bakes', readonly: true, interval: 500 },
      { key: 'cpuMs', target: envBakeStatsView, label: 'CPU ms', readonly: true, interval: 500 },
      { key: 'gpuMs', target: envBakeStatsView, label: 'GPU ms', readonly: true, interval: 500 },
      {
        key: 'on',
        target: continuous,
        label: 'Re-bake every frame',
        onChange: (value) => setContinuousEnvBake(Boolean(value)),
      },
    ],
  };
};

/** The active sky box's env layer: background blur, intensities and the env bake. */
export const buildEnvironmentFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.env;
  const force = { forced: _isSkyCompositeForced() };
  return {
    type: 'folder',
    id: 'environment',
    title: 'Environment',
    hidden: () => !getActiveSkyBox(),
    content: [
      {
        key: 'forced',
        target: force,
        label: 'Force composite path',
        onChange: (value) => _setSkyCompositeForced(Boolean(value)),
      },
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
