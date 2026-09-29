import type { DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { LAYER_PATHS, setSkyBoxParam, type SkyBoxLayerKey } from './_dbg__SkyBoxShared';

/** Turns a camelCase key into the undo history's label, eg. 'mieCoefficient' → 'mie coefficient'. */
const toUndoLabel = (key: string) => key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);

/** A number slider for one layer value (stored, rendered and undoable via setSkyBoxParam). */
export const numberParam = (
  target: object,
  layer: SkyBoxLayerKey,
  key: string,
  label: string,
  opts: { min: number; max: number; step: number; disabled?: () => boolean }
): DebuggerPaneItem => ({
  key,
  target,
  label,
  min: opts.min,
  max: opts.max,
  step: opts.step,
  ...(opts.disabled ? { disabled: opts.disabled } : {}),
  onChange: (value, e) =>
    setSkyBoxParam(`${LAYER_PATHS[layer]}.${key}`, toUndoLabel(key), Number(value), e),
});

/**
 * An 'AUTO' | colour value: a mode list, and a colour picker shown for CUSTOM. The proxy holds
 * `${key}Mode` and the picker's colour `${key}` (see syncSkyBoxProxy).
 */
export const buildAutoColorItems = (
  target: Record<string, unknown>,
  layer: SkyBoxLayerKey,
  key: string,
  label: string,
  disabled: () => boolean
): DebuggerPaneItem[] => {
  const path = `${LAYER_PATHS[layer]}.${key}`;
  return [
    {
      key: `${key}Mode`,
      target,
      label,
      options: [
        { text: 'Auto', value: 'AUTO' },
        { text: 'Custom', value: 'CUSTOM' },
      ],
      disabled,
      onChange: (value, e) =>
        setSkyBoxParam(path, toUndoLabel(key), value === 'AUTO' ? 'AUTO' : target[key], {
          prev: e.prev === 'AUTO' ? 'AUTO' : target[key],
        }),
    },
    {
      key,
      target,
      label: `${label} (custom)`,
      hidden: () => target[`${key}Mode`] !== 'CUSTOM',
      disabled,
      onChange: (value, e) => setSkyBoxParam(path, toUndoLabel(key), value, e),
    },
  ];
};
