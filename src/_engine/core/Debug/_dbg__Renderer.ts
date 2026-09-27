import * as THREE from 'three/webgpu';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { RendererOptions } from '../Renderer';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { type ListBladeApi, type Pane } from 'tweakpane';
import type { BladeController, View } from '@tweakpane/core';
import { RENDERER_SHADOW_OPTIONS } from '../../utils/constants';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';

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

/** The currently built pane (null until the tab is first opened, stale once it's closed). */
let rendererGUI: {
  pane: Pane;
  toneMapping: ListBladeApi<THREE.ToneMapping>;
  outputColorSpace: ListBladeApi<THREE.ColorSpace>;
} | null = null;
/** True while undo/redo pushes a value into the GUI, so the change listeners don't record it. */
let isApplyingUndoRedo = false;

export const _createRendererDebugGUI = async (
  options: RendererOptions,
  r: THREE.WebGPURenderer | null,
  LS_KEY: string
) => {
  const savedOptions = lsGetItem(LS_KEY, options);
  options = { ...options, ...savedOptions };

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

  const refreshGUI = () => {
    if (!rendererGUI?.pane.element.isConnected) return;
    isApplyingUndoRedo = true;
    try {
      rendererGUI.toneMapping.value = options.toneMapping;
      rendererGUI.outputColorSpace.value = options.outputColorSpace;
      rendererGUI.pane.refresh();
    } finally {
      isApplyingUndoRedo = false;
    }
  };

  const setOption = <K extends UndoableOption>(key: K, value: RendererOptions[K]) => {
    options[key] = value;
    applyToRenderer[key]();
    lsSetItem(LS_KEY, options);
    refreshGUI();
  };

  const recordChange = <K extends UndoableOption>(
    key: K,
    prev: RendererOptions[K],
    next: RendererOptions[K]
  ) => {
    _recordUndoRedoAction<UndoablePayload<K>>(`renderer.${key}`, UNDOABLE_OPTION_LABELS[key], {
      prev,
      next,
    });
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

  const icon = getSvgIcon('gpuCard');
  createDebuggerTab({
    id: 'rendererControls',
    buttonText: icon,
    title: 'Renderer controls',
    orderNr: 7,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY),
        onClear: () => lsRemoveItem(LS_KEY),
        watchKey: LS_KEY,
      });
      const { container, debugGUI } = createNewDebuggerPane(
        'renderer',
        `${icon} Renderer Controls`,
        [clearTabBtn]
      );

      // Antialias
      debugGUI
        .addBinding(options, 'antialias', { label: 'Antialias (reloads)' })
        .on('change', () => {
          lsSetItem(LS_KEY, options);
          location.reload();
        });
      // Force WebGL
      debugGUI
        .addBinding(options, 'forceWebGL', { label: 'Force WebGL (reloads)' })
        .on('change', () => {
          lsSetItem(LS_KEY, options);
          location.reload();
        });
      // Device pixel ratio
      debugGUI
        .addBinding(options, 'devicePixelRatio', {
          label: `Device pixel ratio (${window?.devicePixelRatio})`,
          step: 0.5,
          min: 1,
          max: 4,
        })
        .on('change', () => {
          r?.setPixelRatio(options.devicePixelRatio);
          lsSetItem(LS_KEY, options);
        });
      // Tone mapping
      const toneMappingDropDown = debugGUI.addBlade({
        view: 'list',
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
        value: options.toneMapping,
      }) as ListBladeApi<THREE.ToneMapping>;
      toneMappingDropDown.on('change', (e) => {
        if (isApplyingUndoRedo) return;
        const prev = options.toneMapping;
        options.toneMapping = Number(e.value) as THREE.ToneMapping;
        applyToRenderer.toneMapping();
        lsSetItem(LS_KEY, options);
        recordChange('toneMapping', prev, options.toneMapping);
      });
      // Tone mapping exposure
      debugGUI
        .addBinding(options, 'toneMappingExposure', {
          label: 'Tone mapping exposure',
          step: 0.005,
          min: 0,
          max: 50,
        })
        .on('change', () => {
          if (r) r.toneMappingExposure = options.toneMappingExposure;
          lsSetItem(LS_KEY, options);
        });
      // Output color space
      const outputColorSpaceDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Output color space',
        options: [
          { value: THREE.NoColorSpace, text: 'No color space' },
          { value: THREE.SRGBColorSpace, text: 'SRGB' },
          { value: THREE.LinearSRGBColorSpace, text: 'Linear SRGB' },
        ],
        value: options.outputColorSpace,
      }) as ListBladeApi<THREE.ColorSpace>;
      outputColorSpaceDropDown.on('change', (e) => {
        if (isApplyingUndoRedo) return;
        const prev = options.outputColorSpace;
        options.outputColorSpace = String(e.value) as THREE.ColorSpace;
        applyToRenderer.outputColorSpace();
        lsSetItem(LS_KEY, options);
        recordChange('outputColorSpace', prev, options.outputColorSpace);
      });
      // Enable alpha (the binding has already written the new value into options)
      debugGUI.addBinding(options, 'alpha', { label: 'Enable alpha' }).on('change', (e) => {
        if (isApplyingUndoRedo) return;
        applyToRenderer.alpha();
        lsSetItem(LS_KEY, options);
        recordChange('alpha', !e.value, e.value);
      });
      // Enable shadows
      debugGUI
        .addBinding(options, 'enableShadows', { label: 'Enable shadows' })
        .on('change', (e) => {
          if (isApplyingUndoRedo) return;
          applyToRenderer.enableShadows();
          lsSetItem(LS_KEY, options);
          recordChange('enableShadows', !e.value, e.value);
        });
      // Shadow map type
      const shadowMapTypeDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Shadow map type (reloads)',
        options: RENDERER_SHADOW_OPTIONS,
        value: options.shadowMapType,
      }) as ListBladeApi<BladeController<View>>;
      shadowMapTypeDropDown.on('change', (e) => {
        const value = Number(e.value);
        options.shadowMapType = value as THREE.ShadowMapType;
        if (r) r.shadowMap.type = options.shadowMapType;
        lsSetItem(LS_KEY, options);
        location.reload();
      });

      rendererGUI = {
        pane: debugGUI,
        toneMapping: toneMappingDropDown,
        outputColorSpace: outputColorSpaceDropDown,
      };

      return container;
    },
  });
};
