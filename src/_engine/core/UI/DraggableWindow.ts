import { CMP, TCMP } from '../../utils/CMP';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lerror } from '../../utils/Logger';
import { getWindowSize } from '../../utils/Window';
import { getConfig } from '../Config';
import { getHUDRootCMP } from '../HUD';
import { addResizer, deleteResizer } from '../MainLoop';
import styles from './DraggableWindow.module.scss';

export type DraggableWindow = {
  id: string;
  windowCMP: TCMP;
  isOpen: boolean;
  position: { x: number; y: number };
  size: { w: number; h: number };
  maxSize: { w: number; h: number };
  minSize: { w: number; h: number };
  units?: {
    // Default is 'px'
    position?: { x?: Units; y?: Units };
    size?: { w?: Units; h?: Units };
    maxSize?: { w?: Units; h?: Units };
    minSize?: { w?: Units; h?: Units };
  };
  defaultPosition: { x: number; y: number };
  defaultSize: { w: number; h: number };
  saveToLS?: boolean;
  title?: string;
  isDebugWindow?: boolean;
  disableVertResize?: boolean;
  disableHoriResize?: boolean;
  disableDragging?: boolean;
  disableCollapse?: boolean;
};

type Units = 'px' | '%' | 'vw' | 'vh';

type OpenDraggableWindowProps = {
  id: string;
  content?: TCMP | (() => TCMP);
  position?: { x: number; y: number };
  size?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  units?: {
    // Default is 'px'
    position?: { x?: Units; y?: Units };
    size?: { w?: Units; h?: Units };
    maxSize?: { w?: Units; h?: Units };
    minSize?: { w?: Units; h?: Units };
  };
  resetPosition?: boolean;
  resetSize?: boolean;
  closeIfOpen?: boolean;
  saveToLS?: boolean;
  title?: string;
  isDebugWindow?: boolean;
  disableVertResize?: boolean;
  disableHoriResize?: boolean;
  disableDragging?: boolean;
  disableCollapse?: boolean;
};

let draggableWindows: { [id: string]: DraggableWindow } = {};
let listenersCreated = false;
let draggingPosId: null | string = null;
let draggingVertId: null | string = null;
let draggingHoriId: null | string = null;
let rightMouseClickDown = false;
let resizerListener: null | NodeJS.Timeout = null;
const listeners: {
  onMouseDown: null | ((e: MouseEvent) => void);
  onMouseMove: null | ((e: MouseEvent) => void);
  onMouseUp: null | ((e: MouseEvent) => void);
} = {
  onMouseDown: null,
  onMouseMove: null,
  onMouseUp: null,
};
const LS_KEY = 'draggableWindows';
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 320;
const DEFAULT_MIN_WIDTH = 100;
const DEFAULT_MIN_HEIGHT = 120;
const DEFAULT_Z_INDEX = 100;
const DEFAULT_Z_INDEX_ACTIVE = 105;
const DEFAULT_DEBUG_Z_INDEX = 20000;
const DEFAULT_DEBUG_Z_INDEX_ACTIVE = 20005;
const WINDOW_CLASS = 'draggableWindow';
const HEADER_CLASS = 'dragWinHeader';
const VERT_RESIZER_CLASS = 'vertDragHandle';
const HORI_RESIZER_CLASS = 'horiDragHandle';
const VERT_AND_HORI_RESIZER_CLASS = 'vertAndHoriDragHandle';
const MAX_OFF_SCREEN_HORI_THRESHOLD = 50;
const MAX_OFF_SCREEN_VERT_THRESHOLD = 10;

export const openDraggableWindow = (props: OpenDraggableWindowProps) => {
  let windowCMP: TCMP | undefined;
  const hudRoot = getHUDRootCMP();
  const appWinSize = getWindowSize();
  const {
    id,
    content,
    resetPosition,
    resetSize,
    closeIfOpen,
    position: pos,
    size: sze,
    maxSize: sizeMax,
    minSize: sizeMin,
    units,
    saveToLS,
    title,
    isDebugWindow,
    disableVertResize,
    disableHoriResize,
    disableDragging,
    disableCollapse,
  } = props;
  const screenSize = getWindowSize();
  if (!id) {
    const msg = 'Draggable window has to have an id (in openDraggableWindow).';
    lerror(msg);
    throw new Error(msg);
  }

  const foundWindow = draggableWindows[id];

  let size = {
    ...(foundWindow?.size ||
      sze || {
        w: DEFAULT_WIDTH,
        h: DEFAULT_HEIGHT,
      }),
  };
  let position = {
    ...(foundWindow?.position ||
      pos || {
        x: screenSize.width / 2 - size.w / 2,
        y: screenSize.height / 2 - size.h / 2,
      }),
  };
  const defaultS = {
    ...foundWindow?.defaultSize,
    ...size,
    ...sze,
  };
  const defaultP = {
    ...foundWindow?.defaultPosition,
    ...position,
    ...pos,
  };
  const maxSize = foundWindow?.maxSize || sizeMax || { w: appWinSize.width, h: appWinSize.height };
  const minSize = foundWindow?.minSize ||
    sizeMin || { w: DEFAULT_MIN_WIDTH, h: DEFAULT_MIN_HEIGHT };
  const winUnits = foundWindow?.units || units;
  const headerTitle = foundWindow?.title || title || '';
  const isDebugWin =
    foundWindow?.isDebugWindow !== undefined ? foundWindow.isDebugWindow : Boolean(isDebugWindow);
  const vertResizeDisabled =
    foundWindow?.disableVertResize !== undefined
      ? foundWindow.disableVertResize
      : Boolean(disableVertResize);
  const horiResizeDisabled =
    foundWindow?.disableHoriResize !== undefined
      ? foundWindow.disableHoriResize
      : Boolean(disableHoriResize);
  const draggingDisabled =
    foundWindow?.disableDragging !== undefined
      ? foundWindow.disableDragging
      : Boolean(disableDragging);
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
    setAllOpenWindowsZIndexInactive();
    windowCMP.updateStyle({
      zIndex: foundWindow.isDebugWindow ? DEFAULT_DEBUG_Z_INDEX_ACTIVE : DEFAULT_Z_INDEX_ACTIVE,
    });
    hudRoot.add(foundWindow.windowCMP);
  } else {
    windowCMP = createWindowCMP(
      id,
      size,
      position,
      maxSize,
      minSize,
      winUnits,
      content,
      headerTitle,
      isDebugWin,
      vertResizeDisabled,
      horiResizeDisabled,
      disableDragging,
      disableCollapse
    );
    hudRoot.add(windowCMP);
  }

  createListeners();

  draggableWindows[id] = {
    id,
    windowCMP,
    isOpen: true,
    position,
    size,
    maxSize,
    minSize,
    units: winUnits,
    defaultSize: defaultS,
    defaultPosition: defaultP,
    saveToLS: saveToLS !== undefined ? saveToLS : foundWindow.saveToLS,
    title: headerTitle,
    isDebugWindow: isDebugWin,
    disableVertResize: vertResizeDisabled,
    disableHoriResize: horiResizeDisabled,
    disableDragging: draggingDisabled,
  };
  checkAndSetMaxWindowPosition(draggableWindows[id]);
  saveDraggableWindowStatesToLS();
};

export const closeDraggableWindow = (id: string) => {
  const foundWindow = draggableWindows[id];
  if (!foundWindow) return;

  foundWindow.windowCMP.elem.remove();
  foundWindow.isOpen = false;
  draggableWindows[id] = foundWindow;
  saveDraggableWindowStatesToLS();

  removeListeners();
};

export const toggleCollapse = (id: string) => {
  const state = draggableWindows[id];
  if (!state || !state.windowCMP) return;

  // @TODO: finish this
};

const createWindowCMP = (
  id: string,
  size: { w: number; h: number },
  position: { x: number; y: number },
  maxSize: { w: number; h: number },
  minSize: { w: number; h: number },
  units: OpenDraggableWindowProps['units'],
  content?: TCMP | (() => TCMP),
  title?: string,
  isDebugWindow?: boolean,
  disableVertResize?: boolean,
  disableHoriResize?: boolean,
  disableDragging?: boolean,
  disableCollapse?: boolean
) => {
  // Main wrapper
  const windowClassList = [styles.draggableWindow, WINDOW_CLASS];
  if (!disableVertResize) windowClassList.push(styles.vertResizable);
  if (!disableHoriResize) windowClassList.push(styles.horiResizable);
  if (!disableDragging) windowClassList.push(styles.draggable);
  setAllOpenWindowsZIndexInactive();
  const windowCMP = CMP({
    id,
    idAttr: true,
    class: windowClassList,
    style: {
      width: `${size.w}${units?.size?.w || 'px'}`,
      height: `${size.h}${units?.size?.h || 'px'}`,
      minWidth: `${minSize.w}${units?.minSize?.w || 'px'}`,
      minHeight: `${minSize.h}${units?.minSize?.h || 'px'}`,
      maxWidth: `${maxSize.w}${units?.maxSize?.w || 'px'}`,
      maxHeight: `${maxSize.h}${units?.maxSize?.h || 'px'}`,
      left: `${position.x}${units?.position?.x || 'px'}`,
      top: `${position.y}${units?.position?.y || 'px'}`,
      ...(units?.position
        ? {
            transform: `translate3D(${units.position.x && units.position.x !== 'px' ? '-50%' : '0'}, ${units.position.y && units.position.y !== 'px' ? '-50%' : '0'}, 0)`,
          }
        : {}),
      zIndex: isDebugWindow ? DEFAULT_DEBUG_Z_INDEX_ACTIVE : DEFAULT_Z_INDEX_ACTIVE,
    },
    onClick: () => {
      setAllOpenWindowsZIndexInactive();
      windowCMP.updateStyle({
        zIndex: isDebugWindow ? DEFAULT_DEBUG_Z_INDEX_ACTIVE : DEFAULT_Z_INDEX_ACTIVE,
      });
    },
  });

  // Header bar
  const headerBarCMP = CMP({
    tag: 'header',
    class: [styles.headerBar, HEADER_CLASS],
  });
  headerBarCMP.add({
    tag: 'h3',
    class: styles.title,
    text: title || '',
    style: { userSelect: 'none' },
  });
  if (!disableCollapse) {
    headerBarCMP.add({
      tag: 'button',
      class: styles.collapseBtn,
      onClick: (e) => {
        e.preventDefault();
        toggleCollapse(id);
      },
    });
  }
  headerBarCMP.add({
    tag: 'button',
    class: styles.closeBtn,
    onClick: (e) => {
      e.preventDefault();
      closeDraggableWindow(id);
    },
    attr: { title: 'Close' },
  });
  windowCMP.add(headerBarCMP);

  // Content wrapper
  const contentWrapperCMP = CMP({ class: styles.contentWrapper });
  windowCMP.add(contentWrapperCMP);

  // Resizers
  if (!disableVertResize) {
    windowCMP.add({ class: [styles.vertHandle, VERT_RESIZER_CLASS] });
  }
  if (!disableHoriResize) {
    windowCMP.add({ class: [styles.horiHandle, HORI_RESIZER_CLASS] });
  }
  if (!disableVertResize && !disableHoriResize) {
    windowCMP.add({ class: [styles.vertAndHoriHandle, VERT_AND_HORI_RESIZER_CLASS] });
  }

  // Content
  if (content) {
    if (typeof content === 'function') {
      contentWrapperCMP.add(content());
    } else {
      contentWrapperCMP.add(content);
    }
  } else {
    const config = getConfig();
    const state = config.draggableWindows ? config.draggableWindows[id] : null;
    if (state?.contentFn) contentWrapperCMP.add(state.contentFn());
  }

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

const createListeners = () => {
  if (listenersCreated) return;

  if (listeners.onMouseDown !== null) {
    window.removeEventListener('mousedown', listeners.onMouseDown);
  }
  if (listeners.onMouseMove !== null) {
    window.removeEventListener('mousemove', listeners.onMouseMove, true);
  }
  if (listeners.onMouseUp !== null) {
    window.removeEventListener('mouseup', listeners.onMouseUp);
  }

  // Mouse down
  listeners.onMouseDown = (e) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || rightMouseClickDown) {
      rightMouseClickDown = true;
      return;
    }

    const curTargetHasHeaderClass = target?.classList?.contains(HEADER_CLASS);
    const curTargetParentHasHeaderClass = target?.parentElement?.classList?.contains(HEADER_CLASS);
    if ((curTargetHasHeaderClass || curTargetParentHasHeaderClass) && target.tagName !== 'BUTTON') {
      // Header mouse down, start drag
      const headerElem = (curTargetHasHeaderClass ? target : target.parentElement) as HTMLElement;
      const id = headerElem.parentElement?.id;
      const state = draggableWindows[id || ''];
      const winElem = state?.windowCMP?.elem;
      if (!id || !state || !winElem || state?.disableDragging) return;

      const offsetX = e.clientX - winElem.offsetLeft;
      const offsetY = e.clientY - winElem.offsetTop;
      draggingPosId = id;

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        if (!draggingPosId) {
          if (listeners.onMouseMove) {
            window.removeEventListener('mousemove', listeners.onMouseMove, true);
            listeners.onMouseMove = null;
          }
          return;
        }
        winElem.style.left = `${e.clientX - offsetX}px`;
        winElem.style.top = `${e.clientY - offsetY}px`;
        checkAndSetMaxWindowPosition(state);
      };
      window.addEventListener('mousemove', listeners.onMouseMove, true);
      return;
    }

    const curTargetHasVertClass = target?.classList.contains(VERT_RESIZER_CLASS);
    if (curTargetHasVertClass) {
      const id = target.parentElement?.id;
      const state = draggableWindows[id || ''];
      const winElem = state?.windowCMP?.elem;
      if (!id || !state || !winElem) return;

      const startHeight = winElem.clientHeight;
      const startPos = e.clientY;
      draggingVertId = id;

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        if (!draggingVertId) {
          if (listeners.onMouseMove) {
            window.removeEventListener('mousemove', listeners.onMouseMove, true);
            listeners.onMouseMove = null;
          }
          return;
        }
        let height = startHeight + e.clientY - startPos;
        if (height > state.maxSize.h) height = state.maxSize.h;
        if (height < state.minSize.w) height = state.minSize.w;
        winElem.style.height = `${height}px`;
      };
      window.addEventListener('mousemove', listeners.onMouseMove, true);
      return;
    }

    const curTargetHasHoriClass = target?.classList.contains(HORI_RESIZER_CLASS);
    if (curTargetHasHoriClass) {
      const id = target.parentElement?.id;
      const state = draggableWindows[id || ''];
      const winElem = state?.windowCMP?.elem;
      if (!id || !state || !winElem) return;

      const startWidth = winElem.clientWidth;
      const startPos = e.clientX;
      draggingHoriId = id;

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        if (!draggingHoriId) {
          if (listeners.onMouseMove) {
            window.removeEventListener('mousemove', listeners.onMouseMove, true);
            listeners.onMouseMove = null;
          }
          return;
        }
        let width = startWidth + e.clientX - startPos;
        if (width > state.maxSize.w) width = state.maxSize.w;
        if (width < state.minSize.w) width = state.minSize.w;
        winElem.style.width = `${width}px`;
      };
      window.addEventListener('mousemove', listeners.onMouseMove, true);
      return;
    }

    const curTargetHasVertAndHoriClass = target?.classList.contains(VERT_AND_HORI_RESIZER_CLASS);
    if (curTargetHasVertAndHoriClass) {
      const id = target.parentElement?.id;
      const state = draggableWindows[id || ''];
      const winElem = state?.windowCMP?.elem;
      if (!id || !state || !winElem) return;

      const startWidth = winElem.clientWidth;
      const startPosX = e.clientX;
      const startHeight = winElem.clientHeight;
      const startPosY = e.clientY;
      draggingHoriId = id;
      draggingVertId = id;

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        let width = startWidth + e.clientX - startPosX;
        if (width > state.maxSize.w) width = state.maxSize.w;
        if (width < state.minSize.w) width = state.minSize.w;
        let height = startHeight + e.clientY - startPosY;
        if (height > state.maxSize.h) height = state.maxSize.h;
        if (height < state.minSize.w) height = state.minSize.w;
        winElem.style.width = `${width}px`;
        winElem.style.height = `${height}px`;
      };
      window.addEventListener('mousemove', listeners.onMouseMove, true);
      return;
    }
  };

  // Mouse up
  listeners.onMouseUp = (e) => {
    if (e.button !== 0) {
      rightMouseClickDown = false;
      return;
    }

    if (listeners.onMouseMove) {
      window.removeEventListener('mousemove', listeners.onMouseMove, true);
      listeners.onMouseMove = null;
    }

    if (draggingPosId) {
      const state = draggableWindows[draggingPosId];
      if (!state?.windowCMP) return;
      state.position.x = state.windowCMP.elem.offsetLeft;
      state.position.y = state.windowCMP.elem.offsetTop;
      saveDraggableWindowStatesToLS();
    }

    if (draggingVertId) {
      const state = draggableWindows[draggingVertId];
      if (!state?.windowCMP) return;
      state.size.h = state.windowCMP.elem.clientHeight;
      saveDraggableWindowStatesToLS();
    }

    if (draggingHoriId) {
      const state = draggableWindows[draggingHoriId];
      if (!state?.windowCMP) return;
      state.size.w = state.windowCMP.elem.clientWidth;
      saveDraggableWindowStatesToLS();
    }

    draggingPosId = null;
    draggingVertId = null;
    draggingHoriId = null;
  };

  // Resize
  addResizer('draggableWindows', () => {
    if (resizerListener) clearTimeout(resizerListener);
    resizerListener = setTimeout(() => {
      // @TODO: Make sure all the windows are on the screen
      setOpenWinPositionsWithingScreen();
    }, 200);
  });

  window.addEventListener('mousedown', listeners.onMouseDown);
  window.addEventListener('mouseup', listeners.onMouseUp);

  listenersCreated = true;
};

const removeListeners = () => {
  if (!listenersCreated) return;

  const ids = Object.keys(draggableWindows);
  for (let i = 0; i < ids.length; i++) {
    const state = draggableWindows[ids[i]];
    if (state.isOpen) return;
  }

  if (listeners.onMouseDown !== null) {
    window.removeEventListener('mousedown', listeners.onMouseDown);
  }
  if (listeners.onMouseMove !== null) {
    window.removeEventListener('mousemove', listeners.onMouseMove, true);
  }
  if (listeners.onMouseUp !== null) {
    window.removeEventListener('mouseup', listeners.onMouseUp);
  }

  deleteResizer('draggableWindows');

  listeners.onMouseDown = null;
  listeners.onMouseMove = null;
  listeners.onMouseUp = null;

  listenersCreated = false;
};

const setAllOpenWindowsZIndexInactive = () => {
  const keys = Object.keys(draggableWindows);
  for (let i = 0; i < keys.length; i++) {
    const state = draggableWindows[keys[i]];
    if (state.isOpen && state.windowCMP) {
      state.windowCMP.updateStyle({
        zIndex: state.isDebugWindow ? DEFAULT_DEBUG_Z_INDEX : DEFAULT_Z_INDEX,
      });
    }
  }
};

const setOpenWinPositionsWithingScreen = () => {
  const keys = Object.keys(draggableWindows);
  for (let i = 0; i < keys.length; i++) {
    const state = draggableWindows[keys[i]];
    checkAndSetMaxWindowPosition(state);
  }
};

const checkAndSetMaxWindowPosition = (state: DraggableWindow) => {
  if (!state.isOpen || !state.windowCMP) return;
  const screenSize = getWindowSize();
  const posX = state.windowCMP.elem.offsetLeft;
  const posY = state.windowCMP.elem.offsetTop;
  const winWidth = state.windowCMP.elem.clientWidth;

  if (posX < -(winWidth - MAX_OFF_SCREEN_HORI_THRESHOLD)) {
    state.windowCMP.updateStyle({ left: `${-(winWidth - MAX_OFF_SCREEN_HORI_THRESHOLD)}px` });
  } else if (posX > screenSize.width - MAX_OFF_SCREEN_HORI_THRESHOLD) {
    state.windowCMP.updateStyle({
      left: `${screenSize.width - MAX_OFF_SCREEN_HORI_THRESHOLD}px`,
    });
  }

  if (posY < -MAX_OFF_SCREEN_VERT_THRESHOLD) {
    state.windowCMP.updateStyle({ top: `${-MAX_OFF_SCREEN_VERT_THRESHOLD}px` });
  } else if (posY > screenSize.height - MAX_OFF_SCREEN_VERT_THRESHOLD * 2) {
    state.windowCMP.updateStyle({
      top: `${screenSize.height - MAX_OFF_SCREEN_VERT_THRESHOLD * 2}px`,
    });
  }
};
