// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!
// ALSO, DO NOT MODIFY THE 'generatedAppData.json' FILE)!
import * as checkerBoardFn from '../toolkit/materials/checkerBoard.tsl.ts';
import { type SceneData } from './core/Scene.ts';
import { scene as oneMoreSceneFn } from '../app/./oneMoreScene';
import { scene as sceneTestECSFn } from '../app/./testECS.ts';

export const sceneFileObjects: { [sceneId: string]: (sceneData: SceneData) => Promise<void> } = {
  oneMoreScene: oneMoreSceneFn,
  sceneTestECS: sceneTestECSFn,
};

export const tslMaterialFileObjects = {
  checkerBoard: {
    colorNode: checkerBoardFn.colorNode,
    roughnessNode: checkerBoardFn.roughnessNode,
    normalNode: checkerBoardFn.normalNode,
  },
};
