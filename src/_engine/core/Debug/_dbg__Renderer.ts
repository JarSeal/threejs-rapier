import * as THREE from 'three/webgpu';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { RendererOptions } from '../Renderer';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { type ListBladeApi } from 'tweakpane';
import type { BladeController, View } from '@tweakpane/core';
import { RENDERER_SHADOW_OPTIONS } from '../../utils/constants';

export const _createRendererDebugGUI = async (
  options: RendererOptions,
  r: THREE.WebGPURenderer | null,
  LS_KEY: string
) => {
  const savedOptions = lsGetItem(LS_KEY, options);
  options = { ...options, ...savedOptions };

  const icon = getSvgIcon('gpuCard');
  createDebuggerTab({
    id: 'rendererControls',
    buttonText: icon,
    title: 'Renderer controls',
    orderNr: 7,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane(
        'renderer',
        `${icon} Renderer Controls`
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
      }) as ListBladeApi<BladeController<View>>;
      toneMappingDropDown.on('change', (e) => {
        const value = Number(e.value);
        options.toneMapping = value as THREE.ToneMapping;
        if (r) r.toneMapping = options.toneMapping;
        lsSetItem(LS_KEY, options);
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
      }) as ListBladeApi<BladeController<View>>;
      outputColorSpaceDropDown.on('change', (e) => {
        const value = String(e.value);
        options.outputColorSpace = value as THREE.ColorSpace;
        if (r) r.outputColorSpace = options.outputColorSpace;
        lsSetItem(LS_KEY, options);
      });
      // Enable alpha
      debugGUI.addBinding(options, 'alpha', { label: 'Enable alpha' }).on('change', () => {
        if (r) r.alpha = Boolean(options.alpha);
        lsSetItem(LS_KEY, options);
      });
      // Enable shadows
      debugGUI
        .addBinding(options, 'enableShadows', { label: 'Enable shadows' })
        .on('change', () => {
          if (r) r.shadowMap.enabled = Boolean(options.enableShadows);
          lsSetItem(LS_KEY, options);
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

      return container;
    },
  });
};
