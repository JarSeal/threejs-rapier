import { createKeyBinding } from '../../../_engine/core/Input/KeyboardInput';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import { createSceneMainLooper } from '../../../_engine/core/Scene';
import {
  getDayNightSpeed,
  getTimeOfDay,
  isDayNightPlaying,
  pauseDayNight,
  playDayNight,
  setDayNightSpeed,
  setTimeOfDay,
} from '../../../_engine/core/SkyBox/SkyBox';
import { createExampleHud } from '../exampleHud';

const SCENE_ID = 'exampleSkyBox';

// #region sky-objects (shown in the Hub: hub/pages/examples/sky-box/)
export const scene = async () => {
  // No lights here: the sky box's sun and moon light the scene. A ground, a mirror ball, a matte
  // ball and a pillar to cast a long shadow at dusk.
  createMeshEntity({
    geo: { id: 'skyGround', type: 'BOX', params: { width: 40, height: 0.2, depth: 40 } },
    mat: { id: 'skyGround', type: 'STANDARD', params: { color: '#6b6f66', roughness: 0.9 } },
    position: { y: -0.1 },
    receiveShadow: true,
  });
  const balls = [
    { id: 'skyMirrorBall', x: -1.5, metalness: 1, roughness: 0.05 },
    { id: 'skyMatteBall', x: 1.5, metalness: 0, roughness: 0.6 },
  ];
  for (const { id, x, metalness, roughness } of balls) {
    createMeshEntity({
      geo: { id: 'skyBall', type: 'SPHERE', params: { radius: 1, widthSegments: 48 } },
      mat: { id, type: 'STANDARD', params: { color: '#e8e4dc', metalness, roughness } },
      position: { x, y: 1 },
      castShadow: true,
      receiveShadow: true,
    });
  }
  createMeshEntity({
    geo: { id: 'skyPillar', type: 'CYLINDER', params: { radiusTop: 0.3, height: 5 } },
    mat: { id: 'skyPillar', type: 'STANDARD', params: { color: '#9a938a', roughness: 0.85 } },
    position: { x: -4, y: 2.5, z: -3 },
    castShadow: true,
    receiveShadow: true,
  });

  createDayNightControls();
};
// #endregion sky-objects

// #region sky-controls (shown in the Hub: hub/pages/examples/sky-box/)
/** Keys for the running day (setTimeOfDay wraps the hours), and a HUD line that shows it */
const createDayNightControls = () => {
  const keys: [string, string, () => void][] = [
    [' ', 'Play or pause the day', () => (isDayNightPlaying() ? pauseDayNight() : playDayNight())],
    ['ArrowLeft', 'An hour back', () => setTimeOfDay((getTimeOfDay() ?? 0) - 1)],
    ['ArrowRight', 'An hour on', () => setTimeOfDay((getTimeOfDay() ?? 0) + 1)],
    ['ArrowUp', 'Faster', () => setDayNightSpeed(Math.min((getDayNightSpeed() ?? 1) * 2, 64))],
    [
      'ArrowDown',
      'Slower',
      () => setDayNightSpeed(Math.max((getDayNightSpeed() ?? 1) / 2, 1 / 16)),
    ],
  ];
  for (const [key, name, fn] of keys) {
    createKeyBinding({
      id: `exampleSkyBox${key}`,
      name,
      chord: { key },
      type: 'KEY_DOWN',
      sceneId: SCENE_ID,
      fn,
    });
  }

  // The time, read every frame, written to the HUD when it changes
  const hud = createExampleHud('');
  let shown = '';
  createSceneMainLooper(() => {
    const minutes = Math.floor((getTimeOfDay() ?? 0) * 60);
    const time = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
    const state = isDayNightPlaying() ? `playing ×${getDayNightSpeed()}` : 'paused';
    const text = `${time} (${state})\nSpace: play / pause · ← →: an hour · ↑ ↓: speed`;
    if (text !== shown) hud.updateText((shown = text));
  }, SCENE_ID);
};
// #endregion sky-controls
