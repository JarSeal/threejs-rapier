import { CMP, TCMP } from '../../utils/CMP';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lerror } from '../../utils/Logger';
import { getWindowSize } from '../../utils/Window';
import { getConfig } from '../Config';
import { getHUDRootCMP } from '../HUD';
import styles from './DraggableWindow.module.scss';

export type DraggableWindow = {
  id: string;
  windowCMP: TCMP;
  isOpen: boolean;
  position: { x: number; y: number };
  size: { w: number; h: number };
  defaultPosition: { x: number; y: number };
  defaultSize: { w: number; h: number };
  saveToLS?: boolean;
};

type OpenDraggableWindowProps = {
  id: string;
  content?: TCMP | (() => TCMP);
  defaultPosition?: { x: number; y: number };
  defaultSize?: { w: number; h: number };
  resetPosition?: boolean;
  resetSize?: boolean;
  closeIfOpen?: boolean;
  saveToLS?: boolean;
};

let draggableWindows: { [id: string]: DraggableWindow } = {};
const LS_KEY = 'draggableWindows';
const DEFAULT_MIN_WIDTH_IN_REM = 32;
const DEFAULT_MIN_HEIGHT_IN_REM = 32;

const getDraggableCMPId = (id: string) => `draggableWindow-${id}`;

export const openDraggableWindow = (props: OpenDraggableWindowProps) => {
  let windowCMP: TCMP | undefined;
  const hudRoot = getHUDRootCMP();
  const {
    id,
    content,
    resetPosition,
    resetSize,
    closeIfOpen,
    defaultPosition,
    defaultSize,
    saveToLS,
  } = props;
  const screenSize = getWindowSize();
  if (!id) {
    const msg = 'Draggable window has to have an id (in openDraggableWindow).';
    lerror(msg);
    throw new Error(msg);
  }

  const config = getConfig();
  const state = config.draggableWindows ? config.draggableWindows[id] : null;

  const foundWindow = draggableWindows[id];

  let size = {
    w: defaultSize?.w || foundWindow?.size?.w || DEFAULT_MIN_WIDTH_IN_REM,
    h: defaultSize?.h || foundWindow?.size?.h || DEFAULT_MIN_HEIGHT_IN_REM,
  };
  let position = {
    ...(defaultPosition ||
      foundWindow?.position || {
        x: screenSize.width / 2 - size.w / 2,
        y: screenSize.height / 2 - size.h / 2,
      }),
  };
  const defaultS = { ...size };
  const defaultP = { ...position };
  let isOpen = true;

  if (foundWindow?.windowCMP) {
    isOpen = foundWindow.isOpen;
    if (closeIfOpen && isOpen) {
      foundWindow.defaultSize = defaultS;
      foundWindow.defaultPosition = defaultP;
      draggableWindows[id] = foundWindow;
      closeDraggableWindow(id);
      return;
    }

    size = resetSize ? foundWindow.defaultSize : foundWindow.size;
    position = resetPosition ? foundWindow.defaultPosition : foundWindow.position;
    windowCMP = foundWindow.windowCMP;
    hudRoot.add(foundWindow.windowCMP);
  } else {
    windowCMP = createWindowCMP(id, size, position, defaultS);
    if (content) {
      if (typeof content === 'function') {
        windowCMP.add(content());
      } else {
        windowCMP.add(content);
      }
    } else {
      if (state?.contentFn) windowCMP.add(state.contentFn());
    }
    hudRoot.add(windowCMP);
  }

  draggableWindows[id] = {
    id,
    windowCMP,
    isOpen: true,
    position,
    size,
    defaultSize: defaultS,
    defaultPosition: defaultP,
    saveToLS: saveToLS !== undefined ? saveToLS : foundWindow.saveToLS,
  };
  saveDraggableWindowStatesToLS();
};

export const closeDraggableWindow = (id: string) => {
  const foundWindow = draggableWindows[id];
  if (!foundWindow) return;

  foundWindow.windowCMP?.remove();
  foundWindow.isOpen = false;
  draggableWindows[id] = foundWindow;
  saveDraggableWindowStatesToLS();
};

const createWindowCMP = (
  id: string,
  size: { w: number; h: number },
  position: { x: number; y: number },
  defaultSize: { w: number; h: number }
) => {
  const windowCMP = CMP({
    id: getDraggableCMPId(id),
    class: [styles.draggableWindow, styles.open],
    style: {
      width: `${size.w}rem`,
      height: `${size.h}rem`,
      minWidth: `${defaultSize.w}rem`,
      minHeight: `${defaultSize.h}rem`,
      left: `${position.x}px`,
      top: `${position.y}px`,
    },
    text: 'Draggable window...',
  });

  return windowCMP;
};

const saveDraggableWindowStatesToLS = () => {
  const ids = Object.keys(draggableWindows);
  const saveableStates: {
    [id: string]: { [key: string]: DraggableWindow[keyof DraggableWindow] };
  } = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const saveableState: { [key: string]: DraggableWindow[keyof DraggableWindow] } = {};
    const state = { ...draggableWindows[id] };
    if (!state.saveToLS) continue;
    const keys = Object.keys(state);
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j] as keyof DraggableWindow;
      if (key === 'windowCMP') continue;
      saveableState[key] = state[key];
    }
    saveableStates[id] = saveableState;
  }
  if (!Object.keys(saveableStates).length) return;
  lsSetItem(LS_KEY, saveableStates);
};

export const loadDraggableWindowStatesFromLS = () => {
  const savedStates = lsGetItem(LS_KEY, draggableWindows);
  draggableWindows = { ...draggableWindows, ...savedStates };

  const draggableWindowsFromConfig = getConfig().draggableWindows;
  if (!draggableWindowsFromConfig) return;

  const keys = Object.keys(draggableWindowsFromConfig);
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    if (!draggableWindows[id]) continue;
    const state = draggableWindowsFromConfig[id];
    draggableWindows[id] = { ...draggableWindows[id], ...state, ...savedStates };

    if (draggableWindows[id].isOpen) openDraggableWindow({ id });
  }
};
