import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { FOUR_PX_TO_8K_LIST } from '../../../utils/constants';
import { setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { buildAutoColorItems, numberParam } from './_dbg__LayerFolderItems';

const isOff = () => !skyBoxProxy.sunLight.enabled;
const PRESET_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'].map((value) => ({ text: value, value }));
const MAP_SIZE_OPTIONS = FOUR_PX_TO_8K_LIST.filter((option) => option.value >= 256);

/** One end of horizonFade: both ends are written as the one tuple value. */
const horizonFadeParam = (key: 'horizonFadeStart' | 'horizonFadeEnd', label: string) => {
  const target = skyBoxProxy.sunLight;
  const tuple = (changed: number) =>
    key === 'horizonFadeStart'
      ? [changed, Number(target.horizonFadeEnd)]
      : [Number(target.horizonFadeStart), changed];
  return {
    key,
    target,
    label,
    min: -20,
    max: 30,
    step: 0.1,
    disabled: isOff,
    onChange: (value: unknown, e: { prev: unknown }) =>
      setSkyBoxParam('suns.0.light.horizonFade', 'horizon fade', tuple(Number(value)), {
        prev: tuple(Number(e.prev)),
      }),
  } satisfies DebuggerPaneItem;
};

/** The primary sun's managed directional light (a subfolder of the Sun folder). */
export const buildSunLightFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.sunLight;
  const param = (key: string, label: string, min: number, max: number, step: number) =>
    numberParam(target, 'sunLight', key, label, { min, max, step, disabled: isOff });
  return {
    type: 'folder',
    id: 'sunLight',
    title: 'Light',
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam('suns.0.light.enabled', 'sun light enabled', Boolean(value), e),
      },
      param('intensity', 'Intensity', 0, 20, 0.01),
      ...buildAutoColorItems(target, 'sunLight', 'color', 'Color', isOff),
      horizonFadeParam('horizonFadeStart', 'Fade starts (deg)'),
      horizonFadeParam('horizonFadeEnd', 'Faded out (deg)'),
      {
        key: 'castShadow',
        target,
        label: 'Cast shadow (rebuilds materials)',
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('suns.0.light.castShadow', 'cast shadow', Boolean(value), e),
      },
      {
        key: 'shadowPreset',
        target,
        label: 'Shadow preset',
        options: PRESET_OPTIONS,
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('suns.0.light.shadowPreset', 'shadow preset', value, e),
      },
      {
        key: 'shadowMapSize',
        target,
        label: 'Shadow map size',
        options: MAP_SIZE_OPTIONS,
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('suns.0.light.shadowMapSize', 'shadow map size', Number(value), e),
      },
      param('shadowBias', 'Shadow bias', -0.01, 0.01, 0.00001),
      param('shadowNormalBias', 'Shadow normal bias', 0, 0.5, 0.001),
      param('shadowFrustumSize', 'Shadow frustum (half)', 1, 500, 0.1),
      param('distance', 'Distance', 1, 1000, 0.1),
      {
        key: 'shadowFollow',
        target,
        label: 'Shadow follows',
        options: [
          { text: 'Active camera', value: 'ACTIVE_CAMERA' },
          { text: 'Origin', value: 'ORIGIN' },
        ],
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam('suns.0.light.shadowFollow', 'shadow follow', value, e),
      },
    ],
  };
};
