// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!
// ALSO, DO NOT MODIFY THE 'generatedAppData.json' FILE)!
import * as testTslMatFn from '../app/materials/testTslMat.tsl.ts';
import * as asteroidFn from '../toolkit/materials/asteroid.tsl.ts';
import * as checkerBoardFn from '../toolkit/materials/checkerBoard.tsl.ts';
import * as triplanarCheckerboardFn from '../toolkit/materials/triplanarCheckerboard.tsl.ts';
import * as triplanarGridFn from '../toolkit/materials/triplanarGrid.tsl.ts';
import * as ambientOcclusionPostFxFn from '../app/postFx/ambientOcclusion.tsl.ts';
import { type SceneData } from './core/Scene.ts';
import { type ScenePrimitiveAssets } from './core/SceneLoader.ts';

export const sceneFileObjects: {
  [sceneId: string]: (sceneData: {
    sceneData: SceneData;
    assets: ScenePrimitiveAssets;
  }) => Promise<void>;
} = {
  assetCompare: async ({ sceneData, assets }) => {
    const module = await import('../app/./assetCompare.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  testDebugScene: async ({ sceneData, assets }) => {
    const module = await import('../app/debugScene.scene.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  largeWorld: async ({ sceneData, assets }) => {
    const module = await import('../app/./largeWorld.ts');
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
  physicsTest: async ({ sceneData, assets }) => {
    const module = await import('../app/./physicsTest.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  physicsTiers: async ({ sceneData, assets }) => {
    const module = await import('../app/./physicsTiers.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  scene01: async ({ sceneData, assets }) => {
    const module = await import('../app/./scene01.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  scene01V2: async ({ sceneData, assets }) => {
    const module = await import('../app/./scene01_v2.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  skyShowcase: async ({ sceneData, assets }) => {
    const module = await import('../app/./skyShowcase.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  space: async ({ sceneData, assets }) => {
    const module = await import('../app/./space.ts');
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
  textureArrays: async ({ sceneData, assets }) => {
    const module = await import('../app/./textureArrays.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  textureAtlases: async ({ sceneData, assets }) => {
    const module = await import('../app/./textureAtlases.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  thirdPersonGymScene: async ({ sceneData, assets }) => {
    const module = await import('../app/./scene_thirdPersonGym.ts');
    await (
      module as {
        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;
      }
    ).scene({ sceneData, assets });
  },
  topDownTestScene: async ({ sceneData, assets }) => {
    const module = await import('../app/./scene_topDownTest.ts');
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
  asteroid: {
    colorNode: asteroidFn.colorNode,
  },
  checkerBoard: {
    colorNode: checkerBoardFn.colorNode,
    roughnessNode: checkerBoardFn.roughnessNode,
    normalNode: checkerBoardFn.normalNode,
  },
  triplanarCheckerboard: {
    colorNode: triplanarCheckerboardFn.colorNode,
  },
  triplanarGrid: {
    colorNode: triplanarGridFn.colorNode,
    normalNode: triplanarGridFn.normalNode,
  },
};

export const postFxFileObjects = {
  ambientOcclusion: {
    fxNode: ambientOcclusionPostFxFn.fxNode,
  },
};
