import type { TCMP, TStyle } from '../../utils/CMP';
import { CMP } from '../../utils/CMP';

type ToastType = 'info' | 'warning' | 'alert';
type Direction = 'up' | 'down' | 'left' | 'right';

type ToasterSettings = {
  /** Where is the toast positioned (fixed) vertically on the screen? */
  verticalPosition: 'top' | 'center' | 'bottom';

  /** Where is the toast positioned (fixed) horizontally on the screen? */
  horizontalPosition: 'left' | 'center' | 'right';

  /** Translate offset of the vertical and horizontal position. */
  offset: { x: string; y: string };

  /** Which way is the toast line forming from the toaster? */
  toastDirection: Direction;

  /** From which direction is a new toast appearing from to its position?
   * If the toastDirection is vertical then this should be horizontal and
   * vice versa (for the best effect).
   */
  toastAppearFromDirection: Direction;

  /** Minimum width for a single toast (including the unit). */
  toastMinWidth: string;

  /** Maximum width for a single toast (including the unit). */
  toastMaxWidth: string;

  /** Minimum height for a single toast (including the unit). */
  toastMinHeight: string;

  /** Maximum height for a single toast (including the unit). */
  toastMaxHeight: string;

  /** Animation time of the toast appearing and disappearing.
   * This is also the animation time for the queue to move to create
   * the space for the new appearing toast.
   */
  animationTimeMs: number;

  /** How long should the toast be shown? If the value is 0 then it
   * won't disappear with a timer. This can either be a number or an
   * object defining the showing time for each toast type.
   */
  showingTimeMs: number | { [key in ToastType]: number };

  /** Whether the toasts are closable or not. This can either be a
   * boolean or an object defining each toast type.
   */
  isClosable: boolean | { [key in ToastType]?: boolean };

  /** Icons to be used for a toast. This can either be a single string
   * and then all the icons will have the same icon or an object
   * defininig each toast type icon. An empty string ("") will omit
   * the icon (it will not be shown then). A TCMP icon is moved into
   * the toast, so it can only be used by one toast.
   */
  icons?: string | { [key in ToastType]?: string | TCMP };

  /** Determines a special close button icon. If not defined,
   * a rotated CSS "+" (:before { content: "+" }) is used.
   */
  closeBtnIcon?: string;
};

type ToasterProps = {
  id?: string;
  className?: string;
  settings?: Partial<ToasterSettings>;
  setAsDefaultToaster?: boolean;
};

export type ToastProps = {
  type?: ToastType;
  title?: string | TCMP;
  message?: string | TCMP;
  /** Overrides the toaster's icon for this toast. An empty string ("") omits the icon. */
  icon?: string | TCMP;
  showingTime?: number;
  animationTime?: number;
  className?: string;
  toasterId?: string;
  isClosable?: boolean;
};

export type AddToastResponse = {
  id: string;
  toasterId: string;
  dimensions: { x: number; y: number };
  startedTime: number;
  animationTime: number;
  showingTime: number;
  totalTime: number;
  toastCmp: TCMP;
  hasCloseButton: boolean;
  /** The toast's first lifecycle timer (later phases replace it internally). Use
   * `removeToast` to remove the toast early, not `clearTimeout`. */
  timeout: ReturnType<typeof setTimeout>;
  type: ToastType;
  title: TCMP | string | undefined;
  message: TCMP | string | undefined;
  icon: TCMP | string | undefined;
  removeToast: () => void;
};

type Toaster = {
  id: string;
  cmp: TCMP;
  styleElem: HTMLStyleElement;
  settings: ToasterSettings;
};

/** A toast's lifecycle: ENTERING (measured off-screen) → APPEARING (sliding in, the queue
 * making room) → SHOWING → REMOVING (fading out) → disposed. */
type ToastPhase = 'ENTERING' | 'APPEARING' | 'SHOWING' | 'REMOVING';

type Toast = {
  id: string;
  toaster: Toaster;
  cmp: TCMP;
  animationTime: number;
  phase: ToastPhase;
  /** The one pending timer of the current phase, so removing a toast (or its toaster) clears
   * everything still scheduled for it. */
  timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_ANIM_TIME = 200;
const DEFAULT_SHOW_TIME = 3200;
const DEFAULT_SHOW_TIMES = {
  info: DEFAULT_SHOW_TIME,
  warning: DEFAULT_SHOW_TIME,
  alert: 0,
};
export const DEFAULT_TOASTER_SETTINGS: ToasterSettings = {
  verticalPosition: 'bottom',
  horizontalPosition: 'left',
  offset: { x: '0', y: '0' },
  toastDirection: 'up',
  toastAppearFromDirection: 'left',
  toastMinWidth: '200px',
  toastMaxWidth: '200px',
  toastMinHeight: '0',
  toastMaxHeight: '100px',
  animationTimeMs: DEFAULT_ANIM_TIME,
  showingTimeMs: DEFAULT_SHOW_TIMES,
  isClosable: { alert: true },
};

/** Lets a new toast render (off-screen) once before its transition starts. */
const ENTER_DELAY_MS = 10;
const START_PHASE_CLASS = 'toastStart';
const END_PHASE_CLASS = 'toastEnd';
const TOASTER_UPDATE_CLASS = 'toasterUpdating';
const NO_PADDING: TStyle = { paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 };
const SETTLED_TOAST_STYLE: TStyle = {
  position: 'relative',
  left: 'auto',
  right: 'auto',
  top: 'auto',
  bottom: 'auto',
};

/** Where a new toast starts its slide from, by `toastAppearFromDirection`. */
const APPEAR_START_TRANSFORM: Record<Direction, (w: number, h: number) => string> = {
  down: (_, h) => `translate(0, -${h}px)`,
  up: (_, h) => `translate(0, ${h}px)`,
  left: (w) => `translate(-${w}px, 0)`,
  right: (w) => `translate(${w}px, 0)`,
};

/** How a new toast pushes the queue, by `toastDirection`: where it is anchored while it
 * appears, and the toaster padding (animated) that makes room for it. */
const QUEUE_PUSH: Record<Direction, { anchor: TStyle; padding: (w: number, h: number) => TStyle }> =
  {
    down: {
      anchor: { top: 0, left: 0, bottom: 'auto', right: 'auto' },
      padding: (_, h) => ({ paddingTop: `${h}px` }),
    },
    up: {
      anchor: { top: 'auto', left: 0, bottom: 0, right: 'auto' },
      padding: (_, h) => ({ paddingBottom: `${h}px` }),
    },
    left: {
      anchor: { top: 0, left: 'auto', bottom: 'auto', right: 0 },
      padding: (w) => ({ paddingRight: `${w}px` }),
    },
    right: {
      anchor: { top: 0, left: 0, bottom: 'auto', right: 'auto' },
      padding: (w) => ({ paddingLeft: `${w}px` }),
    },
  };

const toasters = new Map<string, Toaster>();
const toasts = new Map<string, Toast>();
let defaultToaster: Toaster | null = null;
// Counters, not timestamps: two toasts in the same timer tick would share an id (and CMP
// throws on a taken id)
let toasterCount = 0;
let toastCount = 0;

/** A setting that is either one value for all toast types or a per-type object. */
const resolvePerType = <T>(
  value: T | { [key in ToastType]?: T } | undefined,
  type: ToastType,
  fallback: T
): T => {
  if (value === undefined) return fallback;
  if (typeof value !== 'object' || value === null) return value as T;
  return (value as { [key in ToastType]?: T })[type] ?? fallback;
};

const getToasterStyle = (config: ToasterSettings): TStyle => {
  const style: TStyle = { position: 'fixed' };
  const { x, y } = config.offset;

  if (config.verticalPosition === 'top') style.top = 0;
  else if (config.verticalPosition === 'center') style.bottom = '50%';
  else style.bottom = 0;

  if (config.horizontalPosition === 'right') {
    style.right = 0;
    style.transform = `translate(${x}, ${y})`;
  } else if (config.horizontalPosition === 'center') {
    style.left = '50%';
    style.transform = `translate(calc(-50% + ${x}), ${y})`;
  } else {
    style.left = 0;
    style.transform = `translate(${x}, ${y})`;
  }
  return style;
};

const getToasterCss = (id: string, config: ToasterSettings) => {
  const anim = config.animationTimeMs;
  return `
  #${id}.toaster {
    transition: none;
    font-size: 1.4rem;
  }
  #${id}.toaster.${TOASTER_UPDATE_CLASS} {
    padding: 0;
    transition: padding ${anim}ms ease-out;
  }
  #${id} .toast {
    min-width: ${config.toastMinWidth};
    max-width: ${config.toastMaxWidth};
    min-height: ${config.toastMinHeight};
    max-height: ${config.toastMaxHeight};
    position: absolute;
    top: -9999px;
    left: -9999px;
    opacity: 0;
    padding: 0.8rem;
    background: rgba(255, 255, 255, 0.25);
    margin-bottom: 0.2rem;
    border-radius: 0.4rem;
  }
  #${id} .toast .toastIcon {
    width: 1.6rem;
    height: 1.6rem;
    display: inline-block;
    vertical-align: top;
  }
  #${id} .toast .toastContent {
    width: 100%;
    display: inline-block;
    vertical-align: top;
  }
  #${id} .toast .toastIcon + .toastContent {
    width: calc(100% - 2.4rem);
    margin-left: 0.8rem;
  }
  #${id} .toast .toastCloseBtn {
    position: absolute;
    top: 0;
    right: 0;
    cursor: pointer;
    width: 2rem;
    height: 2rem;
    border-radius: 0;
    border: 0;
    outline: 0;
    background: transparent;
    padding: 0;
    opacity: 0.65;
    transition: opacity 0.2s ease-in-out;
  }
  #${id} .toast .toastCloseBtn:hover {
    opacity: 1;
  }
  #${id} .toast .toastCloseBtn.noIcon:before {
    display: block;
    content: "+";
    transform: rotate(45deg);
    font-size: 2rem;
    line-height: 0;
  }
  #${id} .toast .toastTitle {
    font-weight: 700;
    padding-right: 1.6rem;
  }
  #${id} .toast .toastMessage {
    font-size: 1.2rem;
  }
  #${id} .toast .toastTitle + .toastMessage {
    margin-top: 0.4rem;
  }
  #${id} .toast.${START_PHASE_CLASS} {
    transform: translate(0,0) !important;
    opacity: 1;
    transition: transform ${anim}ms ease-in-out, opacity ${anim}ms ease-in-out;
  }
  #${id} .toast.${END_PHASE_CLASS} {
    opacity: 0;
  }
  `;
};

export const createToaster = ({ id, className, settings, setAsDefaultToaster }: ToasterProps) => {
  const toasterId = id || `toaster-${++toasterCount}`;
  const config: ToasterSettings = { ...DEFAULT_TOASTER_SETTINGS, ...settings };

  const cmp = CMP({
    id: toasterId,
    idAttr: true,
    class: className ? ['toaster', className] : 'toaster',
    style: getToasterStyle(config),
  });

  const styleElem = document.createElement('style');
  styleElem.setAttribute('id', `${toasterId}-styles`);
  styleElem.textContent = getToasterCss(toasterId, config);
  document.head.appendChild(styleElem);

  const toaster: Toaster = { id: toasterId, cmp, styleElem, settings: config };
  toasters.set(toasterId, toaster);
  if (!defaultToaster || setAsDefaultToaster) defaultToaster = toaster;

  return cmp;
};

/** Whether a toaster with this id exists (eg. to skip a toast before the toaster is created). */
export const hasToaster = (toasterId: string) => toasters.has(toasterId);

/** Removes a toaster, its toasts (with their pending timers) and its styles. */
export const removeToaster = (toasterId: string) => {
  for (const toast of toasts.values()) {
    if (toast.toaster.id === toasterId) disposeToast(toast);
  }

  const toaster = toasters.get(toasterId);
  if (toaster) {
    toaster.cmp.remove();
    toaster.styleElem.remove();
    toasters.delete(toasterId);
  }

  if (defaultToaster?.id === toasterId) {
    defaultToaster = toasters.values().next().value ?? null;
  }
};

const createToastCmp = (
  id: string,
  toaster: Toaster,
  type: ToastType,
  { title, message, icon, className }: ToastProps,
  hasCloseButton: boolean
) => {
  const { settings } = toaster;
  const toastCmp = CMP({
    id,
    class: className ? ['toast', `toastType-${type}`, className] : ['toast', `toastType-${type}`],
  });

  const toastIcon = icon ?? resolvePerType(settings.icons, type, '');
  if (toastIcon) {
    toastCmp.add(
      typeof toastIcon === 'string'
        ? { html: `<div class="toastIcon">${toastIcon}</div>` }
        : toastIcon
    );
  }

  const contentCmp = toastCmp.add({
    class: 'toastContent',
    prepend: settings.toastDirection === 'down' || settings.toastDirection === 'right',
  });
  if (title) {
    contentCmp.add(typeof title === 'string' ? { class: 'toastTitle', text: title } : title);
  }
  if (message) {
    contentCmp.add(
      typeof message === 'string' ? { class: 'toastMessage', text: message } : message
    );
  }

  if (hasCloseButton) {
    const closeBtnIcon = settings.closeBtnIcon;
    toastCmp.add({
      tag: 'button',
      class: closeBtnIcon ? 'toastCloseBtn' : ['toastCloseBtn', 'noIcon'],
      ...(closeBtnIcon ? { html: `<button>${closeBtnIcon}</button>` } : {}),
      onClick: () => removeToast(id),
    });
  }

  return toastCmp;
};

/** Ends a toast's appearing: it joins the queue's flow and the toaster drops the room it made. */
const settleToast = (toast: Toast) => {
  toast.cmp.updateStyle(SETTLED_TOAST_STYLE);
  toast.toaster.cmp.updateStyle(NO_PADDING);
  toast.toaster.cmp.updateClass(TOASTER_UPDATE_CLASS, 'remove');
};

/** Clears the toast's pending timer and removes it right away (no fade). */
const disposeToast = (toast: Toast) => {
  if (toast.timer) clearTimeout(toast.timer);
  toast.timer = null;
  toast.cmp.remove();
  toasts.delete(toast.id);
};

export const addToast = (props: ToastProps): AddToastResponse => {
  const { type = 'info', toasterId, showingTime, animationTime, isClosable } = props;
  const toaster = toasterId ? toasters.get(toasterId) : defaultToaster;
  if (!toaster) {
    throw new Error(
      `Error while adding toast. Could not find toaster (${toasterId ? `toasterId: ${toasterId}` : 'using defaultToaster'}).`
    );
  }
  const { settings } = toaster;

  const startedTime = performance.now();
  const id = `toast-${++toastCount}`;
  const animTime = animationTime ?? (settings.animationTimeMs || DEFAULT_ANIM_TIME);
  const showTime =
    showingTime ?? resolvePerType(settings.showingTimeMs, type, DEFAULT_SHOW_TIMES[type]);
  const hasCloseButton = isClosable ?? resolvePerType(settings.isClosable, type, false);

  const toastCmp = createToastCmp(id, toaster, type, props, hasCloseButton);
  const toast: Toast = {
    id,
    toaster,
    cmp: toastCmp,
    animationTime: animTime,
    phase: 'ENTERING',
    timer: null,
  };
  toasts.set(id, toast);

  // Rendered off-screen first (see the .toast CSS) to get its size
  toaster.cmp.add(toastCmp);
  const width = toastCmp.elem.offsetWidth;
  const height = toastCmp.elem.offsetHeight;
  toastCmp.updateStyle({
    transform: APPEAR_START_TRANSFORM[settings.toastAppearFromDirection](width, height),
  });
  toaster.cmp.updateStyle(NO_PADDING);

  toast.timer = setTimeout(() => {
    // Slide in while the queue makes room
    toast.phase = 'APPEARING';
    const push = QUEUE_PUSH[settings.toastDirection];
    toastCmp.updateClass(START_PHASE_CLASS, 'add');
    toastCmp.updateStyle(push.anchor);
    toaster.cmp.updateClass(TOASTER_UPDATE_CLASS, 'add');
    toaster.cmp.updateStyle(push.padding(width, height));

    toast.timer = setTimeout(() => {
      toast.phase = 'SHOWING';
      settleToast(toast);
      toast.timer = showTime ? setTimeout(() => removeToast(id), showTime) : null;
    }, animTime);
  }, ENTER_DELAY_MS);

  return {
    id,
    toasterId: toaster.id,
    dimensions: { x: width, y: height },
    startedTime,
    animationTime: animTime,
    showingTime: showTime,
    totalTime: showTime + animTime * 2,
    toastCmp,
    hasCloseButton,
    timeout: toast.timer,
    type,
    title: props.title,
    message: props.message,
    icon: props.icon,
    removeToast: () => removeToast(id),
  };
};

/** Fades a toast out and disposes it. A no-op for a toast that is gone or already fading out. */
export const removeToast = (id: string) => {
  const toast = toasts.get(id);
  if (!toast || toast.phase === 'REMOVING') return;

  if (toast.timer) clearTimeout(toast.timer);
  // Closed before it finished appearing: the toaster must not keep the room it was making
  if (toast.phase !== 'SHOWING') settleToast(toast);
  toast.phase = 'REMOVING';
  toast.cmp.updateClass(END_PHASE_CLASS, 'add');
  toast.timer = setTimeout(() => disposeToast(toast), toast.animationTime);
};
