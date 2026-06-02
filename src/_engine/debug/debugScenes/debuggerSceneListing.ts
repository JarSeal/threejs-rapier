import { DEBUG_MATERIAL_EDITOR_ID, initDebugMaterialEditorScene } from './materialEditor';

export type DebugScene = { id: string; fn: () => Promise<void>; text: string };

export const debuggerSceneListing: DebugScene[] = [
  {
    id: DEBUG_MATERIAL_EDITOR_ID,
    fn: initDebugMaterialEditorScene,
    text: '[Editor] Material editor',
  },
];
