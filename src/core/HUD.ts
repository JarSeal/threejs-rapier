import { CMP, type TCMP } from '../utils/CMP';

let hudRoot: TCMP | null = null;
export const GUI_CONTAINER_ID = 'guiContainer';
export const HUD_ROOT_ID = 'hudRoot';

/**
 * Returns the main/root GUI container element
 * @returns guiContainerElem (HTMLElement)
 */
export const getGUIContainerElem = () => {
  let guiContainerElem = document.getElementById(HUD_ROOT_ID);
  if (!guiContainerElem) {
    guiContainerElem = document.getElementById(GUI_CONTAINER_ID);
    if (!guiContainerElem) {
      throw new Error(`GUI container parent element with id "${GUI_CONTAINER_ID}" was not found.`);
    }
  }
  return guiContainerElem;
};

/**
 * Creates the HUD container and sets it to DOM
 */
export const createHudContainer = () => {
  hudRoot = CMP({ id: HUD_ROOT_ID, idAttr: true, attach: getGUIContainerElem(), class: 'hudRoot' });
};

/**
 * Returns the HUD root CMP
 * @returns hudRoot (TCMP)
 */
export const getHUDRootCMP = () => {
  if (!hudRoot) {
    throw new Error('HUD root CMP not found.');
  }
  return hudRoot;
};
