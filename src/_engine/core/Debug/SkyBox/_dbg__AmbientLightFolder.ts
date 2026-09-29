import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';
import { buildAutoColorItems, numberParam } from './_dbg__LayerFolderItems';

const isOff = () => !skyBoxProxy.ambient.enabled;
const NOTE = {
  text: 'The env bake already lights PBR materials, and this adds to it. For Lambert/Phong materials (no environment) and stylized looks.',
};

/** The managed hemisphere or ambient light that follows the sun (off by default). */
export const buildAmbientLightFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.ambient;
  return {
    type: 'folder',
    id: 'ambientLight',
    title: 'Ambient light',
    hidden: () => !getActiveSkyBox(),
    content: [
      { key: 'text', target: NOTE, label: 'Note', readonly: true, multiline: true, rows: 3 },
      {
        key: 'enabled',
        target,
        label: 'Enabled',
        onChange: (value, e) =>
          setSkyBoxParam('ambientLight.enabled', 'ambient light enabled', Boolean(value), e),
      },
      {
        key: 'type',
        target,
        label: 'Type',
        options: [
          { text: 'Hemisphere', value: 'HEMISPHERE' },
          { text: 'Ambient', value: 'AMBIENT' },
        ],
        disabled: isOff,
        onChange: (value, e) => setSkyBoxParam('ambientLight.type', 'ambient type', value, e),
      },
      numberParam(target, 'ambient', 'intensity', 'Intensity', {
        min: 0,
        max: 5,
        step: 0.01,
        disabled: isOff,
      }),
      ...buildAutoColorItems(target, 'ambient', 'skyColor', 'Sky color', isOff),
      ...buildAutoColorItems(
        target,
        'ambient',
        'groundColor',
        'Ground color',
        () => isOff() || target.type !== 'HEMISPHERE'
      ),
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('ambient') },
    ],
  };
};
