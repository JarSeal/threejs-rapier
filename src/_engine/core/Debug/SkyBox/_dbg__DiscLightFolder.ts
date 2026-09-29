import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { FOUR_PX_TO_8K_LIST } from '../../../utils/constants';
import { LAYER_PATHS, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { buildAutoColorItems, numberParam, tupleParams } from './_dbg__LayerFolderItems';

const PRESET_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'].map((value) => ({ text: value, value }));
const MAP_SIZE_OPTIONS = FOUR_PX_TO_8K_LIST.filter((option) => option.value >= 256);

/** A sun's or moon's managed directional light (a subfolder of the Sun or Moon folder). */
export const buildDiscLightFolder = (layer: 'sunLight' | 'moonLight'): DebuggerPaneItem => {
  const target = skyBoxProxy[layer];
  const path = LAYER_PATHS[layer];
  const name = layer === 'sunLight' ? 'sun' : 'moon';
  const isOff = () => !target.enabled;
  const param = (key: string, label: string, min: number, max: number, step: number) =>
    numberParam(target, layer, key, label, { min, max, step, disabled: isOff });
  return {
    type: 'folder',
    id: layer,
    title: 'Light',
    content: [
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam(`${path}.enabled`, `${name} light enabled`, Boolean(value), e),
      },
      param('intensity', 'Intensity', 0, 20, 0.01),
      ...buildAutoColorItems(target, layer, 'color', 'Color', isOff),
      ...tupleParams(target, layer, 'horizonFade', ['Fade starts (deg)', 'Faded out (deg)'], {
        min: -20,
        max: 30,
        step: 0.1,
        disabled: isOff,
      }),
      {
        key: 'castShadow',
        target,
        label: 'Cast shadow (rebuilds materials)',
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam(`${path}.castShadow`, 'cast shadow', Boolean(value), e),
      },
      {
        key: 'shadowPreset',
        target,
        label: 'Shadow preset',
        options: PRESET_OPTIONS,
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam(`${path}.shadowPreset`, 'shadow preset', value, e),
      },
      {
        key: 'shadowMapSize',
        target,
        label: 'Shadow map size',
        options: MAP_SIZE_OPTIONS,
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam(`${path}.shadowMapSize`, 'shadow map size', Number(value), e),
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
        onChange: (value, e) => setSkyBoxParam(`${path}.shadowFollow`, 'shadow follow', value, e),
      },
    ],
  };
};
