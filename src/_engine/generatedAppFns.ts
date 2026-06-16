// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!
// ALSO, DO NOT MODIFY THE 'generatedAppData.json' FILE)!
import * as testTslMatFn from '../app/materials/testTslMat.tsl.ts';
import * as checkerBoardFn from '../toolkit/materials/checkerBoard.tsl.ts';
import { type SceneData } from './core/Scene.ts';
import { type ScenePrimitiveAssets } from './core/SceneLoader.ts';

export const sceneFileObjects: {
  [sceneId: string]: (sceneData: {
    sceneData: SceneData;
    assets: ScenePrimitiveAssets;
  }) => Promise<void>;
} = {
  testDebugScene: async ({ sceneData, assets }) => {
    const module = await import('../app/debugScene.scene.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  oneMoreScene: async ({ sceneData, assets }) => {
    const module = await import('../app/./oneMoreScene');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  sceneTestECS: async ({ sceneData, assets }) => {
    const module = await import('../app/./testECS.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
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
