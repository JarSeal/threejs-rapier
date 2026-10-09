import type { DebugModuleRef } from '../utils/helpers';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';

export type ToolTypes = 'SWITCH' | 'PLAY' | 'UNDO' | 'VIEW';

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

/** Toggles between the debug camera and the app camera (F1, the on-screen debug camera button)
 * and shows a toast of the camera that is now active. Debug environment only. */
export const toggleDebugCameraWithToast = () => {
  useDebug(debugGUI)?._toggleDebugCameraWithToast();
};

/** The on-screen dropdowns: the camera and the scene selector. */
export type OnScreenDropDownKey = 'CAMERA' | 'SCENE';

/** Opens an on-screen dropdown's list on its current option, or closes it (the o and p
 * shortcuts). Debug env only. */
export const toggleOnScreenDropDown = (key: OnScreenDropDownKey) => {
  useDebug(debugGUI)?._toggleOnScreenDropDown(key);
};

/** Reloads the app in production test mode (the on-screen play button, F5). */
export const playInProdTestMode = () => {
  useDebug(debugGUI, true)?._playInProdTestMode();
};

/** Reloads the app in debug mode (the on-screen stop button in production test mode, F5). */
export const stopProdTestMode = () => {
  useDebug(debugGUI, true)?._stopProdTestMode();
};
