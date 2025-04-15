import {
  DEBUG_MATERIAL_EDITOR_ID,
  initDebugMaterialEditorScene,
} from './debugScenes/materialEditor';

export type DebugScene = { id: string; fn: () => Promise<string>; text: string };

export const debugSceneListing: DebugScene[] = [
  {
    id: DEBUG_MATERIAL_EDITOR_ID,
    fn: initDebugMaterialEditorScene,
    text: '[Debug] Material editor',
  },
];
