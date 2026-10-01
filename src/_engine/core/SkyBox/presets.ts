// Sky box presets (p114), template version 1 (engine 3.x). A change to a template changes the
// look of every sky box built on it: note it in the changelog as a visual change.
//
// Only types and deepMerge here: the data pipeline (devTools/gatherAppData.ts, run in Node) and
// the schema use this module. JSON presets are resolved at build time, so the runtime bundle has
// this module only when code references it (resolveSkyBoxPreset, or the debugger).
import { deepMerge } from '../../utils/deepMerge';
import type { SkyBoxBaseDef, SkyBoxDef } from './SkyBoxTypes';

export const SKYBOX_PRESET_NAMES = ['DAY_SKY', 'NIGHT_SKY', 'DAY_NIGHT', 'SPACE'] as const;

export type SkyBoxPresetName = (typeof SKYBOX_PRESET_NAMES)[number];

/** A preset template: a definition's layers, without its id and meta. */
export type SkyBoxPreset = Omit<
  SkyBoxDef,
  'id' | 'isDefault' | 'debugData' | 'sceneId' | '$schema' | '__sourcePath' | '__saveData'
>;

/** A definition that starts from a preset: any layer it gives wins over the preset's. */
export type SkyBoxPresetDef = Omit<SkyBoxDef, 'base'> & {
  preset: SkyBoxPresetName;
  /** Default: the preset's. */
  base?: SkyBoxBaseDef;
};

const BLACK_BASE: SkyBoxBaseDef = { type: 'COLOR', color: '#000000' };

export const SKYBOX_PRESETS: Record<SkyBoxPresetName, SkyBoxPreset> = {
  /** A clear afternoon: atmosphere, a sun with a shadow-casting light, light clouds and ground. */
  DAY_SKY: {
    base: BLACK_BASE,
    atmosphere: {},
    suns: [{ elevation: 45, azimuth: 160, glowIntensity: 0.4, light: {} }],
    clouds: { coverage: 0.35 },
    ground: {},
  },
  /** A moonlit night: the sun well below the horizon, a moon with a shadow-casting light,
   * stars with the Milky Way, thin clouds and ground. */
  NIGHT_SKY: {
    base: BLACK_BASE,
    atmosphere: { nightSkyColor: '#0a1020' },
    // No light: it would be faded out down there, but still render its shadow map
    suns: [{ elevation: -25, azimuth: 20 }],
    moons: [
      { elevation: 40, azimuth: 200, phase: 0.45, light: { intensity: 0.5, castShadow: true } },
    ],
    stars: { milkyWay: {} },
    clouds: { coverage: 0.2 },
    ground: {},
  },
  /** Every p113 layer on a running day-night cycle (the showcase's dayNight.skybox.json). */
  DAY_NIGHT: {
    base: BLACK_BASE,
    atmosphere: { nightSkyColor: '#0a1020' },
    suns: [{ glowIntensity: 0.4, light: {} }],
    moons: [{ phase: 0.4, phaseMode: 'CYCLE', light: { intensity: 0.5 } }],
    stars: { milkyWay: {} },
    clouds: { coverage: 0.35 },
    ground: {},
    dayNight: {},
  },
  /** Deep space: dense stars that never fade (no atmosphere, so no day), one sun with a light
   * and a large glow, two nebulae, and an environment baked once. */
  SPACE: {
    base: { type: 'COLOR', color: '#000005' },
    env: { dynamic: false, size: 256 },
    suns: [
      {
        elevation: 20,
        azimuth: 135,
        discSize: 2,
        glowIntensity: 1.2,
        glowSize: 12,
        light: {},
      },
    ],
    stars: {
      density: 0.8,
      brightness: 1.2,
      // Without an atmosphere the sun's elevation means nothing: always full
      fadeRange: [90, 90],
      milkyWay: { intensity: 0.1 },
    },
    nebulae: [
      {
        seed: 7,
        direction: [-0.6, 0.25, -0.75],
        size: 35,
        stretch: 1.8,
        orientation: 30,
        density: 0.55,
        warp: 0.8,
        dust: 0.45,
        brightness: 1.2,
        starBoost: 0.5,
      },
      {
        seed: 23,
        direction: [0.7, -0.1, 0.6],
        size: 28,
        stretch: 1.3,
        orientation: -50,
        colors: ['#08203a', '#1f7a8c', '#bdf2e6'],
        density: 0.45,
        warp: 0.6,
        dust: 0.3,
        brightness: 0.9,
        starBoost: 0.3,
      },
    ],
  },
};

export const isSkyBoxPresetName = (name: unknown): name is SkyBoxPresetName =>
  SKYBOX_PRESET_NAMES.includes(name as SkyBoxPresetName);

/**
 * A definition with its preset (if any) under it, and the `preset` key dropped: the plain
 * definition the runtime takes. The definition's layers are merged over the preset's key by key;
 * its arrays (suns, moons, nebulae, colours) and its base replace the preset's. Untyped by the
 * definition (the schema, which the definition's type comes from, uses it): code uses
 * resolveSkyBoxPreset.
 */
export const mergeSkyBoxPreset = <T extends { preset?: string; base?: unknown }>(
  def: T
): Omit<T, 'preset'> => {
  const { preset, ...rest } = def;
  if (preset === undefined) return rest;
  if (!isSkyBoxPresetName(preset)) {
    throw new Error(
      `Unknown sky box preset "${preset}" (one of: ${SKYBOX_PRESET_NAMES.join(', ')}).`
    );
  }
  // A copy: the result must never share the template's arrays
  const merged = deepMerge(structuredClone(SKYBOX_PRESETS[preset]), rest) as Record<
    string,
    unknown
  >;
  if (rest.base) merged.base = rest.base;
  return merged as Omit<T, 'preset'>;
};

/**
 * A definition made in code, with its preset merged under it (see mergeSkyBoxPreset), for
 * createSkyBox / registerSkyBox: eg. `createSkyBox(resolveSkyBoxPreset({ id: 'space', preset:
 * 'SPACE' }))`. JSON sky boxes are resolved at build time.
 */
export const resolveSkyBoxPreset = (def: SkyBoxPresetDef | SkyBoxDef): SkyBoxDef =>
  mergeSkyBoxPreset(def as SkyBoxPresetDef) as SkyBoxDef;
