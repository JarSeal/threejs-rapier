export { LEGACY_SKYBOX_WARNING, isLegacySkyBoxProps } from '../../core/SkyBox/legacySkyBox';
export type { LegacySkyBoxProps } from '../../core/SkyBox/legacySkyBox';
export { mergeSkyBoxPreset } from '../../core/SkyBox/presets';
export {
  bakeEnvironment,
  createSkyBox,
  getDayNightSpeed,
  getMoonDirection,
  getMoonPhase,
  getSunDirection,
  getSunElevation,
  getTimeOfDay,
  isDayNightPlaying,
  onSkyBoxChange,
  pauseDayNight,
  playDayNight,
  setActiveSkyBox,
  setDayNightCycleDuration,
  setDayNightSpeed,
  setTimeOfDay,
  updateSkyBox,
} from '../../core/SkyBox/SkyBox';
export type { SkyBoxChangeListener, SkyBoxUpdate } from '../../core/SkyBox/SkyBox';
export type { SkyBoxDef } from '../../core/SkyBox/SkyBoxTypes';
export { getSkyLightIds } from '../../core/SkyBox/SkyLights';
