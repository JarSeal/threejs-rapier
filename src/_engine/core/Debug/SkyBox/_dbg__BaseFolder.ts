import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import type { SkyBoxBaseType } from '../../SkyBox/SkyBoxTypes';
import { resetSkyBoxLayer, setSkyBoxParam, skyBoxProxy } from './_dbg__SkyBoxShared';

const baseType = () => getActiveSkyBox()?.def.base.type;
const isNot =
  (...types: SkyBoxBaseType[]) =>
  () => {
    const type = baseType();
    return !type || !types.includes(type);
  };

/** The active sky box's base layer: what it shows (read-only) and its rotate, flipY, intensity
 * (or colour). */
export const buildBaseFolder = (): DebuggerPaneItem => {
  const target = skyBoxProxy.base;
  return {
    type: 'folder',
    id: 'base',
    title: 'Base',
    hidden: () => !getActiveSkyBox(),
    content: [
      { key: 'type', target, label: 'Type', readonly: true, interval: 0 },
      {
        key: 'color',
        target,
        label: 'Color',
        hidden: isNot('COLOR'),
        onChange: (value, e) => setSkyBoxParam('base.color', 'color', value, e),
      },
      {
        key: 'file',
        target,
        label: 'File',
        readonly: true,
        interval: 0,
        hidden: isNot('EQUIRECTANGULAR'),
      },
      {
        key: 'fileNames',
        target,
        label: 'Files',
        readonly: true,
        multiline: true,
        rows: 6,
        interval: 0,
        hidden: isNot('CUBE_TEXTURE'),
      },
      {
        key: 'path',
        target,
        label: 'Path',
        readonly: true,
        interval: 0,
        hidden: isNot('EQUIRECTANGULAR', 'CUBE_TEXTURE'),
      },
      {
        key: 'textureId',
        target,
        label: 'Texture id',
        readonly: true,
        interval: 0,
        hidden: isNot('EQUIRECTANGULAR', 'CUBE_TEXTURE'),
      },
      {
        key: 'colorSpace',
        target,
        label: 'Color space',
        readonly: true,
        interval: 0,
        hidden: isNot('EQUIRECTANGULAR', 'CUBE_TEXTURE'),
      },
      {
        key: 'rotate',
        target,
        label: 'Rotate (rad)',
        min: -Math.PI,
        max: Math.PI,
        step: 0.001,
        hidden: isNot('EQUIRECTANGULAR', 'CUBE_TEXTURE'),
        onChange: (value, e) => setSkyBoxParam('base.rotate', 'rotate', Number(value), e),
      },
      {
        key: 'flipY',
        target,
        label: 'Flip Y (upside down)',
        hidden: isNot('CUBE_TEXTURE'),
        onChange: (value, e) => setSkyBoxParam('base.flipY', 'flip Y', Boolean(value), e),
      },
      {
        key: 'intensity',
        target,
        label: 'Intensity',
        min: 0,
        max: 5,
        step: 0.01,
        hidden: isNot('EQUIRECTANGULAR', 'CUBE_TEXTURE'),
        onChange: (value, e) => setSkyBoxParam('base.intensity', 'intensity', Number(value), e),
      },
      { type: 'button', title: 'Reset layer', onClick: () => resetSkyBoxLayer('base') },
    ],
  };
};
