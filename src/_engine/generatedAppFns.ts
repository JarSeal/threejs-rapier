// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY (ALSO, DO NOT MODIFY THE 'generatedAppFns.ts' FILE)!
import { material as testTslMatFn } from '../app/materials/testTslMat.tsl.ts';
import { material as checkerBoardFn } from '../toolkit/materials/checkerBoard.tsl.ts';
import { type SceneData } from './core/Scene.ts';
import { scene as testDebugSceneFn } from '../app/debugScene.scene.ts';
import { scene as oneMoreSceneFn } from '../app/./oneMoreScene';
import { scene as sceneTestECSFn } from '../app/./testECS.ts';

export const sceneFileObjects: { [sceneId: string]: (sceneData: SceneData) => Promise<void> } = {
  testDebugScene: testDebugSceneFn,
  oneMoreScene: oneMoreSceneFn,
  sceneTestECS: sceneTestECSFn,
};

export const tslMaterialFileObjects = {
  testTslMat: testTslMatFn,
  checkerBoard: checkerBoardFn,
};
