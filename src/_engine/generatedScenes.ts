// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!
import { type SceneData } from './core/Scene.ts';
import { scene as oneMoreSceneFn } from '../app/./oneMoreScene';
import { scene as sceneTestECSFn } from '../app/./testECS.ts';

export const sceneFileObjects: { [sceneId: string]: (sceneData: SceneData) => void } = {
  oneMoreScene: oneMoreSceneFn,
  sceneTestECS: sceneTestECSFn,
};
