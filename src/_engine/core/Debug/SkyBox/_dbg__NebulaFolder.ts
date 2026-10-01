import * as THREE from 'three/webgpu';
import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import type { SkyBoxNebulaDef } from '../../SkyBox/SkyBoxTypes';
import {
  _setStaticLayersBakeHooks,
  getStaticLayers,
  getStaticLayersMemoryBytes,
  requestStaticLayersBake,
} from '../../SkyBox/SkyStaticLayers';
import { getActiveCamera } from '../../CameraManager';
import {
  isListOverrideAnArray,
  LAYER_PATHS,
  resetSkyBoxLayer,
  setSkyBoxParam,
  skyBoxProxy,
} from './_dbg__SkyBoxShared';
import { numberParam } from './_dbg__LayerFolderItems';
import { createBakeStats } from './_dbg__BakeStats';
import {
  buildListItems,
  buildResetListButton,
  hasNoEntries,
  offSuffix,
  type ListConfig,
} from './_dbg__ListFolderItems';

/**
 * The nebula creator (p114): the active sky box's nebulae list (select, add, duplicate, remove),
 * the selected nebula's params, and the nebula cube (its size, memory and bake stats). Params
 * are ordinary overrides with undo (`skybox.param`, coalesced by path, eg. `nebulae.1.warp`);
 * a list edit writes the whole array as one undo step.
 */

const stats = createBakeStats();
_setStaticLayersBakeHooks(stats.hooks);

/** Read-only bindings: the cube's memory. */
const info = {
  get memory() {
    const bake = getStaticLayers();
    return bake
      ? `${(getStaticLayersMemoryBytes(bake.resolution) / 1e6).toFixed(1)} MB (${bake.resolution}² × 6, HalfFloat)`
      : '-';
  },
};

const hasNone = () => hasNoEntries('nebulae');
const isOff = () => hasNone() || !skyBoxProxy.nebula.enabled;

const randomSeed = () => Math.floor(Math.random() * 100000);

const round = (value: number) => Math.round(value * 10000) / 10000;

const _forward = new THREE.Vector3();

/** The active camera's forward vector in the nebulae's frame (they turn with the sky). */
const getViewDirection = (): [number, number, number] | null => {
  const camera = getActiveCamera();
  const active = getActiveSkyBox();
  if (!camera || !active) return null;
  camera.getWorldDirection(_forward).applyMatrix3(active.uniforms.staticLayers.rotation.value);
  return [round(_forward.x), round(_forward.y), round(_forward.z)];
};

// List edits

const LIST: ListConfig<SkyBoxNebulaDef> = {
  list: 'nebulae',
  name: 'nebula',
  addTitle: 'Add (at view)',
  describe: (nebula, i) => `${i + 1}${offSuffix(nebula)}, seed ${nebula.seed ?? 0}`,
  create: () => {
    const entry: SkyBoxNebulaDef = { seed: randomSeed() };
    const direction = getViewDirection();
    if (direction) entry.direction = direction;
    return entry;
  },
  duplicate: (nebula) => ({ ...nebula, seed: randomSeed() }),
};

// Param items

const path = (key: string) => `${LAYER_PATHS.nebula}.${key}`;

const param = (key: string, label: string, min: number, max: number, step: number) =>
  numberParam(skyBoxProxy.nebula, 'nebula', key, label, { min, max, step, disabled: isOff });

const intParam = (key: string, label: string, min: number, max: number): DebuggerPaneItem => ({
  key,
  target: skyBoxProxy.nebula,
  label,
  min,
  max,
  step: 1,
  disabled: isOff,
  onChange: (value, e) => setSkyBoxParam(path(key), key, Math.round(Number(value)), e),
});

/** The direction from the proxy's elevation and azimuth (degrees; 0 = +z, 90 = +x). */
const toDirection = (elevationDeg: number, azimuthDeg: number): [number, number, number] => {
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  return [
    round(Math.cos(elevation) * Math.sin(azimuth)),
    round(Math.sin(elevation)),
    round(Math.cos(elevation) * Math.cos(azimuth)),
  ];
};

const directionItem = (key: 'elevation' | 'azimuth', label: string): DebuggerPaneItem => {
  const proxy = skyBoxProxy.nebula;
  const direction = (changed: number) =>
    key === 'elevation'
      ? toDirection(changed, Number(proxy.azimuth))
      : toDirection(Number(proxy.elevation), changed);
  return {
    key,
    target: proxy,
    label,
    min: key === 'elevation' ? -90 : 0,
    max: key === 'elevation' ? 90 : 360,
    step: 0.1,
    disabled: isOff,
    onChange: (value, e) =>
      setSkyBoxParam(path('direction'), 'direction', direction(Number(value)), {
        prev: direction(Number(e.prev)),
      }),
  };
};

/** The colours as the array the definition holds (2 or 3 stops). */
const colorsArray = (stops: number, override?: { index: number; value: unknown }) => {
  const proxy = skyBoxProxy.nebula;
  const colors = [proxy.color0, proxy.color1, proxy.color2].slice(0, stops);
  if (override) colors[override.index] = override.value;
  return colors;
};

const colorItems = (): DebuggerPaneItem[] => {
  const proxy = skyBoxProxy.nebula;
  const stops = () => Number(proxy.colorStops);
  return [
    {
      key: 'colorStops',
      target: proxy,
      label: 'Color stops',
      options: [
        { text: '2', value: 2 },
        { text: '3', value: 3 },
      ],
      disabled: isOff,
      onChange: (value, e) =>
        setSkyBoxParam(path('colors'), 'colors', colorsArray(Number(value)), {
          prev: colorsArray(Number(e.prev)),
        }),
    },
    ...(['Edge color', 'Middle (core with 2 stops)', 'Core color'] as const).map(
      (label, index): DebuggerPaneItem => ({
        key: `color${index}`,
        target: proxy,
        label,
        hidden: () => index === 2 && stops() === 2,
        disabled: isOff,
        onChange: (value, e) =>
          setSkyBoxParam(path('colors'), 'colors', colorsArray(stops(), { index, value }), {
            prev: colorsArray(stops(), { index, value: e.prev }),
          }),
      })
    ),
  ];
};

const buildCubeFolder = (): DebuggerPaneItem => ({
  type: 'folder',
  id: 'nebulaCube',
  title: 'Nebula cube',
  expanded: false,
  content: [
    {
      key: 'nebulaSize',
      target: skyBoxProxy.env,
      label: 'Face size',
      options: [256, 512, 1024].map((size) => ({ text: String(size), value: size })),
      onChange: (value, e) =>
        setSkyBoxParam('env.nebulaSize', 'nebula cube size', Number(value), e),
    },
    {
      type: 'button',
      title: 'Re-bake now',
      disabled: () => !getStaticLayers(),
      onClick: () => requestStaticLayersBake(),
    },
    { type: 'separator' },
    { key: 'memory', target: info, label: 'Memory', readonly: true, interval: 500 },
    { key: 'bakes', target: stats.view, label: 'Bakes', readonly: true, interval: 500 },
    {
      key: 'bakesPerSec',
      target: stats.view,
      label: 'Bakes/s (10 s)',
      readonly: true,
      interval: 500,
    },
    { key: 'cpuMs', target: stats.view, label: 'Bake CPU ms', readonly: true, interval: 500 },
    { key: 'gpuMs', target: stats.view, label: 'Bake GPU ms', readonly: true, interval: 500 },
  ],
});

/** The Nebulae folder (see the file comment). */
export const buildNebulaeFolder = (): DebuggerPaneItem => {
  const proxy = skyBoxProxy.nebula;
  return {
    type: 'folder',
    id: 'nebulae',
    title: 'Nebulae',
    hidden: () => !getActiveSkyBox(),
    content: [
      ...buildListItems(LIST),
      {
        type: 'folder',
        id: 'nebula',
        title: 'Selected nebula',
        hidden: hasNone,
        content: [
          {
            key: 'enabled',
            target: proxy,
            label: 'Enabled',
            onChange: (value, e) =>
              setSkyBoxParam(path('enabled'), 'nebula enabled', Boolean(value), e),
          },
          intParam('seed', 'Seed', 0, 100000),
          {
            type: 'button',
            title: 'Randomize seed',
            disabled: isOff,
            onClick: () => setSkyBoxParam(path('seed'), 'seed', randomSeed(), { prev: proxy.seed }),
          },
          directionItem('elevation', 'Elevation (deg)'),
          directionItem('azimuth', 'Azimuth (deg)'),
          {
            type: 'button',
            title: 'Point at view',
            disabled: isOff,
            onClick: () => {
              const direction = getViewDirection();
              if (!direction) return;
              const prev = toDirection(Number(proxy.elevation), Number(proxy.azimuth));
              setSkyBoxParam(path('direction'), 'direction', direction, { prev });
            },
          },
          param('size', 'Size (deg)', 1, 180, 0.1),
          param('falloff', 'Falloff', 0, 1, 0.001),
          param('stretch', 'Stretch', 1, 10, 0.01),
          param('orientation', 'Orientation (deg)', -180, 180, 0.1),
          ...colorItems(),
          param('density', 'Density', 0, 1, 0.001),
          intParam('octaves', 'Octaves (rebuild)', 2, 6),
          param('warp', 'Warp', 0, 2, 0.001),
          param('dust', 'Dust', 0, 1, 0.001),
          param('brightness', 'Brightness', 0, 20, 0.01),
          param('starBoost', 'Star boost', 0, 1, 0.001),
          {
            type: 'button',
            title: 'Reset nebula',
            disabled: () => isListOverrideAnArray('nebulae'),
            onClick: () => resetSkyBoxLayer('nebula'),
          },
        ],
      },
      buildResetListButton(LIST),
      buildCubeFolder(),
    ],
  };
};
