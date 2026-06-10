// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!
// ALSO, DO NOT MODIFY THE 'generatedAppData.json' FILE)!
import * as testTslMatFn from '../app/materials/testTslMat.tsl.ts';
import * as checkerBoardFn from '../toolkit/materials/checkerBoard.tsl.ts';
import { type SceneData } from './core/Scene.ts';

export const sceneFileObjects: { [sceneId: string]: (sceneData: SceneData) => Promise<void> } = {
  testDebugScene: async (sceneData) => {
    const module = await import('../app/debugScene.scene.ts');
    await (module as { scene: (sceneData: SceneData) => Promise<void> }).scene(sceneData);
  },
  oneMoreScene: async (sceneData) => {
    const module = await import('../app/./oneMoreScene');
    await (module as { scene: (sceneData: SceneData) => Promise<void> }).scene(sceneData);
  },
  sceneTestECS: async (sceneData) => {
    const module = await import('../app/./testECS.ts');
    await (module as { scene: (sceneData: SceneData) => Promise<void> }).scene(sceneData);
  },
};

export const tslMaterialFileObjects = {
  testTslMat: {
    colorNode: testTslMatFn.colorNode,
  },
  checkerBoard: {
    colorNode: checkerBoardFn.colorNode,
    roughnessNode: checkerBoardFn.roughnessNode,
    normalNode: checkerBoardFn.normalNode,
  },
};
