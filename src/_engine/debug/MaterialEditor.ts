import { IS_DEBUG_ENV } from '../core/Config';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

type MaterialEditorModule = typeof import('../core/Debug/Editors/Material/_dbg__MaterialEditor');
let materialEditor: DebugModuleRef<MaterialEditorModule> | null = null;

/**
 * Loads the material editor and registers its editor view, "Material editor" (debug environments
 * only). Call it before the saved view is restored (InitApp's debug block).
 */
export const registerMaterialEditor = async () => {
  if (!IS_DEBUG_ENV) return;
  materialEditor = await loadDebugModuleAsync(
    () => import('../core/Debug/Editors/Material/_dbg__MaterialEditor')
  );
  useDebug(materialEditor)?._registerMaterialEditorView();
};
