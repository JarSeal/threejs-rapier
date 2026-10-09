import type { TCMP } from '../../utils/CMP';
import { CMP } from '../../utils/CMP';
import type { StorageValue } from '../../utils/LocalAndSessionStorage';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lerror } from '../../utils/Logger';
import { getWindowSize } from '../../utils/Window';
import { getConfig, IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../Config';
import { getHUDRootCMP, KEEP_IN_VIEWS_CLASS } from '../HUD';
import { addResizer } from '../MainLoop';
import styles from './DraggableWindow.module.scss';
import { getSvgIcon, type SvgIconKey } from './icons/SvgIcon';

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
  /** The window's kind (see {@link OpenDraggableWindowProps.kind}). Without one, the window's
   * kind is its id. */
  kind?: string;
  title: string;
  /** An icon before the title in the header */
  icon?: SvgIconKey;
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
  /**
   * Makes this one of several windows of a kind (eg. one edit window per entity), with the id
   * `getKindWindowId(kind, key)`. The content function and scene target resolver registered for
   * the kind cover each of its windows. A new window of the kind starts from where the kind's
   * last window was dragged, resized or closed, cascaded by the kind's open windows. Closing it
   * removes it. Without a kind, the window's kind is its id.
   */
  kind?: string;
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
  /** An icon before the title in the header */
  icon?: SvgIconKey;
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

/** Where a kind's next window starts: the last geometry of one of its windows. */
type KindGeometry = {
  geometry: DraggableWindowConfig['geometry'];
  units?: Pick<DraggableWindowUnits, 'position' | 'size'>;
  saveToLS: boolean;
};

/** What every window of a kind (or every open of a single window) shares: the functions LS can't
 * hold. */
export type DraggableWindowKindOpts = {
  /** Builds a window's content from its `data`, for the opens without `content` (eg. the restore
   * from LS after a reload) */
  content?: (data?: DraggableWindowData) => TCMP;
  /** Runs after a window of the kind closes (or is removed), unless the window has its own */
  onClose?: (id: string) => void;
  /** See {@link registerDraggableWindowSceneTargetResolver} */
  sceneTargetResolver?: SceneTargetResolver;
  /** Keeps the kind's windows visible in editor views (ViewManager.ts), which hide the other
   * windows with the rest of the suspended scene's HUD. Debug dialogs (`isDebugWindow` with a
   * backdrop) are always kept. */
  keepInViews?: boolean;
};

type Layer = 'APP' | 'DEBUG';

/** Checks whether a window's target (eg. an entity, by the window's `data`) exists in the
 * current scene. Not persisted (functions can't go into LS), so registered next to each window's
 * content function. */
type SceneTargetResolver = (data?: DraggableWindowData) => boolean;

const LS_KEY = 'AEK_popupWindows';
/** The kinds' geometries, in the same LS object as the windows */
const LS_KIND_GEOMETRY_KEY = '__kindGeometry';
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
/** The gap a fit keeps from the viewport's edges */
const FIT_MARGIN_PX = 8;

/** Every known window, open or not. Hydrated from LS on the first access (see getWindows). */
let windows: Map<string, WindowEntry> | null = null;
/** Each layer's open windows, bottom to top. */
const stacks: Record<Layer, string[]> = { APP: [], DEBUG: [] };
/** Content and onClose registered for a window that doesn't exist yet. */
const pendingRuntimes: { [id: string]: Pick<DraggableWindowRuntime, 'content' | 'onClose'> } = {};
/** Keyed by kind (a window's kind, or its id when it has none) */
const sceneTargetResolvers: { [kind: string]: SceneTargetResolver } = {};
const registeredKinds = new Set<string>();
const kindOnCloses: { [kind: string]: (id: string) => void } = {};
const keepInViewsKinds = new Set<string>();
const kindGeometry: { [kind: string]: KindGeometry } = {};
/** Windows suspended at a scene change start: torn down but kept open until the scene change end
 * decides whether their target exists in the next scene. */
const suspendedWindowIds = new Set<string>();
let isViewportResizerAdded = false;
let viewportResizeTimer: ReturnType<typeof setTimeout> | null = null;

/** Non-debug (app) windows are always allowed. Debug windows are allowed in debug mode, and in
 * prodTest mode only when they opt in with `showInProdTest`. */
const isDraggableWindowAllowed = (config: { isDebugWindow?: boolean; showInProdTest?: boolean }) =>
  !config.isDebugWindow || IS_DEBUG_ENV || (Boolean(config.showInProdTest) && IS_PROD_TEST_MODE);

/** A window's kind: its `kind`, else its id. The kind registries are keyed by it. */
const getWindowKind = (config: DraggableWindowConfig) => config.kind ?? config.id;

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
  ...(v.kind ? { kind: v.kind } : {}),
  title: v.title || '',
  ...(v.icon ? { icon: v.icon } : {}),
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
 *   A new window of a kind takes the kind's geometry as its stored geometry.
 * - Units go with their value: a stored position or size keeps its stored units, a passed one
 *   takes the passed units.
 * - Title and `data`: the passed value wins.
 */
const resolveWindowConfig = (
  props: OpenDraggableWindowProps,
  stored?: DraggableWindowConfig,
  storedKindGeometry?: KindGeometry
): DraggableWindowConfig => {
  const layout = stored ?? storedKindGeometry;
  const units: DraggableWindowUnits = {};
  const setUnits = <K extends keyof DraggableWindowUnits>(key: K, u?: DraggableWindowUnits[K]) => {
    if (u) units[key] = u;
  };

  let size: { w: number; h: number };
  if (layout && !props.resetSize) {
    size = { w: layout.geometry.w, h: layout.geometry.h };
    setUnits('size', layout.units?.size);
  } else {
    size = props.size || { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };
    if (props.size) setUnits('size', props.units?.size);
  }

  let position: { x: number; y: number };
  if (layout && !props.resetPosition) {
    position = { x: layout.geometry.x, y: layout.geometry.y };
    setUnits('position', layout.units?.position);
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
    kind: props.kind ?? stored?.kind,
    title: props.title ?? stored?.title,
    icon: props.icon ?? stored?.icon,
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

/** Runs the window's own onClose, else its kind's. */
const runOnClose = ({ config, runtime }: WindowEntry) => {
  if (runtime.onClose) {
    runtime.onClose();
    return;
  }
  kindOnCloses[getWindowKind(config)]?.(config.id);
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
  const { [LS_KIND_GEOMETRY_KEY]: storedKindGeometry, ...stored } = (lsGetItem(LS_KEY, {}) ||
    {}) as { [id: string]: StoredWindow } & { [LS_KIND_GEOMETRY_KEY]?: typeof kindGeometry };
  if (storedKindGeometry && typeof storedKindGeometry === 'object') {
    Object.assign(kindGeometry, storedKindGeometry);
  }
  // A pre-p094 state flags its last clicked window instead of saving the stack: restore it last
  const order = (s: StoredWindow) => (s.isActive ? Infinity : s.orderNr ?? 9999);
  const ids = Object.keys(stored).sort((a, b) => order(stored[a]) - order(stored[b]));
  for (let i = 0; i < ids.length; i++) {
    const s = stored[ids[i]];
    if (!s || typeof s !== 'object') continue;
    // Closing a kind window removes it, so a closed one is a leftover
    if (s.kind && !s.isOpen) continue;
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
  const saved: { [id: string]: unknown } = {};
  for (const { config } of getWindows().values()) {
    if (config.saveToLS) saved[config.id] = config;
  }
  const kinds = Object.keys(kindGeometry).filter((kind) => kindGeometry[kind].saveToLS);
  if (kinds.length) {
    saved[LS_KIND_GEOMETRY_KEY] = Object.fromEntries(kinds.map((k) => [k, kindGeometry[k]]));
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

/** Whether the fit actions apply to the window: an open, mounted, draggable one (never a dialog). */
const isFittable = ({ config, runtime }: WindowEntry) =>
  config.isOpen && Boolean(runtime.windowCMP) && !config.disableDragging && !isCssCentred(config);

/** The cascade step's offset (x and y), wrapping before it passes a third of the viewport. */
const getCascadeOffset = (cascadeIndex: number, headerH: number) => {
  if (!headerH || cascadeIndex <= 0) return 0;
  const { width, height } = getWindowSize();
  const steps = Math.floor(Math.min(width, height) / 3 / headerH) + 1;
  return (cascadeIndex % steps) * headerH;
};

/**
 * Moves a fittable window to the top center (plus the cascade offset), shrinks a resizable axis
 * that overflows (the CSS min size wins), and falls back to keepOnScreen for what still overflows.
 * A collapsed window fits its expanded size. Returns whether the geometry changed.
 */
const fitWindow = (entry: WindowEntry, cascadeIndex: number) => {
  const { config, runtime } = entry;
  const elem = runtime.windowCMP?.elem;
  if (!elem || !isFittable(entry)) return false;
  const { width, height } = getWindowSize();
  const offset = getCascadeOffset(cascadeIndex, runtime.headerCMP?.elem.offsetHeight || 0);
  const g = config.geometry;
  const prev = JSON.stringify([g, config.units?.size]);

  // Measured expanded and without the height transition, so the reads are the final size
  elem.classList.add(styles.resizing);
  if (config.isCollapsed) elem.classList.remove(styles.collapsed);

  let rect = elem.getBoundingClientRect();
  const sizeUnits = { ...config.units?.size };
  const maxW = width - 2 * FIT_MARGIN_PX;
  const maxH = height - 2 * FIT_MARGIN_PX - offset;
  const shrinkW = rect.width > maxW && !config.disableHoriResize;
  const shrinkH = rect.height > maxH && !config.disableVertResize;
  if (shrinkW) elem.style.width = `${Math.max(0, maxW)}px`;
  if (shrinkH) elem.style.height = `${Math.max(0, maxH)}px`;
  if (shrinkW || shrinkH) {
    rect = elem.getBoundingClientRect();
    // A shrunk axis is stored in px from now on, like a manual resize
    if (shrinkW) {
      g.w = Math.round(rect.width);
      sizeUnits.w = 'px';
      elem.style.width = `${g.w}px`;
    }
    if (shrinkH) {
      g.h = Math.round(rect.height);
      sizeUnits.h = 'px';
      elem.style.height = `${g.h}px`;
    }
    config.units = { ...config.units, size: sizeUnits };
  }

  // The right edge stays inside the margin, so a wide window gives up its x offset
  const x = Math.min((width - rect.width) / 2 + offset, width - FIT_MARGIN_PX - rect.width);
  g.x = Math.round(Math.max(FIT_MARGIN_PX, x));
  g.y = Math.round(FIT_MARGIN_PX + offset);
  writePosition(elem, g);
  keepOnScreen(entry);

  if (config.isCollapsed) {
    elem.classList.add(styles.collapsed);
    // Flushes the collapsed height before the transition comes back, so it doesn't animate
    void elem.offsetHeight;
  }
  elem.classList.remove(styles.resizing);
  return JSON.stringify([g, config.units?.size]) !== prev;
};

/** Settles a freshly mounted (or reset) window's position: px for a draggable window, offset by
 * `cascadeIndex` header heights (a new window of a kind), then fully on screen. */
const placeWindow = (entry: WindowEntry, cascadeIndex = 0) => {
  convertPositionToPx(entry);
  const elem = entry.runtime.windowCMP?.elem;
  if (elem && cascadeIndex && !isCssCentred(entry.config)) {
    const offset = getCascadeOffset(cascadeIndex, entry.runtime.headerCMP?.elem.offsetHeight || 0);
    entry.config.geometry.x += offset;
    entry.config.geometry.y += offset;
    writePosition(elem, entry.config.geometry);
  }
  keepOnScreen(entry);
};

// Kinds

/** Stores a kind window's geometry as where the kind's next window starts. */
const recordKindGeometry = ({ config }: WindowEntry) => {
  if (!config.kind) return;
  const units: KindGeometry['units'] = {};
  if (config.units?.position) units.position = config.units.position;
  if (config.units?.size) units.size = config.units.size;
  kindGeometry[config.kind] = {
    geometry: { ...config.geometry },
    ...(Object.keys(units).length ? { units } : {}),
    saveToLS: config.saveToLS,
  };
};

const getOpenWindowsOfKind = (kind: string) => {
  const result: WindowEntry[] = [];
  for (const entry of getWindows().values()) {
    if (entry.config.isOpen && getWindowKind(entry.config) === kind) result.push(entry);
  }
  return result;
};

/** Brings a kind's stored windows into the kind: the pre-kind window whose id is the kind (a
 * window that used to be the kind's only one) seeds the kind's geometry and is dropped, and a
 * window without a kind whose id is a `getKindWindowId(kind, key)` id gets the kind. */
const adoptKind = (kind: string) => {
  const map = getWindows();
  let isChanged = false;
  const legacy = map.get(kind);
  if (legacy && !legacy.config.kind) {
    if (!kindGeometry[kind]) {
      recordKindGeometry({ ...legacy, config: { ...legacy.config, kind } });
    }
    unmountWindow(legacy);
    suspendedWindowIds.delete(kind);
    map.delete(kind);
    isChanged = true;
  }
  const prefix = `${kind}_`;
  for (const { config } of map.values()) {
    if (config.kind || !config.id.startsWith(prefix)) continue;
    config.kind = kind;
    isChanged = true;
  }
  if (isChanged) saveDraggableWindowStatesToLS();
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
  if (s.mode !== 'MOVE' || g.x !== x || g.y !== y) {
    recordKindGeometry(entry);
    saveDraggableWindowStatesToLS();
  }
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

/** Whether the window (and its backdrop) stays visible in editor views: a debug dialog, or a
 * window of a kind registered with `keepInViews`. */
const isKeptInViews = (config: DraggableWindowConfig) =>
  (config.isDebugWindow && config.hasBackDrop) || keepInViewsKinds.has(getWindowKind(config));

const getWindowClasses = (config: DraggableWindowConfig) => {
  const classList = [styles.popupWindow];
  if (!config.disableVertResize) classList.push(styles.vertResizable);
  if (!config.disableHoriResize) classList.push(styles.horiResizable);
  if (!config.disableDragging) classList.push(styles.draggable);
  if (config.isCollapsed) classList.push(styles.collapsed);
  if (isKeptInViews(config)) classList.push(KEEP_IN_VIEWS_CLASS);
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
  return getConfig().draggableWindows?.[getWindowKind(config)]?.contentFn?.(config.data);
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
    class: [
      styles.backDrop,
      ...(isKeptInViews(entry.config) ? [KEEP_IN_VIEWS_CLASS] : []),
      ...toClassList(backDropClass),
    ],
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
  renderTitle(runtime.titleCMP, config);
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
  headerCMP.elem.addEventListener('dblclick', (e) => {
    if (!(e.target as Element).closest('button')) fitDraggableWindowToScreen(id);
  });

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

/** The header title: the icon (if any) and the title text. */
const renderTitle = (titleCMP: TCMP, config: DraggableWindowConfig) => {
  titleCMP.updateText(config.title);
  if (config.icon) titleCMP.elem.insertAdjacentHTML('afterbegin', getSvgIcon(config.icon, 'small'));
};

/** Applies a reopen's changes to a mounted window. The content is rebuilt when `data` changed. */
const updateMountedWindow = (entry: WindowEntry, prev: DraggableWindowConfig) => {
  const { config, runtime } = entry;
  runtime.windowCMP?.updateClass(getWindowClasses(config), 'replace');
  runtime.windowCMP?.updateStyle(getGeometryStyle(config));
  if ((config.title !== prev.title || config.icon !== prev.icon) && runtime.titleCMP) {
    renderTitle(runtime.titleCMP, config);
  }
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

  if (props.kind) registerDraggableWindowKind(props.kind);
  const map = getWindows();
  let entry = map.get(id);
  const isNew = !entry;
  const kind = props.kind ?? entry?.config.kind;
  const config = resolveWindowConfig(props, entry?.config, kind ? kindGeometry[kind] : undefined);
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
  // A new window of a kind cascades from the kind's geometry by the kind's other open windows
  const cascadeIndex = isNew && config.kind ? getOpenWindowsOfKind(config.kind).length - 1 : 0;
  if (shouldPlace) placeWindow(entry, cascadeIndex);
  moveToTop(id);
  saveDraggableWindowStatesToLS();
  if (focusFirstElement) focusFirstFocusableElement(entry);
};

export const closeDraggableWindow = (id: string) => {
  const entry = getWindows().get(id);
  if (!entry) return;
  suspendedWindowIds.delete(id);

  // A kind window is removed (its geometry stays as the kind's), so closed ones don't pile up
  if (entry.config.removeOnClose || entry.config.kind) {
    removeDraggableWindow(id);
    return;
  }

  unmountWindow(entry);
  entry.config.isOpen = false;
  saveDraggableWindowStatesToLS();
  runOnClose(entry);
};

/** @deprecated Use window kinds: close each of {@link getDraggableWindowsOfKind}'s windows. */
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

/**
 * Moves an open draggable window to the top center of the screen, and shrinks a resizable one
 * that still overflows (never below its min size). A collapsed window fits its expanded size.
 * Dialogs and other non-draggable windows are skipped. Header double-clicks call this.
 * @param id (string) window id
 * @param cascadeIndex (number) optional, offsets the window by this many header heights (x and y),
 * wrapping before the offset passes a third of the viewport
 * @returns whether the window was fitted (false when it is closed or not draggable)
 */
export const fitDraggableWindowToScreen = (id: string, cascadeIndex = 0) => {
  const entry = getWindows().get(id);
  if (!entry || !isFittable(entry)) return false;
  if (fitWindow(entry, cascadeIndex)) saveDraggableWindowStatesToLS();
  return true;
};

/**
 * Fits every open draggable window to the screen (see {@link fitDraggableWindowToScreen}),
 * cascaded bottom to top over the app windows and then the debug windows, so the top window
 * lands last and every header stays visible.
 * @returns the number of windows fitted
 */
export const fitAllDraggableWindowsToScreen = () => {
  const ids = [...stacks.APP, ...stacks.DEBUG];
  let count = 0;
  let isChanged = false;
  for (let i = 0; i < ids.length; i++) {
    const entry = getWindows().get(ids[i]);
    if (!entry || !isFittable(entry)) continue;
    if (fitWindow(entry, count)) isChanged = true;
    count++;
  }
  if (isChanged) saveDraggableWindowStatesToLS();
  return count;
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

  if (entry.config.isOpen) recordKindGeometry(entry);
  unmountWindow(entry);
  map.delete(id);
  if (!doNotSaveToLS) saveDraggableWindowStatesToLS();
  runOnClose(entry);
};

const resolveSceneTarget = ({ config }: WindowEntry) => {
  const resolver = sceneTargetResolvers[getWindowKind(config)];
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
    // Open but neither mounted nor suspended: stored in LS and not restored yet (the boot's first
    // scene load runs before loadDraggableWindowStatesFromLS), so the restore handles it
    if (config.isOpen && !entry.runtime.windowCMP && !suspendedWindowIds.has(config.id)) continue;
    if (config.removeOnSceneChange) {
      removeDraggableWindow(config.id);
      continue;
    }
    if (!config.closeOnSceneChange || !config.isOpen) continue;
    if (sceneTargetResolvers[getWindowKind(config)]) {
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
    // (a kind window is removed, like any closed kind window)
    if (sceneTargetResolvers[getWindowKind(config)] && !resolveSceneTarget(entries[i])) {
      if (config.kind) {
        removeDraggableWindow(config.id, true);
      } else {
        config.isOpen = false;
      }
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

/**
 * The id of a kind's window for one key (eg. an entity id): `${kind}_${key}`.
 * @param kind (string) the window kind
 * @param key (string | number) what the window is for, unique in the kind
 */
export const getKindWindowId = (kind: string, key: string | number) => `${kind}_${key}`;

/**
 * Registers a window kind (see {@link OpenDraggableWindowProps.kind}) and what its windows share:
 * their content function, onClose and scene target resolver. Call it once at module load (before
 * the engine restores the windows from LS), and every window of the kind, also one restored after
 * a reload, gets them without any per-window registration. Opening a window with a `kind` also
 * registers the kind (without options).
 *
 * The first registration brings the kind's stored windows in: the window whose id is the kind
 * (from before the kind existed) only seeds the kind's geometry and is dropped, and a window
 * without a kind whose id is `getKindWindowId(kind, key)` gets the kind. So a single window uses
 * {@link registerDraggableWindow} (keyed by its id), not this.
 * @param kind (string) the window kind
 * @param opts ({@link DraggableWindowKindOpts}) optional, a later registration replaces the
 * options it passes
 */
export const registerDraggableWindowKind = (kind: string, opts?: DraggableWindowKindOpts) => {
  if (opts) registerDraggableWindow(kind, opts);
  if (registeredKinds.has(kind)) return;
  registeredKinds.add(kind);
  adoptKind(kind);
};

/**
 * Registers what a single window (one without a kind) gets on every open, also one restored after
 * a reload: its content function, onClose and scene target resolver (the functions LS can't
 * hold). Call it once at module load, before the engine restores the windows from LS. The
 * window's own `content`/`onClose` passed on an open win. For several windows of a kind, see
 * {@link registerDraggableWindowKind}.
 * @param id (string) window id
 * @param opts ({@link DraggableWindowKindOpts}) a later registration replaces the options it
 * passes
 */
export const registerDraggableWindow = (id: string, opts: DraggableWindowKindOpts) => {
  if (opts.content) setContentFn(id, opts.content);
  if (opts.sceneTargetResolver) sceneTargetResolvers[id] = opts.sceneTargetResolver;
  if (opts.onClose) kindOnCloses[id] = opts.onClose;
  if (opts.keepInViews !== undefined) {
    if (opts.keepInViews) {
      keepInViewsKinds.add(id);
    } else {
      keepInViewsKinds.delete(id);
    }
  }
};

/**
 * The windows of a kind (a window without a `kind` is the only one of the kind named by its id).
 * @param kind (string) the window kind
 * @param onlyOpen (boolean) optional, only the open windows (default true)
 */
export const getDraggableWindowsOfKind = (kind: string, onlyOpen = true) => {
  const result: DraggableWindow[] = [];
  for (const entry of getWindows().values()) {
    if (getWindowKind(entry.config) !== kind || (onlyOpen && !entry.config.isOpen)) continue;
    result.push(toPublicWindow(entry));
  }
  return result;
};

/**
 * Rebuilds the content of every open window of a kind (see {@link updateDraggableWindow}).
 * @param kind (string) the window kind
 */
export const updateDraggableWindowsOfKind = (kind: string) => {
  const entries = getOpenWindowsOfKind(kind);
  for (let i = 0; i < entries.length; i++) updateDraggableWindow(entries[i].config.id);
};

/**
 * The list row click rule: opens the window when it isn't open, brings it to the front when it is
 * open under another window of its layer, and closes it when it is on top.
 * @param props (OpenDraggableWindowProps) the props to open the window with
 */
export const toggleDraggableWindow = (props: OpenDraggableWindowProps) => {
  const entry = getWindows().get(props.id);
  if (!entry?.config.isOpen || !entry.runtime.windowCMP) {
    openDraggableWindow({ ...props, closeIfOpen: false });
    return;
  }
  if (!isDraggableWindowOnTop(props.id)) {
    bringDraggableWindowToFront(props.id);
    return;
  }
  closeDraggableWindow(props.id);
};

/** @deprecated Use window kinds: {@link getDraggableWindowsOfKind}. */
export const getDraggableWindowsStartingWith = (startingWithId: string) => {
  const result: DraggableWindow[] = [];
  for (const entry of getWindows().values()) {
    if (entry.config.id.startsWith(startingWithId)) result.push(toPublicWindow(entry));
  }
  return result;
};

/** @deprecated Register the window's onClose once with {@link registerDraggableWindow} (or
 * {@link registerDraggableWindowKind}): it also covers a window restored from LS. */
export const addOnCloseToWindow = (id: string, onClose: () => void) => {
  const entry = getWindows().get(id);
  if (entry) entry.runtime.onClose = onClose;
};

/** @deprecated Register the window's content and onClose once with
 * {@link registerDraggableWindow} (or {@link registerDraggableWindowKind}). */
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
 * @deprecated Use {@link registerDraggableWindow}'s `sceneTargetResolver` (or
 * {@link registerDraggableWindowKind}'s).
 *
 * Registers a scene target resolver for a window flagged `closeOnSceneChange`: on a scene change
 * the window stays open (rebuilt for the next scene) when the resolver returns true for the
 * window's `data`, and closes otherwise. It is also checked when restoring the window on reload.
 * One registration covers every window of the kind.
 * @param id (string) window kind (a window's id when it has no kind)
 * @param resolver ((data) => boolean) whether the window's target exists in the current scene
 */
export const registerDraggableWindowSceneTargetResolver = (
  id: string,
  resolver: SceneTargetResolver
) => {
  sceneTargetResolvers[id] = resolver;
};

/**
 * @deprecated Use {@link registerDraggableWindow}'s `content` (or
 * {@link registerDraggableWindowKind}'s).
 *
 * Registers the content function of a window, for the opens without `content` (eg. a restore from
 * LS). One registration covers every window of the kind.
 * @param id (string) window kind (a window's id when it has no kind)
 * @param registerContentFn ((data) => TCMP) builds the content from the window's `data`
 */
export const registerDraggableWindowContentFn = (
  id: string,
  registerContentFn: (data?: DraggableWindowData) => TCMP
) => setContentFn(id, registerContentFn);

/** Kept in the app config, next to the content functions an app can set there itself. */
const setContentFn = (id: string, contentFn: (data?: DraggableWindowData) => TCMP) => {
  const config = getConfig();
  if (!config.draggableWindows) config.draggableWindows = {};
  config.draggableWindows[id] = { contentFn };
};
