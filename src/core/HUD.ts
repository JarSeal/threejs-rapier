import { CMP, type TCMP } from '../utils/CMP';

let hudRoot: TCMP | null = null;
const GUI_CONTAINER_ID = 'guiContainer';
const HUD_ROOT_ID = 'hudRoot';

// @TODO: add JSDoc comment
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

// @TODO: add JSDoc comment
export const createHudContainer = () => {
  hudRoot = CMP({ id: HUD_ROOT_ID, idAttr: true, attach: getGUIContainerElem(), class: 'hudRoot' });
};

// @TODO: add JSDoc comment
export const getHUDRootCMP = () => {
  if (!hudRoot) {
    throw new Error('HUD root CMP not found.');
  }
  return hudRoot;
};
