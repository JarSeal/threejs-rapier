import { CMP, getCmpById, TCMP } from '../../utils/CMP';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lerror } from '../../utils/Logger';
import { getWindowSize } from '../../utils/Window';
import { getConfig } from '../Config';
import { getHUDRootCMP } from '../HUD';
import { addResizer, deleteResizer } from '../MainLoop';
import styles from './DraggableWindow.module.scss';

export type DraggableWindow = {
  id: string;
  orderNr: number;
  isActive: boolean;
  windowCMP: TCMP;
  content?: TCMP | ((data?: { [key: string]: unknown }) => TCMP);
  backDropCMP?: TCMP;
  data?: { [key: string]: unknown };
  isOpen: boolean;
  isCollapsed?: boolean;
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
  disableCollapseBtn?: boolean;
  disableCloseBtn?: boolean;
  closeOnSceneChange?: boolean;
  removeOnSceneChange?: boolean;
  removeOnClose?: boolean;
  customZIndex?: number;
  hasBackDrop?: boolean;
  backDropClickClosesWindow?: boolean;
  windowClass?: string | string[];
  backDropClass?: string | string[];
  onClose?: () => void;
};

type Units = 'px' | '%' | 'vw' | 'vh';

export type OpenDraggableWindowProps = {
  id: string;
  content?: TCMP | ((data?: { [key: string]: unknown }) => TCMP);
  data?: { [key: string]: unknown };
  isCollapsed?: boolean;
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
  disableCollapseBtn?: boolean;
  disableCloseBtn?: boolean;
  closeOnSceneChange?: boolean;
  removeOnSceneChange?: boolean;
  removeOnClose?: boolean;
  customZIndex?: number;
  hasBackDrop?: boolean;
  backDropClickClosesWindow?: boolean;
  windowClass?: string | string[];
  backDropClass?: string | string[];
};

let draggableWindows: { [id: string]: DraggableWindow } = {};
let listenersCreated = false;
let orderNr = 0;
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
const LS_KEY = 'popupWindows';
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 320;
const DEFAULT_MIN_WIDTH = 100;
const DEFAULT_MIN_HEIGHT = 120;
const DEFAULT_Z_INDEX = 100;
const DEFAULT_Z_INDEX_ACTIVE = 105;
const DEFAULT_DEBUG_Z_INDEX = 20000;
const DEFAULT_DEBUG_Z_INDEX_ACTIVE = 20005;
const DEFAULT_DEBUG_ADDITION_TO_CUSTOM_Z_INDEX = 100;
const WINDOW_CLASS_NAME = 'popupWindow';
const BACKDROP_CLASS_NAME = 'containerWindowBackDrop';
const BACKDROP_CLOSES_WINDOW_CLASS_NAME = 'backDropClickClose';
const DRAGGABLE_CLASS_NAME = 'draggableWindow';
const RESIZE_HORI_CLASS_NAME = 'horizontalResize';
const RESIZE_VERT_CLASS_NAME = 'verticalResize';
const COLLAPSABLE_CLASS_NAME = 'collapsableWindow';
const COLLAPSED_CLASS_NAME = 'collapsed';
const COLLAPSE_BTN_CLASS_NAME = 'collapseBtn';
const CLOSE_BTN_CLASS_NAME = 'closeBtn';
const CONTENT_CONTAINER_CLASS_NAME = 'contentContainer';
const HEADER_CLASS = 'windowHeader';
const VERT_RESIZER_CLASS_NAME = 'vertDragHandle';
const HORI_RESIZER_CLASS_NAME = 'horiDragHandle';
const VERT_AND_HORI_RESIZER_CLASS_NAME = 'vertAndHoriDragHandle';
const MAX_OFF_SCREEN_HORI_THRESHOLD = 65;
const MAX_OFF_SCREEN_VERT_THRESHOLD = 10; // For the the bottom threshold this number is *2

export const getDraggableWindowsDefaultZIndexes = () => ({
  defaultZIndex: DEFAULT_Z_INDEX,
  defaultZIndexActive: DEFAULT_Z_INDEX_ACTIVE,
  defaultDebugZIndex: DEFAULT_DEBUG_Z_INDEX,
  defaultDebugZIndexActive: DEFAULT_DEBUG_Z_INDEX_ACTIVE,
  defaultDebugAdditionToCustomZIndex: DEFAULT_DEBUG_ADDITION_TO_CUSTOM_Z_INDEX,
});

export const openDraggableWindow = (props: OpenDraggableWindowProps) => {
  let windowCMP: TCMP | undefined;
  const hudRoot = getHUDRootCMP();
  const appWinSize = getWindowSize();
  const {
    id,
    content,
    data: dataProp,
    isCollapsed: winIsCollapsed,
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
    disableCollapseBtn,
    disableCloseBtn,
    closeOnSceneChange: shouldCloseOnSceneChange,
    removeOnSceneChange: shouldRemoveOnSceneChange,
    removeOnClose: shouldRemoveOnClose,
    customZIndex,
    hasBackDrop: winHasBackDrop,
    backDropClickClosesWindow: winBackDropClickClosesWindow,
    windowClass: winClass,
    backDropClass: bdClass,
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
  let headerTitle = foundWindow?.title || title || '';
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
  const isCollapsed =
    foundWindow?.isCollapsed !== undefined ? foundWindow.isCollapsed : Boolean(winIsCollapsed);
  const closeOnSceneChange =
    foundWindow?.closeOnSceneChange !== undefined
      ? foundWindow.closeOnSceneChange
      : Boolean(shouldCloseOnSceneChange);
  const removeOnSceneChange =
    foundWindow?.removeOnSceneChange !== undefined
      ? foundWindow.removeOnSceneChange
      : Boolean(shouldRemoveOnSceneChange);
  const removeOnClose =
    foundWindow?.removeOnClose !== undefined
      ? foundWindow.removeOnClose
      : Boolean(shouldRemoveOnClose);
  const hasBackDrop =
    foundWindow?.hasBackDrop !== undefined ? foundWindow.hasBackDrop : Boolean(winHasBackDrop);
  const backDropClickClosesWindow =
    foundWindow?.backDropClickClosesWindow !== undefined
      ? foundWindow.backDropClickClosesWindow
      : Boolean(winBackDropClickClosesWindow);
  let isOpen = true;
  const data = dataProp || foundWindow?.data;

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
    position = resetPosition && pos ? pos : foundWindow.defaultPosition; // @TODO: FIX THIS
    windowCMP = foundWindow.windowCMP;
    setAllOpenWindowsZIndexInactive();
    let zIndex = foundWindow.isDebugWindow ? DEFAULT_DEBUG_Z_INDEX_ACTIVE : DEFAULT_Z_INDEX_ACTIVE;
    if (foundWindow.customZIndex) {
      zIndex = foundWindow.isDebugWindow
        ? foundWindow.customZIndex + DEFAULT_DEBUG_ADDITION_TO_CUSTOM_Z_INDEX
        : foundWindow.customZIndex;
    }
    windowCMP.updateStyle({ zIndex });
    if (foundWindow.backDropCMP) {
      zIndex -= 2;
      foundWindow.backDropCMP.updateStyle({ zIndex });
    }
    windowCMP.updateClass(styles.collapsed, isCollapsed ? 'add' : 'remove');
    if (hasBackDrop && !foundWindow.backDropCMP) {
      const backDropCMP = createBackDropCMP(
        id,
        backDropClickClosesWindow,
        foundWindow.isDebugWindow,
        customZIndex,
        foundWindow.backDropClass
      );
      hudRoot.add(backDropCMP);
    } else if (hasBackDrop && foundWindow.backDropCMP) {
      hudRoot.add(foundWindow.backDropCMP);
    }
    orderNr += 1;

    // Update content
    if (JSON.stringify(foundWindow.data) !== JSON.stringify(data)) {
      const contentWrapperCMP = foundWindow.windowCMP.children.find(
        (child) => child.id === getContentWrapperId(id)
      );
      if (contentWrapperCMP) {
        contentWrapperCMP.removeChildren();
        const contentFnOrCMP = content || foundWindow.content;
        if (contentFnOrCMP) {
          if (typeof content === 'function') {
            contentWrapperCMP.add(content(data));
          } else {
            contentWrapperCMP.add(content);
          }
        } else {
          const config = getConfig();
          const state = config.draggableWindows ? config.draggableWindows[id] : null;
          if (state?.contentFn) contentWrapperCMP.add(state.contentFn(data));
        }
      }
    }

    // Update heading
    if (headerTitle !== title) {
      headerTitle = title || '';
      const headerTitleCMP = getCmpById(getHeaderTitleId(id));
      headerTitleCMP?.updateText(headerTitle);
    }

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
      data,
      headerTitle,
      isDebugWin,
      vertResizeDisabled,
      horiResizeDisabled,
      disableDragging,
      disableCollapseBtn,
      isCollapsed,
      disableCloseBtn,
      customZIndex,
      winClass
    );
    if (hasBackDrop) {
      const backDropCMP = createBackDropCMP(
        id,
        backDropClickClosesWindow,
        isDebugWin,
        customZIndex,
        bdClass
      );
      hudRoot.add(backDropCMP);
    }
    orderNr += 1;
    hudRoot.add(windowCMP);
  }

  createListeners();

  draggableWindows[id] = {
    ...(draggableWindows[id] || {}),
    id,
    orderNr,
    isActive: true,
    windowCMP,
    content,
    data,
    isOpen: true,
    position,
    size,
    maxSize,
    minSize,
    units: winUnits,
    defaultSize: defaultS,
    defaultPosition: defaultP,
    saveToLS: Boolean(saveToLS !== undefined ? saveToLS : foundWindow?.saveToLS),
    title: headerTitle,
    isDebugWindow: isDebugWin,
    disableVertResize: vertResizeDisabled,
    disableHoriResize: horiResizeDisabled,
    disableDragging: draggingDisabled,
    disableCollapseBtn,
    isCollapsed,
    disableCloseBtn,
    closeOnSceneChange,
    removeOnSceneChange,
    removeOnClose,
    ...(customZIndex !== undefined ? { customZIndex } : {}),
    hasBackDrop,
    backDropClickClosesWindow,
    windowClass: winClass,
    backDropClass: bdClass,
  };

  if (hasBackDrop) {
    const backDropCmp = getCmpById(createBackDropId(id));
    if (backDropCmp) draggableWindows[id].backDropCMP = backDropCmp;
  }
  checkAndSetMaxWindowPosition(draggableWindows[id]);
  saveDraggableWindowStatesToLS();
};

export const closeDraggableWindow = (id: string) => {
  const state = draggableWindows[id];
  if (!state) return;

  if (state.backDropCMP) {
    state.backDropCMP.remove();
    state.backDropCMP = undefined;
  }

  if (state.removeOnClose) {
    removeDraggableWindow(state.id);
    return;
  }

  state.windowCMP.elem.remove();
  state.isOpen = false;
  draggableWindows[id] = state;
  removeListeners();
  saveDraggableWindowStatesToLS();

  if (state.onClose) state.onClose();
};

export const toggleCollapse = (id: string) => {
  const state = draggableWindows[id];
  if (!state || !state.windowCMP) return;

  state.windowCMP.updateClass(
    [styles.collapsed, COLLAPSED_CLASS_NAME],
    state.isCollapsed ? 'remove' : 'add'
  );
  state.isCollapsed = !Boolean(state.isCollapsed);
  saveDraggableWindowStatesToLS();
};

const getHeaderTitleId = (id: string) => `${id}-headerTitle`;
const getContentWrapperId = (id: string) => `${id}-contentWrapper`;

const createWindowCMP = (
  id: string,
  size: { w: number; h: number },
  position: { x: number; y: number },
  maxSize: { w: number; h: number },
  minSize: { w: number; h: number },
  units: OpenDraggableWindowProps['units'],
  content?: OpenDraggableWindowProps['content'],
  data?: OpenDraggableWindowProps['data'],
  title?: string,
  isDebugWindow?: boolean,
  disableVertResize?: boolean,
  disableHoriResize?: boolean,
  disableDragging?: boolean,
  disableCollapseBtn?: boolean,
  isCollapsed?: boolean,
  disableCloseBtn?: boolean,
  customZIndex?: number,
  winClass?: string | string[]
) => {
  // Main wrapper
  let zIndex = isDebugWindow ? DEFAULT_DEBUG_Z_INDEX_ACTIVE : DEFAULT_Z_INDEX_ACTIVE;
  if (customZIndex) {
    zIndex = isDebugWindow ? customZIndex + DEFAULT_DEBUG_ADDITION_TO_CUSTOM_Z_INDEX : customZIndex;
  }
  const windowClassList = [styles.popupWindow, WINDOW_CLASS_NAME];
  if (!disableVertResize) windowClassList.push(styles.vertResizable, RESIZE_VERT_CLASS_NAME);
  if (!disableHoriResize) windowClassList.push(styles.horiResizable, RESIZE_HORI_CLASS_NAME);
  if (!disableDragging) windowClassList.push(styles.draggable, DRAGGABLE_CLASS_NAME);
  if (!disableCollapseBtn) windowClassList.push(COLLAPSABLE_CLASS_NAME);
  if (isCollapsed) windowClassList.push(styles.collapsed, COLLAPSED_CLASS_NAME);
  if (winClass) {
    if (typeof winClass === 'string') {
      windowClassList.push(winClass);
    } else {
      windowClassList.concat(winClass);
    }
  }
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
      zIndex,
    },
    onClick: () => {
      setAllOpenWindowsZIndexInactive();
      windowCMP.updateStyle({ zIndex });

      const state = draggableWindows[id];
      if (!state) return;
      state.isActive = true;
      saveDraggableWindowStatesToLS();
    },
  });

  // Header bar
  const headerBarCMP = CMP({
    tag: 'header',
    class: [styles.headerBar, HEADER_CLASS],
  });
  headerBarCMP.add({
    id: getHeaderTitleId(id),
    tag: 'h3',
    class: styles.title,
    text: title || '',
    style: { userSelect: 'none' },
  });
  if (!disableCollapseBtn) {
    headerBarCMP.add({
      tag: 'button',
      class: [styles.collapseBtn, COLLAPSE_BTN_CLASS_NAME],
      onClick: (e) => {
        e.preventDefault();
        toggleCollapse(id);
      },
    });
  }
  if (!disableCloseBtn) {
    headerBarCMP.add({
      tag: 'button',
      class: [styles.closeBtn, CLOSE_BTN_CLASS_NAME],
      onClick: (e) => {
        e.preventDefault();
        closeDraggableWindow(id);
      },
      attr: { title: 'Close' },
    });
  }
  windowCMP.add(headerBarCMP);

  // Content wrapper
  const contentWrapperCMP = CMP({
    id: getContentWrapperId(id),
    class: [styles.contentWrapper, CONTENT_CONTAINER_CLASS_NAME],
  });
  windowCMP.add(contentWrapperCMP);

  // Resizers
  if (!disableVertResize) {
    windowCMP.add({ class: [styles.vertHandle, VERT_RESIZER_CLASS_NAME] });
  }
  if (!disableHoriResize) {
    windowCMP.add({ class: [styles.horiHandle, HORI_RESIZER_CLASS_NAME] });
  }
  if (!disableVertResize && !disableHoriResize) {
    windowCMP.add({ class: [styles.vertAndHoriHandle, VERT_AND_HORI_RESIZER_CLASS_NAME] });
  }

  // Content
  if (content) {
    if (typeof content === 'function') {
      contentWrapperCMP.add(content(data));
    } else {
      contentWrapperCMP.add(content);
    }
  } else {
    const config = getConfig();
    const state = config.draggableWindows ? config.draggableWindows[id] : null;
    if (state?.contentFn) contentWrapperCMP.add(state.contentFn(data));
  }

  return windowCMP;
};

export const updateDraggableWindow = (id: string) => {
  const state = draggableWindows[id];
  if (!state) return;
  removeDraggableWindow(id);
  openDraggableWindow(state);
  if (!state.isOpen) closeDraggableWindow(id);
};

const createBackDropId = (id: string) => `backdrop-${id}`;

const createBackDropCMP = (
  id: string,
  backDropClickClosesWindow: boolean,
  isDebugWindow?: boolean,
  customZIndex?: number,
  bdClass?: string | string[]
) => {
  let zIndex = isDebugWindow ? DEFAULT_DEBUG_Z_INDEX_ACTIVE : DEFAULT_Z_INDEX_ACTIVE;
  if (customZIndex !== undefined) {
    zIndex = isDebugWindow ? customZIndex + DEFAULT_DEBUG_ADDITION_TO_CUSTOM_Z_INDEX : customZIndex;
  }
  zIndex -= 2; // Make z-index slightly smaller than the window z-index

  const backDropClasses = [styles.backDrop, BACKDROP_CLASS_NAME];
  if (bdClass) {
    if (typeof bdClass === 'string') {
      backDropClasses.push(bdClass);
    } else {
      backDropClasses.concat(bdClass);
    }
  }
  if (backDropClickClosesWindow) backDropClasses.push(BACKDROP_CLOSES_WINDOW_CLASS_NAME);
  const backDropCMP = CMP({
    id: createBackDropId(id),
    class: backDropClasses,
    style: { zIndex },
    ...(backDropClickClosesWindow
      ? {
          onClick: () => closeDraggableWindow(id),
        }
      : {}),
  });

  if (draggableWindows[id]) draggableWindows[id].backDropCMP = backDropCMP;

  return backDropCMP;
};

const saveDraggableWindowStatesToLS = () => {
  const ids = Object.keys(draggableWindows);
  const DO_NOT_SAVE_KEYS = ['windowCMP', 'content', 'backDropCMP', 'onClose'];
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
      if (DO_NOT_SAVE_KEYS.includes(key)) continue;
      saveableState[key] = state[key];
    }
    saveableStates[id] = saveableState;
  }
  if (!Object.keys(saveableStates).length) return;
  lsSetItem(LS_KEY, saveableStates);
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

    const curTargetHasVertClass = target?.classList.contains(VERT_RESIZER_CLASS_NAME);
    if (curTargetHasVertClass) {
      const id = target.parentElement?.id;
      const state = draggableWindows[id || ''];
      const winElem = state?.windowCMP?.elem;
      if (!id || !state || !winElem) return;

      const startHeight = winElem.clientHeight;
      const startPos = e.clientY;
      draggingVertId = id;
      state.windowCMP.updateClass(styles.resizing, 'add');

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        if (!draggingVertId) {
          if (listeners.onMouseMove) {
            window.removeEventListener('mousemove', listeners.onMouseMove, true);
            listeners.onMouseMove = null;
            state.windowCMP.updateClass(styles.resizing, 'remove');
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

    const curTargetHasHoriClass = target?.classList.contains(HORI_RESIZER_CLASS_NAME);
    if (curTargetHasHoriClass) {
      const id = target.parentElement?.id;
      const state = draggableWindows[id || ''];
      const winElem = state?.windowCMP?.elem;
      if (!id || !state || !winElem) return;

      const startWidth = winElem.clientWidth;
      const startPos = e.clientX;
      draggingHoriId = id;
      state.windowCMP.updateClass(styles.resizing, 'add');

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        if (!draggingHoriId) {
          if (listeners.onMouseMove) {
            window.removeEventListener('mousemove', listeners.onMouseMove, true);
            listeners.onMouseMove = null;
            state.windowCMP.updateClass(styles.resizing, 'remove');
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

    const curTargetHasVertAndHoriClass = target?.classList.contains(
      VERT_AND_HORI_RESIZER_CLASS_NAME
    );
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
      state.windowCMP.updateClass(styles.resizing, 'add');

      // Mouse move
      listeners.onMouseMove = listeners.onMouseMove = (e) => {
        if (!draggingHoriId && !draggingVertId) {
          if (listeners.onMouseMove) {
            window.removeEventListener('mousemove', listeners.onMouseMove, true);
            listeners.onMouseMove = null;
            state.windowCMP.updateClass(styles.resizing, 'remove');
          }
          return;
        }
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
      state.windowCMP.updateClass(styles.resizing, 'remove');
      saveDraggableWindowStatesToLS();
    }

    if (draggingHoriId) {
      const state = draggableWindows[draggingHoriId];
      if (!state?.windowCMP) return;
      state.size.w = state.windowCMP.elem.clientWidth;
      state.windowCMP.updateClass(styles.resizing, 'remove');
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

  orderNr = 0;

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
      let zIndex = state.isDebugWindow ? DEFAULT_DEBUG_Z_INDEX : DEFAULT_Z_INDEX;
      if (state.customZIndex) {
        zIndex = state.isDebugWindow
          ? state.customZIndex + DEFAULT_DEBUG_ADDITION_TO_CUSTOM_Z_INDEX
          : state.customZIndex;
      }
      state.windowCMP.updateStyle({ zIndex });
      state.isActive = false;

      if (state.isOpen && state.backDropCMP) {
        zIndex -= 2;
        state.backDropCMP.updateStyle({ zIndex });
      }
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

export const removeDraggableWindow = (id: string) => {
  const state = draggableWindows[id];
  if (!state) return;

  if (state.onClose) state.onClose();

  if (state.windowCMP) state.windowCMP.remove();
  delete draggableWindows[id];
  removeListeners();
  lsSetItem(LS_KEY, draggableWindows);
};

export const handleDraggableWindowsOnSceneChangeStart = () => {
  const keys = Object.keys(draggableWindows);
  for (let i = 0; i < keys.length; i++) {
    const state = draggableWindows[keys[i]];
    if (state.closeOnSceneChange) closeDraggableWindow(state.id);
    if (state.removeOnSceneChange) removeDraggableWindow(state.id);
  }
};

export const loadDraggableWindowStatesFromLS = () => {
  const savedStates = lsGetItem(LS_KEY, draggableWindows);
  draggableWindows = { ...draggableWindows, ...savedStates };

  const draggableWindowsFromConfig = getConfig().draggableWindows || {};

  const keys = Object.keys(draggableWindows).sort((a, b) => {
    const aOrderNr = draggableWindows[a]?.orderNr || 9999;
    const bOrderNr = draggableWindows[b]?.orderNr || 9999;
    if (aOrderNr > bOrderNr) return 1;
    if (aOrderNr < bOrderNr) return -1;
    return 0;
  });
  let activeState: DraggableWindow | null = null;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    if (!draggableWindows[id]) continue;
    if (draggableWindows[id].isOpen && draggableWindows[id].isActive) {
      activeState = draggableWindows[id];
      continue;
    }
    const state = draggableWindowsFromConfig[id] || {};
    draggableWindows[id] = { ...draggableWindows[id], ...state };

    if (draggableWindows[id].isOpen) openDraggableWindow({ id });
  }

  if (activeState) {
    const id = activeState.id;
    const state = draggableWindowsFromConfig[id] || {};
    draggableWindows[id] = { ...draggableWindows[id], ...state };
    openDraggableWindow({ id });
  }
};

export const getDraggableWindow = (id: string) => draggableWindows[id];

export const addOnCloseToWindow = (id: string, onClose: () => void) => {
  if (!draggableWindows[id]) return;
  draggableWindows[id].onClose = onClose;
};
