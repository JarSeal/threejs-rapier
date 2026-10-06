/**
 * The material editor's settings per material
 * (docs/plans/p085_material-editor-params-and-persistence.md DD3): the stage (background,
 * environment, light intensities) and the preview (auto-rotation), their defaults, checking a
 * saved value, and the Settings tab's pane items.
 *
 * The camera's fov is not a setting: it is part of the camera pose (the record's `camera`), so
 * "Reset camera to default" resets it with the rest of the pose.
 */
import type { DebuggerPaneItem } from '../../../../debug/DebuggerGUI';

export type MaterialEditorEnvironment = 'STUDIO' | 'NONE';

export type MaterialEditorSettings = {
  backgroundColor: string;
  /** The studio environment (a PMREM of three's RoomEnvironment), or none. */
  environment: MaterialEditorEnvironment;
  /** `scene.environmentIntensity` of the stage. */
  environmentIntensity: number;
  keyLightIntensity: number;
  fillLightIntensity: number;
  hemiLightIntensity: number;
  autoRotate: boolean;
  /** Degrees per second (in the view's `update`, so the view's pause stops it). */
  autoRotateSpeed: number;
};

export type MaterialEditorSettingKey = keyof MaterialEditorSettings;

/** The settings of a material without saved ones (p084's stage constants). */
export const DEFAULT_MATERIAL_EDITOR_SETTINGS: Readonly<MaterialEditorSettings> = {
  backgroundColor: '#5a5a5a',
  environment: 'STUDIO',
  environmentIntensity: 1,
  keyLightIntensity: 2,
  fillLightIntensity: 0.6,
  hemiLightIntensity: 0.7,
  autoRotate: false,
  autoRotateSpeed: 30,
};

type SettingDef = {
  key: MaterialEditorSettingKey;
  folder: 'Stage' | 'Preview';
  label: string;
  kind: 'COLOR' | 'NUMBER' | 'BOOLEAN' | 'OPTIONS';
  min?: number;
  max?: number;
  step?: number;
  /** For 'OPTIONS': label → value. */
  options?: Record<string, string>;
};

const SETTING_FOLDERS: SettingDef['folder'][] = ['Stage', 'Preview'];

const SETTINGS: SettingDef[] = [
  { key: 'backgroundColor', folder: 'Stage', label: 'Background', kind: 'COLOR' },
  {
    key: 'environment',
    folder: 'Stage',
    label: 'Environment',
    kind: 'OPTIONS',
    options: { Studio: 'STUDIO', None: 'NONE' },
  },
  {
    key: 'environmentIntensity',
    folder: 'Stage',
    label: 'Env. intensity',
    kind: 'NUMBER',
    min: 0,
    max: 3,
    step: 0.01,
  },
  {
    key: 'keyLightIntensity',
    folder: 'Stage',
    label: 'Key light',
    kind: 'NUMBER',
    min: 0,
    max: 10,
    step: 0.01,
  },
  {
    key: 'fillLightIntensity',
    folder: 'Stage',
    label: 'Fill light',
    kind: 'NUMBER',
    min: 0,
    max: 10,
    step: 0.01,
  },
  {
    key: 'hemiLightIntensity',
    folder: 'Stage',
    label: 'Hemi light',
    kind: 'NUMBER',
    min: 0,
    max: 5,
    step: 0.01,
  },
  { key: 'autoRotate', folder: 'Preview', label: 'Auto-rotate', kind: 'BOOLEAN' },
  {
    key: 'autoRotateSpeed',
    folder: 'Preview',
    label: 'Speed (°/s)',
    kind: 'NUMBER',
    min: -360,
    max: 360,
    step: 1,
  },
];

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * Checks a setting value against its kind (eg. a value from LocalStorage).
 * @param key (string) a {@link MaterialEditorSettingKey}
 * @param value (unknown)
 * @returns (unknown) the value (a colour lower-cased), or undefined when the key or the value
 * isn't valid
 */
export const normalizeMaterialEditorSetting = (key: string, value: unknown) => {
  const def = SETTINGS.find((d) => d.key === key);
  if (!def) return undefined;
  switch (def.kind) {
    case 'COLOR':
      return typeof value === 'string' && HEX_COLOR_RE.test(value)
        ? value.toLowerCase()
        : undefined;
    case 'BOOLEAN':
      return typeof value === 'boolean' ? value : undefined;
    case 'OPTIONS':
      return typeof value === 'string' && Object.values(def.options!).includes(value)
        ? value
        : undefined;
    default:
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
};

/**
 * The Settings tab's Stage and Preview folders. Every binding binds to `target` (fill it with the
 * material's settings), and `onChange` gets each user change.
 * @param target (Record<string, unknown>) the binding target
 * @param onChange (function) called with the setting, its new value, and whether it is the last
 * change of a drag
 * @returns (DebuggerPaneItem[])
 */
export const getSettingsPaneItems = (
  target: Record<string, unknown>,
  onChange: (key: MaterialEditorSettingKey, value: unknown, last: boolean) => void
): DebuggerPaneItem[] =>
  SETTING_FOLDERS.map((folder) => ({
    type: 'folder',
    id: `settings/${folder}`,
    title: folder,
    content: SETTINGS.filter((def) => def.folder === folder).map((def) => ({
      key: def.key,
      target,
      label: def.label,
      ...(def.kind === 'COLOR' ? { view: 'color' } : {}),
      ...(def.options ? { options: def.options } : {}),
      ...(def.min !== undefined ? { min: def.min } : {}),
      ...(def.max !== undefined ? { max: def.max } : {}),
      ...(def.step !== undefined ? { step: def.step } : {}),
      onChange: (value: unknown, e: { last: boolean }) => onChange(def.key, value, e.last),
    })),
  }));
