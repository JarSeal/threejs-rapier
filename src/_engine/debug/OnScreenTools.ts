import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

export type ToolTypes = 'SWITCH' | 'PLAY' | 'UNDO';

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

/** Reloads the app in production test mode (the on-screen play button, F5). */
export const playInProdTestMode = () => {
  useDebug(debugGUI, true)?._playInProdTestMode();
};

/** Reloads the app in debug mode (the on-screen stop button in production test mode, F5). */
export const stopProdTestMode = () => {
  useDebug(debugGUI, true)?._stopProdTestMode();
};
