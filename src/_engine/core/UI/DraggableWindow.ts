import { CMP, TCMP } from '../../utils/CMP';
import { lsGetItem, lsSetItem, StorageValue } from '../../utils/LocalAndSessionStorage';
import { lerror } from '../../utils/Logger';
import { getWindowSize } from '../../utils/Window';
import { getConfig, IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../Config';
import { getHUDRootCMP } from '../HUD';
import { addResizer } from '../MainLoop';
import styles from './DraggableWindow.module.scss';

type Units = 'px' | '%' | 'vw' | 'vh';

export type DraggableWindowData = { [key: string]: unknown };

export type DraggableWindowContent = TCMP | ((data?: DraggableWindowData) => TCMP);

export type DraggableWindowUnits = {
  // Default is 'px'
  /** A non-px position is the window's centre. A draggable window converts it to px (its
   * left/top) when it mounts; a non-draggable one (eg. a dialog) stays CSS-centred. */
  position?: { x?: Units; y?: Units };
  size?: { w?: Units; h?: Units };
  maxSize?: { w?: Units; h?: Units };
  minSize?: { w?: Units; h?: Units };
};

/** The persisted part of a window (LS): serializable values only. */
export type DraggableWindowConfig = {
  id: string;
  title: string;
  data?: DraggableWindowData;
  /** Position (left/top) and size, in `units` (px by default). A draggable window's position is
   * always px. */
  geometry: { x: number; y: number; w: number; h: number };
  minSize: { w: number; h: number };
  /** Without one, the window is at most the viewport's size (100vw × 100vh) */
  maxSize?: { w: number; h: number };
  units?: DraggableWindowUnits;
  /** The window's index in its layer's stack (0 = bottom) */
  orderNr: number;
  isOpen: boolean;
  isCollapsed: boolean;
  saveToLS: boolean;
  isDebugWindow: boolean;
  /** Shows this debug window (`isDebugWindow`) in prodTest mode too (default false, debug
   * windows are debug mode only). The window's content module must then be loaded in prodTest
   * mode as well, ie. with `loadDebugModuleAsync(importer, true)` / `useDebug(ref, true)`,
   * otherwise the window opens without content. */
  showInProdTest: boolean;
  disableVertResize: boolean;
  disableHoriResize: boolean;
  disableDragging: boolean;
  disableCollapseBtn: boolean;
  disableCloseBtn: boolean;
  closeOnSceneChange: boolean;
  removeOnSceneChange: boolean;
  removeOnClose: boolean;
  customZIndex?: number;
  hasBackDrop: boolean;
  backDropClickClosesWindow: boolean;
  windowClass?: string | string[];
  backDropClass?: string | string[];
};

/** A window as seen from outside this module: its config plus its live objects. */
export type DraggableWindow = DraggableWindowConfig & {
  /** Whether the window is on top of its layer (app or debug windows) */
  isActive: boolean;
  /** Only a mounted window has one (not a closed one, or one suspended over a scene change) */
  windowCMP?: TCMP;
  backDropCMP?: TCMP;
  content?: DraggableWindowContent;
  onClose?: () => void;
};

export type OpenDraggableWindowProps = {
  id: string;
  content?: DraggableWindowContent;
  data?: DraggableWindowData;
  isCollapsed?: boolean;
  position?: { x: number; y: number };
  size?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  units?: DraggableWindowUnits;
  resetPosition?: boolean;
  resetSize?: boolean;
  closeIfOpen?: boolean;
  saveToLS?: boolean;
  title?: string;
  isDebugWindow?: boolean;
  /** Shows this debug window (`isDebugWindow`) in prodTest mode too (default false, debug
   * windows are debug mode only). The window's content module must then be loaded in prodTest
   * mode as well, ie. with `loadDebugModuleAsync(importer, true)` / `useDebug(ref, true)`,
   * otherwise the window opens without content. */
  showInProdTest?: boolean;
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
  /** Focuses the first focusable element of the window (its content first, then its header
   * buttons) when it opens. Default true. The engine's own reopens (restoring from LS, rebuilding
   * after a scene change or an update) pass false, so they never steal the focus. */
  focusFirstElement?: boolean;
};

type DragMode = 'MOVE' | 'RESIZE_H' | 'RESIZE_V' | 'RESIZE_HV';

/** The part of the header that can be grabbed (the title, without the buttons), relative to the
 * window's left edge, and the header's height. */
type GrabArea = { left: number; width: number; headerH: number };

/** One pointer drag of a window's header (move) or of one of its resize handles. */
type DragSession = {
  mode: DragMode;
  pointerId: number;
  /** The element that holds the pointer capture */
  target: HTMLElement;
  startPointer: { x: number; y: number };
  startGeometry: { x: number; y: number; w: number; h: number };
  /** MOVE only: the header's title area, which clampToGrabbable keeps on screen */
  grabArea: GrabArea | null;
  /** The latest pointer position, applied at most once per animation frame */
  pointer: { x: number; y: number };
  /** The geometry last written to the DOM */
  geometry: { x: number; y: number; w: number; h: number };
  rafId: number | null;
};

/** The live part of a window: never persisted. */
type DraggableWindowRuntime = {
  content?: DraggableWindowContent;
  onClose?: () => void;
  windowCMP?: TCMP;
  backDropCMP?: TCMP;
  headerCMP?: TCMP;
  titleCMP?: TCMP;
  contentWrapperCMP?: TCMP;
  session: DragSession | null;
  /** The z-index last written, so a restack only writes the windows whose index changed */
  zIndex: number;
};

type WindowEntry = { config: DraggableWindowConfig; runtime: DraggableWindowRuntime };

/** What a window stored in LS can carry: the config, or a pre-p094 state. */
type StoredWindow = Partial<DraggableWindowConfig> & {
  position?: { x: number; y: number };
  size?: { w: number; h: number };
  isActive?: boolean;
};

type Layer = 'APP' | 'DEBUG';

/** Checks whether a window's target (eg. an entity, by the window's `data`) exists in the
 * current scene. Not persisted (functions can't go into LS), so registered next to each window's
 * content function. */
type SceneTargetResolver = (data?: DraggableWindowData) => boolean;

const LS_KEY = 'AEK_popupWindows';
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 320;
const DEFAULT_MIN_WIDTH = 100;
const DEFAULT_MIN_HEIGHT = 120;
/** Each window takes two z levels (its backdrop sits right below it). App windows stay below the
 * engine's loaders (1000), so there is room for about 450 of them. */
const Z_INDEX_BASES: Record<Layer, number> = { APP: 100, DEBUG: 20000 };
const DEBUG_ADDITION_TO_CUSTOM_Z_INDEX = 100;
/** How much of a window's title area a drag keeps horizontally on screen */
const MIN_GRAB_VISIBLE_PX = 80;
const RESIZE_DEBOUNCE_MS = 150;

/** Every known window, open or not. Hydrated from LS on the first access (see getWindows). */
let windows: Map<string, WindowEntry> | null = null;
/** Each layer's open windows, bottom to top. */
const stacks: Record<Layer, string[]> = { APP: [], DEBUG: [] };
/** Content and onClose registered for a window that doesn't exist yet. */
const pendingRuntimes: { [id: string]: Pick<DraggableWindowRuntime, 'content' | 'onClose'> } = {};
const sceneTargetResolvers: { [id: string]: SceneTargetResolver } = {};
/** Windows suspended at a scene change start: torn down but kept open until the scene change end
 * decides whether their target exists in the next scene. */
const suspendedWindowIds = new Set<string>();
let isViewportResizerAdded = false;
let viewportResizeTimer: ReturnType<typeof setTimeout> | null = null;

/** Non-debug (app) windows are always allowed. Debug windows are allowed in debug mode, and in
 * prodTest mode only when they opt in with `showInProdTest`. */
const isDraggableWindowAllowed = (config: { isDebugWindow?: boolean; showInProdTest?: boolean }) =>
  !config.isDebugWindow || IS_DEBUG_ENV || (Boolean(config.showInProdTest) && IS_PROD_TEST_MODE);

// State

const getWindows = () => {
  if (!windows) {
    windows = new Map();
    hydrateFromLS(windows);
  }
  return windows;
};

const createRuntime = (id: string): DraggableWindowRuntime => {
  const pending = pendingRuntimes[id];
  delete pendingRuntimes[id];
  return { content: pending?.content, onClose: pending?.onClose, session: null, zIndex: -1 };
};

/** A full config from partial values: lists every persisted key, so nothing else (runtime
 * objects, pre-p094 keys) ends up in LS. */
const createConfig = (
  id: string,
  v: Partial<DraggableWindowConfig> & Pick<DraggableWindowConfig, 'geometry'>
): DraggableWindowConfig => ({
  id,
  title: v.title || '',
  ...(v.data !== undefined ? { data: v.data } : {}),
  geometry: v.geometry,
  minSize: v.minSize || { w: DEFAULT_MIN_WIDTH, h: DEFAULT_MIN_HEIGHT },
  ...(v.maxSize ? { maxSize: v.maxSize } : {}),
  ...(v.units && Object.keys(v.units).length ? { units: v.units } : {}),
  orderNr: v.orderNr ?? 0,
  isOpen: Boolean(v.isOpen),
  isCollapsed: Boolean(v.isCollapsed),
  saveToLS: Boolean(v.saveToLS),
  isDebugWindow: Boolean(v.isDebugWindow),
  showInProdTest: Boolean(v.showInProdTest),
  disableVertResize: Boolean(v.disableVertResize),
  disableHoriResize: Boolean(v.disableHoriResize),
  disableDragging: Boolean(v.disableDragging),
  disableCollapseBtn: Boolean(v.disableCollapseBtn),
  disableCloseBtn: Boolean(v.disableCloseBtn),
  closeOnSceneChange: Boolean(v.closeOnSceneChange),
  removeOnSceneChange: Boolean(v.removeOnSceneChange),
  removeOnClose: Boolean(v.removeOnClose),
  ...(v.customZIndex !== undefined ? { customZIndex: v.customZIndex } : {}),
  hasBackDrop: Boolean(v.hasBackDrop),
  backDropClickClosesWindow: Boolean(v.backDropClickClosesWindow),
  ...(v.windowClass !== undefined ? { windowClass: v.windowClass } : {}),
  ...(v.backDropClass !== undefined ? { backDropClass: v.backDropClass } : {}),
});

/**
 * Resolves a window's config from the open props and its stored config (live, closed or from
 * LS). One rule set:
 * - Behaviour flags, min/max size and classes: a passed prop wins, then the stored value, then
 *   the default.
 * - Geometry and the collapsed state (the user's layout): the stored value wins, unless
 *   `resetPosition`/`resetSize` is set. Then the prop wins, and the default (centred) comes last.
 * - Units go with their value: a stored position or size keeps its stored units, a passed one
 *   takes the passed units.
 * - Title and `data`: the passed value wins.
 */
const resolveWindowConfig = (
  props: OpenDraggableWindowProps,
  stored?: DraggableWindowConfig
): DraggableWindowConfig => {
  const units: DraggableWindowUnits = {};
  const setUnits = <K extends keyof DraggableWindowUnits>(key: K, u?: DraggableWindowUnits[K]) => {
    if (u) units[key] = u;
  };

  let size: { w: number; h: number };
  if (stored && !props.resetSize) {
    size = { w: stored.geometry.w, h: stored.geometry.h };
    setUnits('size', stored.units?.size);
  } else {
    size = props.size || { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };
    if (props.size) setUnits('size', props.units?.size);
  }

  let position: { x: number; y: number };
  if (stored && !props.resetPosition) {
    position = { x: stored.geometry.x, y: stored.geometry.y };
    setUnits('position', stored.units?.position);
  } else if (props.position) {
    position = props.position;
    setUnits('position', props.units?.position);
  } else {
    // The viewport's centre (converted to px at mount when the window is draggable)
    position = { x: 50, y: 50 };
    setUnits('position', { x: '%', y: '%' });
  }

  const minSize = props.minSize ?? stored?.minSize;
  setUnits('minSize', props.minSize ? props.units?.minSize : stored?.units?.minSize);
  const maxSize = props.maxSize ?? stored?.maxSize;
  // Always stored with its units: LS tells a pre-p094 viewport snapshot apart by the missing units
  if (maxSize) {
    const maxUnits = props.maxSize ? props.units?.maxSize : stored?.units?.maxSize;
    setUnits('maxSize', { w: 'px', h: 'px', ...maxUnits });
  }

  const flag = <K extends keyof OpenDraggableWindowProps & keyof DraggableWindowConfig>(key: K) =>
    props[key] !== undefined ? props[key] : stored?.[key];

  return createConfig(props.id, {
    title: props.title ?? stored?.title,
    data: props.data ?? stored?.data,
    geometry: { ...position, ...size },
    minSize,
    maxSize,
    units,
    orderNr: stored?.orderNr,
    isOpen: true,
    isCollapsed: stored ? stored.isCollapsed : props.isCollapsed,
    saveToLS: flag('saveToLS'),
    isDebugWindow: flag('isDebugWindow'),
    showInProdTest: flag('showInProdTest'),
    disableVertResize: flag('disableVertResize'),
    disableHoriResize: flag('disableHoriResize'),
    disableDragging: flag('disableDragging'),
    disableCollapseBtn: flag('disableCollapseBtn'),
    disableCloseBtn: flag('disableCloseBtn'),
    closeOnSceneChange: flag('closeOnSceneChange'),
    removeOnSceneChange: flag('removeOnSceneChange'),
    removeOnClose: flag('removeOnClose'),
    customZIndex: flag('customZIndex'),
    hasBackDrop: flag('hasBackDrop'),
    backDropClickClosesWindow: flag('backDropClickClosesWindow'),
    windowClass: flag('windowClass'),
    backDropClass: flag('backDropClass'),
  });
};

const toPublicWindow = ({ config, runtime }: WindowEntry): DraggableWindow => ({
  ...config,
  isActive: isDraggableWindowOnTop(config.id),
  windowCMP: runtime.windowCMP,
  backDropCMP: runtime.backDropCMP,
  content: runtime.content,
  onClose: runtime.onClose,
});

// LS

/** Reads LS once. The entries go into the map in their saved stack order, so restoring them in
 * map order rebuilds the stacks. */
const hydrateFromLS = (map: Map<string, WindowEntry>) => {
  const stored = (lsGetItem(LS_KEY, {}) || {}) as { [id: string]: StoredWindow };
  // A pre-p094 state flags its last clicked window instead of saving the stack: restore it last
  const order = (s: StoredWindow) => (s.isActive ? Infinity : s.orderNr ?? 9999);
  const ids = Object.keys(stored).sort((a, b) => order(stored[a]) - order(stored[b]));
  for (let i = 0; i < ids.length; i++) {
    const s = stored[ids[i]];
    if (!s || typeof s !== 'object') continue;
    const geometry = s.geometry || {
      x: s.position?.x ?? 0,
      y: s.position?.y ?? 0,
      w: s.size?.w ?? DEFAULT_WIDTH,
      h: s.size?.h ?? DEFAULT_HEIGHT,
    };
    // A maxSize without units is the viewport snapshot pre-p094 windows took at open: dropped,
    // so the window gets the default (the current viewport)
    const maxSize = s.units?.maxSize ? s.maxSize : undefined;
    map.set(ids[i], {
      config: createConfig(ids[i], { ...s, geometry, maxSize }),
      runtime: createRuntime(ids[i]),
    });
  }
};

/** Writes every `saveToLS` window's config. Called on finished changes only. */
const saveDraggableWindowStatesToLS = () => {
  const saved: { [id: string]: DraggableWindowConfig } = {};
  for (const { config } of getWindows().values()) {
    if (config.saveToLS) saved[config.id] = config;
  }
  lsSetItem(LS_KEY, saved as unknown as StorageValue);
};

// Stacking

const getLayer = (config: DraggableWindowConfig): Layer => (config.isDebugWindow ? 'DEBUG' : 'APP');

const getWindowZIndex = (config: DraggableWindowConfig, index: number) => {
  if (config.customZIndex !== undefined) {
    return config.isDebugWindow
      ? config.customZIndex + DEBUG_ADDITION_TO_CUSTOM_Z_INDEX
      : config.customZIndex;
  }
  return Z_INDEX_BASES[getLayer(config)] + 2 * index;
};

/** Writes the z-index of every window in the stack whose index changed. */
const restack = (stack: string[]) => {
  for (let i = 0; i < stack.length; i++) {
    const entry = getWindows().get(stack[i]);
    if (!entry) continue;
    entry.config.orderNr = i;
    const zIndex = getWindowZIndex(entry.config, i);
    if (entry.runtime.zIndex === zIndex) continue;
    entry.runtime.zIndex = zIndex;
    entry.runtime.windowCMP?.updateStyle({ zIndex });
    entry.runtime.backDropCMP?.updateStyle({ zIndex: zIndex - 1 });
  }
};

const removeFromStacks = (id: string) => {
  const layers = Object.keys(stacks) as Layer[];
  for (let i = 0; i < layers.length; i++) {
    const stack = stacks[layers[i]];
    const index = stack.indexOf(id);
    if (index === -1) continue;
    stack.splice(index, 1);
    restack(stack);
  }
};

/** Puts a window on top of its layer. Returns whether the order changed. */
const moveToTop = (id: string) => {
  const entry = getWindows().get(id);
  if (!entry?.runtime.windowCMP) return false;
  const stack = stacks[getLayer(entry.config)];
  const index = stack.indexOf(id);
  if (index !== -1 && index === stack.length - 1) return false;
  if (index !== -1) {
    stack.splice(index, 1);
  } else {
    removeFromStacks(id);
  }
  stack.push(id);
  restack(stack);
  return true;
};

/**
 * Brings an open window to the front of its layer (app or debug windows).
 * @param id (string) window id
 */
export const bringDraggableWindowToFront = (id: string) => {
  if (moveToTop(id)) saveDraggableWindowStatesToLS();
};

/**
 * Whether the window is on top of its layer (app or debug windows).
 * @param id (string) window id
 */
export const isDraggableWindowOnTop = (id: string) => {
  const entry = getWindows().get(id);
  if (!entry) return false;
  const stack = stacks[getLayer(entry.config)];
  return stack[stack.length - 1] === id;
};

/** The z-index bases of the window layers, and the z-index of each layer's top (active) window. */
export const getDraggableWindowsDefaultZIndexes = () => ({
  defaultZIndex: Z_INDEX_BASES.APP,
  defaultZIndexActive: Z_INDEX_BASES.APP + 2 * Math.max(0, stacks.APP.length - 1),
  defaultDebugZIndex: Z_INDEX_BASES.DEBUG,
  defaultDebugZIndexActive: Z_INDEX_BASES.DEBUG + 2 * Math.max(0, stacks.DEBUG.length - 1),
  defaultDebugAdditionToCustomZIndex: DEBUG_ADDITION_TO_CUSTOM_Z_INDEX,
});

// Geometry

const isNonPx = (unit?: Units) => Boolean(unit && unit !== 'px');

/** A window with a non-px position axis is CSS-centred on that axis (a dialog): it follows a
 * viewport resize without JS, and the clamps leave it alone. */
const isCssCentred = ({ units }: DraggableWindowConfig) =>
  isNonPx(units?.position?.x) || isNonPx(units?.position?.y);

/** A non-px position is the window's centre, so it is translated by half its size. */
const getGeometryStyle = ({ geometry: g, minSize, maxSize, units }: DraggableWindowConfig) => {
  const isCentredX = isNonPx(units?.position?.x);
  const isCentredY = isNonPx(units?.position?.y);
  return {
    left: `${g.x}${units?.position?.x || 'px'}`,
    top: `${g.y}${units?.position?.y || 'px'}`,
    width: `${g.w}${units?.size?.w || 'px'}`,
    height: `${g.h}${units?.size?.h || 'px'}`,
    minWidth: `${minSize.w}${units?.minSize?.w || 'px'}`,
    minHeight: `${minSize.h}${units?.minSize?.h || 'px'}`,
    maxWidth: maxSize ? `${maxSize.w}${units?.maxSize?.w || 'px'}` : '100vw',
    maxHeight: maxSize ? `${maxSize.h}${units?.maxSize?.h || 'px'}` : '100vh',
    transform:
      isCentredX || isCentredY
        ? `translate3d(${isCentredX ? '-50%' : '0'}, ${isCentredY ? '-50%' : '0'}, 0)`
        : null,
  };
};

const writePosition = (elem: HTMLElement, { x, y }: { x: number; y: number }) => {
  elem.style.left = `${x}px`;
  elem.style.top = `${y}px`;
};

/** Converts a mounted draggable window's non-px (centre) position to px left/top, where the CSS
 * centring rendered it, and drops `units.position`. */
const convertPositionToPx = ({ config, runtime }: WindowEntry) => {
  const elem = runtime.windowCMP?.elem;
  if (!elem || config.disableDragging || !isCssCentred(config)) return;
  const rect = elem.getBoundingClientRect();
  config.geometry.x = Math.round(rect.left);
  config.geometry.y = Math.round(rect.top);
  if (config.units) delete config.units.position;
  elem.style.transform = '';
  writePosition(elem, config.geometry);
};

const getGrabArea = ({ windowCMP, headerCMP, titleCMP }: DraggableWindowRuntime): GrabArea => {
  const windowRect = windowCMP?.elem.getBoundingClientRect();
  const titleRect = titleCMP?.elem.getBoundingClientRect();
  return {
    left: windowRect && titleRect ? titleRect.left - windowRect.left : 0,
    width: titleRect?.width || 0,
    headerH: headerCMP?.elem.getBoundingClientRect().height || 0,
  };
};

/** Lets a window hang off an edge, but keeps MIN_GRAB_VISIBLE_PX of its title area horizontally
 * and its whole header vertically on screen, so it can always be grabbed. */
const clampToGrabbable = (pos: { x: number; y: number }, area: GrabArea) => {
  const { width, height } = getWindowSize();
  const grab = Math.min(MIN_GRAB_VISIBLE_PX, area.width);
  // The min bound last: on a viewport too narrow for both, the title's start stays visible
  pos.x = Math.max(grab - area.left - area.width, Math.min(pos.x, width - grab - area.left));
  pos.y = Math.max(0, Math.min(pos.y, height - area.headerH));
};

/**
 * Moves a mounted window fully on screen, per axis: a window that fits is shifted in, a larger
 * one is aligned to the left / top edge. The size never changes. CSS-centred windows are skipped.
 * Returns whether it moved.
 */
const keepOnScreen = ({ config, runtime }: WindowEntry) => {
  const elem = runtime.windowCMP?.elem;
  if (!elem || isCssCentred(config)) return false;
  const { width, height } = getWindowSize();
  const rect = elem.getBoundingClientRect();
  const g = config.geometry;
  const x = rect.width > width ? 0 : Math.max(0, Math.min(g.x, width - rect.width));
  const y = rect.height > height ? 0 : Math.max(0, Math.min(g.y, height - rect.height));
  if (x === g.x && y === g.y) return false;
  g.x = Math.round(x);
  g.y = Math.round(y);
  writePosition(elem, g);
  return true;
};

/** Settles a freshly mounted (or reset) window's position: px for a draggable window, then fully
 * on screen. */
const placeWindow = (entry: WindowEntry) => {
  convertPositionToPx(entry);
  keepOnScreen(entry);
};

const onViewportResized = () => {
  viewportResizeTimer = null;
  let isChanged = false;
  for (const entry of getWindows().values()) {
    if (keepOnScreen(entry)) isChanged = true;
  }
  if (isChanged) saveDraggableWindowStatesToLS();
};

/** Registered at the first mount and kept: a no-op while no window is open. */
const ensureViewportResizer = () => {
  if (isViewportResizerAdded) return;
  isViewportResizerAdded = true;
  addResizer('draggableWindows', () => {
    if (viewportResizeTimer) clearTimeout(viewportResizeTimer);
    viewportResizeTimer = setTimeout(onViewportResized, RESIZE_DEBOUNCE_MS);
  });
};

// Input

const startDragSession = (entry: WindowEntry, mode: DragMode, e: PointerEvent) => {
  const { config, runtime } = entry;
  const windowElem = runtime.windowCMP?.elem;
  if (!windowElem || runtime.session || e.button !== 0 || !e.isPrimary) return;
  if (mode === 'MOVE' && (config.disableDragging || (e.target as Element).closest('button'))) {
    return;
  }

  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const rect = windowElem.getBoundingClientRect();
  const startGeometry = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  runtime.session = {
    mode,
    pointerId: e.pointerId,
    target,
    startPointer: { x: e.clientX, y: e.clientY },
    startGeometry,
    grabArea: mode === 'MOVE' ? getGrabArea(runtime) : null,
    pointer: { x: e.clientX, y: e.clientY },
    geometry: { ...startGeometry },
    rafId: null,
  };
  if (mode !== 'MOVE') runtime.windowCMP?.updateClass(styles.resizing, 'add');
};

const applyDragSession = ({ runtime }: WindowEntry) => {
  const s = runtime.session;
  const elem = runtime.windowCMP?.elem;
  if (!s || !elem) return;
  s.rafId = null;
  const dx = s.pointer.x - s.startPointer.x;
  const dy = s.pointer.y - s.startPointer.y;
  const start = s.startGeometry;
  const g = s.geometry;

  if (s.mode === 'MOVE') {
    g.x = start.x + dx;
    g.y = start.y + dy;
    if (s.grabArea) clampToGrabbable(g, s.grabArea);
    writePosition(elem, g);
    return;
  }
  // The CSS min/max size clamps what is shown, the end of the drag stores that
  if (s.mode !== 'RESIZE_V') {
    g.w = start.w + dx;
    elem.style.width = `${g.w}px`;
  }
  if (s.mode !== 'RESIZE_H') {
    g.h = start.h + dy;
    elem.style.height = `${g.h}px`;
  }
};

const onDragPointerMove = (entry: WindowEntry, e: PointerEvent) => {
  const s = entry.runtime.session;
  if (!s || e.pointerId !== s.pointerId) return;
  s.pointer.x = e.clientX;
  s.pointer.y = e.clientY;
  if (s.rafId === null) s.rafId = requestAnimationFrame(() => applyDragSession(entry));
};

/** Ends the drag and commits the geometry to the config. */
const onDragPointerEnd = (entry: WindowEntry, e: PointerEvent) => {
  const { config, runtime } = entry;
  const s = runtime.session;
  if (!s || e.pointerId !== s.pointerId) return;
  if (s.rafId !== null) {
    cancelAnimationFrame(s.rafId);
    applyDragSession(entry);
  }
  runtime.session = null;
  if (s.target.hasPointerCapture(s.pointerId)) s.target.releasePointerCapture(s.pointerId);

  const g = config.geometry;
  const { x, y } = g;
  if (s.mode === 'MOVE') {
    g.x = Math.round(s.geometry.x);
    g.y = Math.round(s.geometry.y);
  } else {
    runtime.windowCMP?.updateClass(styles.resizing, 'remove');
    const elem = runtime.windowCMP?.elem;
    if (elem) {
      // A resized axis is stored in px from now on, whatever unit it had
      const rect = elem.getBoundingClientRect();
      const sizeUnits = { ...config.units?.size };
      if (s.mode !== 'RESIZE_V') {
        g.w = Math.round(rect.width);
        sizeUnits.w = 'px';
        elem.style.width = `${g.w}px`;
      }
      if (s.mode !== 'RESIZE_H') {
        g.h = Math.round(rect.height);
        sizeUnits.h = 'px';
        elem.style.height = `${g.h}px`;
      }
      config.units = { ...config.units, size: sizeUnits };
    }
  }
  // A resize always saves: its units may have changed even when the numbers didn't
  if (s.mode !== 'MOVE' || g.x !== x || g.y !== y) saveDraggableWindowStatesToLS();
};

/** Drops an unfinished drag without committing it (eg. the window closes mid drag). */
const cancelDragSession = ({ runtime }: WindowEntry) => {
  const s = runtime.session;
  if (!s) return;
  if (s.rafId !== null) cancelAnimationFrame(s.rafId);
  runtime.session = null;
};

const addDragHandle = (entry: WindowEntry, elem: HTMLElement, mode: DragMode) => {
  const onEnd = (e: PointerEvent) => onDragPointerEnd(entry, e);
  elem.addEventListener('pointerdown', (e) => startDragSession(entry, mode, e));
  elem.addEventListener('pointermove', (e) => onDragPointerMove(entry, e));
  elem.addEventListener('pointerup', onEnd);
  elem.addEventListener('pointercancel', onEnd);
};

// DOM

const toClassList = (classes?: string | string[]) =>
  !classes ? [] : typeof classes === 'string' ? [classes] : classes;

const getWindowClasses = (config: DraggableWindowConfig) => {
  const classList = [styles.popupWindow];
  if (!config.disableVertResize) classList.push(styles.vertResizable);
  if (!config.disableHoriResize) classList.push(styles.horiResizable);
  if (!config.disableDragging) classList.push(styles.draggable);
  if (config.isCollapsed) classList.push(styles.collapsed);
  return classList.concat(toClassList(config.windowClass));
};

/** The config keys that change the window's DOM structure: a change remounts the window. */
const STRUCTURAL_KEYS = [
  'isDebugWindow',
  'disableVertResize',
  'disableHoriResize',
  'disableCollapseBtn',
  'disableCloseBtn',
  'hasBackDrop',
  'backDropClickClosesWindow',
  'backDropClass',
] as const;

const hasStructuralChange = (prev: DraggableWindowConfig, next: DraggableWindowConfig) =>
  STRUCTURAL_KEYS.some((key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]));

const buildContent = ({ config, runtime }: WindowEntry) => {
  const { content } = runtime;
  if (typeof content === 'function') return content(config.data);
  if (content) return content;
  return getConfig().draggableWindows?.[config.id]?.contentFn?.(config.data);
};

/** Content passed as a CMP (not a function) outlives the window's DOM: it is detached before the
 * window is torn down, so a reopen can add it back. */
const detachStaticContent = ({ content, contentWrapperCMP }: DraggableWindowRuntime) => {
  if (!content || typeof content === 'function' || !contentWrapperCMP) return;
  contentWrapperCMP.children = contentWrapperCMP.children.filter((child) => child !== content);
  content.elem.remove();
};

const rebuildContent = (entry: WindowEntry) => {
  const wrapper = entry.runtime.contentWrapperCMP;
  if (!wrapper) return;
  detachStaticContent(entry.runtime);
  wrapper.removeChildren();
  const content = buildContent(entry);
  if (content) wrapper.add(content);
};

const createBackDropCMP = (entry: WindowEntry) => {
  const { id, backDropClass, backDropClickClosesWindow } = entry.config;
  return CMP({
    class: [styles.backDrop, ...toClassList(backDropClass)],
    ...(backDropClickClosesWindow ? { onClick: () => closeDraggableWindow(id) } : {}),
  });
};

/** Builds the window's DOM and puts it in its stack: on top, or at its place when it has one (a
 * window suspended over a scene change). */
const mountWindow = (entry: WindowEntry) => {
  const { config, runtime } = entry;
  const { id } = config;
  const hudRoot = getHUDRootCMP();
  ensureViewportResizer();

  if (config.hasBackDrop) runtime.backDropCMP = hudRoot.add(createBackDropCMP(entry));

  const windowCMP = CMP({
    id,
    idAttr: true,
    class: getWindowClasses(config),
    style: getGeometryStyle(config),
  });
  // Capture phase: any press in the window, also one its content stops, brings it to the front
  windowCMP.elem.addEventListener('pointerdown', () => bringDraggableWindowToFront(id), true);

  const headerCMP = windowCMP.add({ tag: 'header', class: styles.headerBar });
  runtime.headerCMP = headerCMP;
  runtime.titleCMP = headerCMP.add({ tag: 'h3', class: styles.title, text: config.title });
  if (!config.disableCollapseBtn) {
    headerCMP.add({
      tag: 'button',
      class: styles.collapseBtn,
      onClick: (e) => {
        e.preventDefault();
        toggleCollapse(id);
      },
      attr: { title: 'Collapse / Expand' },
    });
  }
  if (!config.disableCloseBtn) {
    headerCMP.add({
      tag: 'button',
      class: styles.closeBtn,
      onClick: (e) => {
        e.preventDefault();
        closeDraggableWindow(id);
      },
      attr: { title: 'Close' },
    });
  }
  addDragHandle(entry, headerCMP.elem, 'MOVE');

  runtime.contentWrapperCMP = windowCMP.add({ class: styles.contentWrapper });

  if (!config.disableVertResize) {
    addDragHandle(entry, windowCMP.add({ class: styles.vertHandle }).elem, 'RESIZE_V');
  }
  if (!config.disableHoriResize) {
    addDragHandle(entry, windowCMP.add({ class: styles.horiHandle }).elem, 'RESIZE_H');
  }
  if (!config.disableVertResize && !config.disableHoriResize) {
    addDragHandle(entry, windowCMP.add({ class: styles.vertAndHoriHandle }).elem, 'RESIZE_HV');
  }

  const content = buildContent(entry);
  if (content) runtime.contentWrapperCMP.add(content);

  runtime.windowCMP = hudRoot.add(windowCMP);
  runtime.zIndex = -1;
  const stack = stacks[getLayer(config)];
  if (!stack.includes(id)) {
    removeFromStacks(id);
    stack.push(id);
  }
  restack(stack);
};

/** Applies a reopen's changes to a mounted window. The content is rebuilt when `data` changed. */
const updateMountedWindow = (entry: WindowEntry, prev: DraggableWindowConfig) => {
  const { config, runtime } = entry;
  runtime.windowCMP?.updateClass(getWindowClasses(config), 'replace');
  runtime.windowCMP?.updateStyle(getGeometryStyle(config));
  if (config.title !== prev.title) runtime.titleCMP?.updateText(config.title);
  if (JSON.stringify(config.data) !== JSON.stringify(prev.data)) rebuildContent(entry);
};

/** Tears the window's DOM and content down (running the content's own teardown, eg. disposing
 * panes and clearing intervals). The config stays. */
const unmountWindow = (entry: WindowEntry, keepInStack?: boolean) => {
  const { runtime } = entry;
  cancelDragSession(entry);
  detachStaticContent(runtime);
  runtime.backDropCMP?.remove();
  runtime.windowCMP?.remove();
  runtime.backDropCMP = undefined;
  runtime.windowCMP = undefined;
  runtime.headerCMP = undefined;
  runtime.titleCMP = undefined;
  runtime.contentWrapperCMP = undefined;
  runtime.zIndex = -1;
  if (!keepInStack) removeFromStacks(entry.config.id);
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The first rendered (not hidden, eg. in a collapsed folder) focusable element in `root`. */
const getFirstFocusable = (root?: Element) => {
  if (!root) return null;
  const candidates = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].getClientRects().length) return candidates[i];
  }
  return null;
};

/** Focuses the window's first focusable content element, else its first header button. */
const focusFirstFocusableElement = ({ runtime }: WindowEntry) => {
  const target =
    getFirstFocusable(runtime.contentWrapperCMP?.elem) ||
    getFirstFocusable(runtime.windowCMP?.elem);
  target?.focus({ preventScroll: true });
};

// Public API

export const openDraggableWindow = (props: OpenDraggableWindowProps) => {
  const { id, focusFirstElement = true } = props;
  if (!id) {
    const msg = 'Draggable window has to have an id (in openDraggableWindow).';
    lerror(msg);
    throw new Error(msg);
  }

  const map = getWindows();
  let entry = map.get(id);
  const config = resolveWindowConfig(props, entry?.config);
  // Also gates the content: every path that builds a window's content goes through here
  if (!isDraggableWindowAllowed(config)) return;
  suspendedWindowIds.delete(id);

  if (props.closeIfOpen && entry?.config.isOpen && entry.runtime.windowCMP) {
    if (props.onClose) entry.runtime.onClose = props.onClose;
    closeDraggableWindow(id);
    return;
  }

  if (!entry) {
    entry = { config, runtime: createRuntime(id) };
    map.set(id, entry);
  }
  const prev = entry.config;
  // Kept on the same entry object: the window's listeners hold it
  entry.config = config;
  if (props.content) entry.runtime.content = props.content;
  if (props.onClose) entry.runtime.onClose = props.onClose;

  // A live window keeps its place (it may hang off an edge on purpose), unless the open resets it
  let shouldPlace = Boolean(props.resetPosition || props.resetSize);
  if (entry.runtime.windowCMP && !hasStructuralChange(prev, config)) {
    updateMountedWindow(entry, prev);
  } else {
    if (entry.runtime.windowCMP) unmountWindow(entry);
    mountWindow(entry);
    shouldPlace = true;
  }
  if (shouldPlace) placeWindow(entry);
  moveToTop(id);
  saveDraggableWindowStatesToLS();
  if (focusFirstElement) focusFirstFocusableElement(entry);
};

export const closeDraggableWindow = (id: string) => {
  const entry = getWindows().get(id);
  if (!entry) return;
  suspendedWindowIds.delete(id);

  if (entry.config.removeOnClose) {
    removeDraggableWindow(id);
    return;
  }

  unmountWindow(entry);
  entry.config.isOpen = false;
  saveDraggableWindowStatesToLS();
  entry.runtime.onClose?.();
};

export const closeAllDraggableWindowsStartingWith = (startingWithId: string) => {
  const ids = [...getWindows().keys()];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].startsWith(startingWithId)) closeDraggableWindow(ids[i]);
  }
};

export const toggleCollapse = (id: string) => {
  const entry = getWindows().get(id);
  if (!entry?.runtime.windowCMP) return;
  entry.config.isCollapsed = !entry.config.isCollapsed;
  entry.runtime.windowCMP.updateClass(
    styles.collapsed,
    entry.config.isCollapsed ? 'add' : 'remove'
  );
  saveDraggableWindowStatesToLS();
};

/** Rebuilds an open window's content (its `onClose` doesn't run). */
export const updateDraggableWindow = (id: string) => {
  const entry = getWindows().get(id);
  // A suspended window has no DOM: it is rebuilt (or closed) at the scene change end
  if (!entry?.config.isOpen || !entry.runtime.windowCMP) return;
  rebuildContent(entry);
};

export const removeDraggableWindow = (id: string, doNotSaveToLS?: boolean) => {
  const map = getWindows();
  const entry = map.get(id);
  if (!entry) return;
  suspendedWindowIds.delete(id);

  unmountWindow(entry);
  map.delete(id);
  if (!doNotSaveToLS) saveDraggableWindowStatesToLS();
  entry.runtime.onClose?.();
};

const resolveSceneTarget = ({ config }: WindowEntry) => {
  const resolver = sceneTargetResolvers[config.id];
  if (!resolver) return false;
  try {
    return resolver(config.data);
  } catch {
    return false;
  }
};

/**
 * Handles the windows at a scene change start: removes the windows flagged `removeOnSceneChange`
 * and closes the ones flagged `closeOnSceneChange`, except the ones with a scene target resolver:
 * those are suspended until {@link handleDraggableWindowsOnSceneChangeEnd}.
 */
export const handleDraggableWindowsOnSceneChangeStart = () => {
  const entries = [...getWindows().values()];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { config } = entry;
    // Never opened in this mode: kept as is, so it comes back in the mode that allows it
    if (!isDraggableWindowAllowed(config)) continue;
    if (config.removeOnSceneChange) {
      removeDraggableWindow(config.id);
      continue;
    }
    if (!config.closeOnSceneChange || !config.isOpen) continue;
    if (sceneTargetResolvers[config.id]) {
      // Torn down rather than kept live, so no content refresh runs against the entities that
      // are being torn down. It keeps its place in the stack.
      unmountWindow(entry, true);
      suspendedWindowIds.add(config.id);
    } else {
      closeDraggableWindow(config.id);
    }
  }
};

/**
 * Handles the windows suspended at the scene change start: rebuilds the ones whose target exists
 * in the next scene and closes the rest. Call once the next scene's entities exist (after the
 * scene enter hooks).
 * @param loadFailed (boolean) optional, closes every suspended window (the scene failed to load)
 */
export const handleDraggableWindowsOnSceneChangeEnd = (loadFailed?: boolean) => {
  const ids = [...suspendedWindowIds];
  suspendedWindowIds.clear();
  for (let i = 0; i < ids.length; i++) {
    const entry = getWindows().get(ids[i]);
    if (!entry) continue;
    if (!loadFailed && resolveSceneTarget(entry)) {
      mountWindow(entry);
      placeWindow(entry);
    } else {
      closeDraggableWindow(entry.config.id);
    }
  }
  saveDraggableWindowStatesToLS();
};

/** Opens the windows that were open at the last save, in their saved stack order. */
export const loadDraggableWindowStatesFromLS = () => {
  const entries = [...getWindows().values()];
  for (let i = 0; i < entries.length; i++) {
    const { config, runtime } = entries[i];
    if (!config.isOpen || runtime.windowCMP) continue;
    // Not shown in this mode, but isOpen is kept, so it comes back in the mode that allows it
    // (eg. back in debug mode from prodTest mode)
    if (!isDraggableWindowAllowed(config)) continue;
    // Reloaded into a scene without the window's target: close it instead of showing "not found"
    if (sceneTargetResolvers[config.id] && !resolveSceneTarget(entries[i])) {
      config.isOpen = false;
      continue;
    }
    openDraggableWindow({ id: config.id, focusFirstElement: false });
  }
  saveDraggableWindowStatesToLS();
};

export const getDraggableWindow = (id: string): DraggableWindow | undefined => {
  const entry = getWindows().get(id);
  return entry ? toPublicWindow(entry) : undefined;
};

export const getDraggableWindowsStartingWith = (startingWithId: string) => {
  const result: DraggableWindow[] = [];
  for (const entry of getWindows().values()) {
    if (entry.config.id.startsWith(startingWithId)) result.push(toPublicWindow(entry));
  }
  return result;
};

export const addOnCloseToWindow = (id: string, onClose: () => void) => {
  const entry = getWindows().get(id);
  if (entry) entry.runtime.onClose = onClose;
};

export const registerDraggableWindowCmp = (
  id: string,
  fn: { content?: DraggableWindowContent; onClose?: () => void }
) => {
  const entry = getWindows().get(id);
  if (!entry) {
    pendingRuntimes[id] = fn;
    return;
  }
  if (fn.content) entry.runtime.content = fn.content;
  if (fn.onClose) entry.runtime.onClose = fn.onClose;
  if (entry.config.isOpen) updateDraggableWindow(id);
};

/**
 * Registers a scene target resolver for a window flagged `closeOnSceneChange`: on a scene change
 * the window stays open (rebuilt for the next scene) when the resolver returns true for the
 * window's `data`, and closes otherwise. It is also checked when restoring the window on reload.
 * @param id (string) window id
 * @param resolver ((data) => boolean) whether the window's target exists in the current scene
 */
export const registerDraggableWindowSceneTargetResolver = (
  id: string,
  resolver: SceneTargetResolver
) => {
  sceneTargetResolvers[id] = resolver;
};

export const registerDraggableWindowContentFn = (
  id: string,
  registerContentFn: (data?: DraggableWindowData) => TCMP
) => {
  const config = getConfig();
  if (!config.draggableWindows) config.draggableWindows = {};
  config.draggableWindows[id] = { contentFn: registerContentFn };
};
