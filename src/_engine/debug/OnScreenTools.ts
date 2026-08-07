import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

export type ToolTypes = 'SWITCH' | 'PLAY';

type OnScreenToolsGUIModule = typeof import('../core/Debug/_dbg__OnScreenTools');
let debugGUI: DebugModuleRef<OnScreenToolsGUIModule> | null = null;

export const registerOnScreenTools = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__OnScreenTools'), true);
};

export const InitOnScreenTools = () => {
  useDebug(debugGUI, true)?._InitOnScreenTools();
};

export const updateOnScreenTools = (tools?: ToolTypes[] | ToolTypes) => {
  useDebug(debugGUI, true)?._updateOnScreenTools(tools);
};
