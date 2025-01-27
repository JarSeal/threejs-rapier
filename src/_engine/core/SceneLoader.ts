// import { lsGetItem } from '../utils/LocalAndSessionStorage';
// import { isDebugEnvironment } from './Config';

// export type SceneLoaderParams = {
//   loaderId: string;
//   scenes: {
//     [id: string]: {
//       assets: string[] | { [id: string]: { type: '' } };
//       sceneFn: () => void;
//     };
//   };
//   currentSceneId: string;
// };

// const LS_KEY_PREFIX = 'sceneLoaderParams';

// export class SceneLoader {
//   loaderId: string;
//   scenes: SceneLoaderParams['scenes'];
//   currentSceneId: string;

//   constructor(initParams: SceneLoaderParams) {
//     let params = initParams;
//     this.scenes = params.scenes;
//     this.loaderId = params.loaderId;

//     // Get current scene to load
//     if (isDebugEnvironment()) {
//       const savedParams = lsGetItem(`${LS_KEY_PREFIX}-${this.loaderId}`, params);
//       params = { ...params, ...savedParams };
//       this.currentSceneId = params.currentSceneId;
//     } else {
//       this.currentSceneId = params.currentSceneId;
//     }
//   }
// }

// const loadedScenes: {
//   [loaderId: string]: {
//     [sceneId: string]: {
//       assets: {
//         id?: string;
//         type: 'texture' | 'equiRectTexture' | 'model';
//         url: string | string[];
//       }[];
//       sceneFn: () => boolean | void;
//       loaderFn: {};
//       loadOnLoaderInit?: boolean;
//     };
//   };
// } = {};

// export const loadScene = async ({
//   loaderId,
//   currentScene,
// }: {
//   loaderId: string;
//   currentScene: string;
// }) => {
//   let loaderData = loadedScenes[loaderId];
//   if (!loaderData) {
//     // Need to initialize the loader
//   }
//   const sceneData = loadedScenes[loaderId][currentScene];
//   if (sceneData) {
//     sceneData.sceneFn();
//   }
// };
