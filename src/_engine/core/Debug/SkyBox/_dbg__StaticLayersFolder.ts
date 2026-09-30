import * as THREE from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  float,
  fract,
  max,
  mix,
  mx_fractal_noise_float as fractalNoise,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { _setStaticLayersTest, getActiveSkyBox } from '../../SkyBox/SkyBox';
import {
  _setStaticLayersBakeHooks,
  getStaticLayers,
  getStaticLayersMemoryBytes,
  requestStaticLayersBake,
  STATIC_LAYERS_DEFAULT_RESOLUTION,
  type StaticLayersResolution,
  type StaticLayersSource,
} from '../../SkyBox/SkyStaticLayers';
import { createBakeStats } from './_dbg__BakeStats';

/**
 * The static layers' test harness (p114 Phase 1, replaced by the nebulae in Phase 2): a
 * hard-coded test layer baked into the static-layers cube, to check the bake without any real
 * layer. Session only: never saved, never undoable.
 *
 * The layer is a faint coloured fbm field, a soft 15° latitude/longitude grid, and markers on
 * the axes (a disc on +X red, +Y green, +Z blue; a ring on the negative axes), so a flipped or
 * swapped face, a seam or a wrong rotation stands out. "View: Diff" shows |baked − live| × 10 in
 * place of the sky behind: it should be black but for faint filtering noise. The edges are kept
 * soft (3° and more) for that: a sharp edge's bilinear error, × 10, shows as a pair of thin
 * outlines around the feature (symmetric), while an orientation error shows as a displaced ghost.
 */

const stats = createBakeStats();
_setStaticLayersBakeHooks(stats.hooks);

const state = {
  enabled: false,
  view: 'BAKED' as NonNullable<StaticLayersSource['view']>,
  resolution: STATIC_LAYERS_DEFAULT_RESOLUTION as StaticLayersResolution,
  gain: 1,
};

/** Read-only bindings: the cube's resolution and memory. */
const info = {
  get memory() {
    const bake = getStaticLayers();
    return bake
      ? `${(getStaticLayersMemoryBytes(bake.resolution) / 1e6).toFixed(1)} MB (${bake.resolution}² × 6, HalfFloat)`
      : '-';
  },
};

/** A uniform of the bake source: dragging it requests throttled bakes. */
const gain = uniform(state.gain);

const DEG = Math.PI / 180;
const AXES: { axis: [number, number, number]; color: [number, number, number] }[] = [
  { axis: [1, 0, 0], color: [1, 0.1, 0.1] },
  { axis: [0, 1, 0], color: [0.1, 1, 0.1] },
  { axis: [0, 0, 1], color: [0.2, 0.4, 1] },
];
const GRID_STEP = 15 * DEG;

/** 1 on a soft line at every multiple of the step (v in steps). */
const softLine = (v: THREE.Node<'float'>) =>
  float(1).sub(smoothstep(0, 0.15, abs(fract(v.add(0.5)).sub(0.5))));

/** The test layer in direction `s` (the static layers' frame). */
const testLayer = (s: THREE.Node<'vec3'>): THREE.Node<'vec3'> => {
  // The float fbm: the vec3 one (mx_fractal_noise_vec3) hangs SwiftShader's WebGL2
  const noise = fractalNoise(s.mul(3), 4, 2, 0.5).mul(0.5).add(0.5).clamp(0, 1);
  const field = mix(vec3(0.1, 0.02, 0.15), vec3(0.02, 0.12, 0.12), noise).mul(noise);
  const latitude = asin(s.y.clamp(-1, 1));
  const longitude = atan(s.x, s.z);
  const grid = max(softLine(latitude.div(GRID_STEP)), softLine(longitude.div(GRID_STEP))).mul(0.15);
  let color = field.add(vec3(grid));
  for (const { axis, color: rgb } of AXES) {
    const toward = s.dot(vec3(...axis));
    const disc = smoothstep(Math.cos(10 * DEG), Math.cos(4 * DEG), toward);
    const away = toward.negate();
    const ring = smoothstep(Math.cos(16 * DEG), Math.cos(13 * DEG), away).mul(
      float(1).sub(smoothstep(Math.cos(11 * DEG), Math.cos(8 * DEG), away))
    );
    color = color.add(vec3(...rgb).mul(disc.add(ring)));
  }
  return color.mul(gain);
};

const apply = () =>
  _setStaticLayersTest(
    state.enabled ? { resolution: state.resolution, view: state.view, build: testLayer } : null
  );

const isOff = () => !state.enabled;

/** @internal Sets the test harness's state from code (eg. a browser test script), as the
 * folder's controls do, and refreshes the tab. */
export const _setStaticLayersTestState = (next: Partial<typeof state>) => {
  const prevGain = state.gain;
  Object.assign(state, next);
  gain.value = state.gain;
  if (Object.keys(next).some((key) => key !== 'gain')) apply();
  else if (state.gain !== prevGain) requestStaticLayersBake(true);
};

/** The static layers' test harness (see the file comment). */
export const buildStaticLayersFolder = (): DebuggerPaneItem => ({
  type: 'folder',
  id: 'staticLayers',
  title: 'Static layers (test)',
  expanded: false,
  hidden: () => !getActiveSkyBox(),
  content: [
    {
      key: 'enabled',
      target: state,
      label: 'Test layer',
      onChange: (value) => {
        state.enabled = Boolean(value);
        apply();
      },
    },
    {
      key: 'view',
      target: state,
      label: 'View',
      options: [
        { text: 'Baked', value: 'BAKED' },
        { text: 'Live', value: 'LIVE' },
        { text: 'Diff (×10)', value: 'DIFF' },
      ],
      disabled: isOff,
      onChange: () => apply(),
    },
    {
      key: 'resolution',
      target: state,
      label: 'Resolution',
      options: [256, 512, 1024].map((size) => ({ text: String(size), value: size })),
      disabled: isOff,
      onChange: () => apply(),
    },
    {
      key: 'gain',
      target: state,
      label: 'Drag test (gain)',
      min: 0,
      max: 4,
      step: 0.01,
      disabled: isOff,
      onChange: (value) => {
        gain.value = Number(value);
        requestStaticLayersBake(true);
      },
    },
    {
      type: 'button',
      title: 'Re-bake now',
      disabled: isOff,
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
    { key: 'cpuMs', target: stats.view, label: 'CPU ms', readonly: true, interval: 500 },
    { key: 'gpuMs', target: stats.view, label: 'GPU ms', readonly: true, interval: 500 },
  ],
});
