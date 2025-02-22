import { initDebugMaterialEditorScene } from './debugScenes/materialEditor';

export const DEBUG_SCENE_LISTING = {
  materialEditor: { value: '_debug-material-editor', text: '[Debug] Material editor' },
};

export const debugSceneListingInits: {
  [sceneId: string]: {
    fn: () => void;
    initiated?: boolean;
  };
} = {
  [DEBUG_SCENE_LISTING.materialEditor.value]: { fn: () => initDebugMaterialEditorScene() },
};
