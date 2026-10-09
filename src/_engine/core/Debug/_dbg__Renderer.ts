import * as THREE from 'three/webgpu';
import {
  createDebuggerTab,
  persistDebuggerTabValue,
  updateDebuggerTab,
} from '../../debug/DebuggerGUI';
import type { RendererOptions } from '../Renderer';
import { RENDERER_SHADOW_OPTIONS } from '../../utils/constants';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';

const TAB_ID = 'rendererControls';

/** Renderer options whose changes are recorded to the (global) undo/redo history. */
type UndoableOption = 'toneMapping' | 'outputColorSpace' | 'alpha' | 'enableShadows';
type UndoablePayload<K extends UndoableOption> = {
  prev: RendererOptions[K];
  next: RendererOptions[K];
};

const UNDOABLE_OPTION_LABELS: Record<UndoableOption, string> = {
  toneMapping: 'Renderer: tone mapping',
  outputColorSpace: 'Renderer: output color space',
  alpha: 'Renderer: enable alpha',
  enableShadows: 'Renderer: enable shadows',
};

/**
 * Registers the Renderer tab. `options` is the renderer's own options object: Renderer.ts has
 * already applied the persisted values to it at boot (they are needed before the renderer is
 * created), so the tab's hydration here only re-applies the same values.
 */
export const _createRendererDebugGUI = async (
  options: RendererOptions,
  r: THREE.WebGPURenderer | null,
  LS_KEY: string
) => {
  const applyToRenderer: Record<UndoableOption, () => void> = {
    toneMapping: () => {
      if (r) r.toneMapping = options.toneMapping;
    },
    outputColorSpace: () => {
      if (r) r.outputColorSpace = options.outputColorSpace;
    },
    alpha: () => {
      if (r) r.alpha = Boolean(options.alpha);
    },
    enableShadows: () => {
      if (r) r.shadowMap.enabled = Boolean(options.enableShadows);
    },
  };

  const setOption = <K extends UndoableOption>(key: K, value: RendererOptions[K]) => {
    options[key] = value;
    applyToRenderer[key]();
    persistDebuggerTabValue(TAB_ID, key);
    updateDebuggerTab(TAB_ID);
  };

  const registerHandler = <K extends UndoableOption>(key: K) => {
    _registerUndoRedoActionHandler<UndoablePayload<K>>(
      `renderer.${key}`,
      {
        undo: ({ prev }) => setOption(key, prev),
        redo: ({ next }) => setOption(key, next),
      },
      'global'
    );
  };
  registerHandler('toneMapping');
  registerHandler('outputColorSpace');
  registerHandler('alpha');
  registerHandler('enableShadows');

  /** onChange of an undoable option: apply it and record the change. */
  const undoableChange =
    <K extends UndoableOption>(key: K) =>
    (value: unknown, e: { prev: unknown }) => {
      applyToRenderer[key]();
      _recordUndoRedoAction<UndoablePayload<K>>(`renderer.${key}`, UNDOABLE_OPTION_LABELS[key], {
        prev: e.prev as RendererOptions[K],
        next: value as RendererOptions[K],
      });
    };

  createDebuggerTab({
    id: TAB_ID,
    title: 'Renderer controls',
    icon: 'gpuCard',
    lsKey: LS_KEY,
    state: options,
    persistKeys: [
      'antialias',
      'forceWebGL',
      'devicePixelRatio',
      'toneMapping',
      'toneMappingExposure',
      'outputColorSpace',
      'alpha',
      'enableShadows',
      'shadowMapType',
    ],
    content: () => [
      {
        pane: true,
        content: [
          // The value is persisted before onChange, so a reload keeps it
          { key: 'antialias', label: 'Antialias (reloads)', onChange: () => location.reload() },
          { key: 'forceWebGL', label: 'Force WebGL (reloads)', onChange: () => location.reload() },
          {
            key: 'devicePixelRatio',
            label: `Device pixel ratio (${window?.devicePixelRatio})`,
            step: 0.5,
            min: 1,
            max: 4,
            onChange: () => r?.setPixelRatio(options.devicePixelRatio || 1),
          },
          {
            key: 'toneMapping',
            label: 'Tone mapping',
            options: [
              { value: THREE.NoToneMapping, text: 'No tone mapping' },
              { value: THREE.LinearToneMapping, text: 'Linear' },
              { value: THREE.ReinhardToneMapping, text: 'Reinhard' },
              { value: THREE.CineonToneMapping, text: 'Cineon' },
              { value: THREE.ACESFilmicToneMapping, text: 'ACES Filmic' },
              { value: THREE.CustomToneMapping, text: 'Custom' },
              { value: THREE.AgXToneMapping, text: 'AgX' },
              { value: THREE.NeutralToneMapping, text: 'Neutral' },
            ],
            onChange: undoableChange('toneMapping'),
          },
          {
            key: 'toneMappingExposure',
            label: 'Tone mapping exposure',
            step: 0.005,
            min: 0,
            max: 50,
            onChange: () => {
              if (r) r.toneMappingExposure = options.toneMappingExposure;
            },
          },
          {
            key: 'outputColorSpace',
            label: 'Output color space',
            options: [
              { value: THREE.NoColorSpace, text: 'No color space' },
              { value: THREE.SRGBColorSpace, text: 'SRGB' },
              { value: THREE.LinearSRGBColorSpace, text: 'Linear SRGB' },
            ],
            onChange: undoableChange('outputColorSpace'),
          },
          { key: 'alpha', label: 'Enable alpha', onChange: undoableChange('alpha') },
          {
            key: 'enableShadows',
            label: 'Enable shadows',
            onChange: undoableChange('enableShadows'),
          },
          {
            key: 'shadowMapType',
            label: 'Shadow map type (reloads)',
            options: RENDERER_SHADOW_OPTIONS,
            onChange: () => location.reload(),
          },
        ],
      },
    ],
  });
};
