import { CMP, TCMP, TStyle } from '../../utils/CMP';

type ToasterSettings = {
  /** Where is the toast positioned (fixed) vertically on the screen? */
  verticalPosition: 'top' | 'center' | 'bottom';

  /** Where is the toast positioned (fixed) horizontally on the screen? */
  horizontalPosition: 'left' | 'center' | 'right';

  /** Translate offset of the vertical and horizontal position. */
  offset: { x: string; y: string };

  /** Which way is the toast line forming from the toaster? */
  toastDirection: 'up' | 'down' | 'left' | 'right';

  /** From which direction is a new toast appearing from to its position?
   * If the toastDirection is vertical then this should be horizontal and
   * vice versa (for the best effect).
   */
  toastAppearFromDirection: 'up' | 'down' | 'left' | 'right';

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
   * the icon (it will not be shown then).
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

type ToastType = 'info' | 'warning' | 'alert';

type ToastProps = {
  type?: ToastType;
  title?: string | TCMP;
  message?: string | TCMP;
  icon?: string | TCMP;
  showingTime?: number;
  animationTime?: number;
  className?: string;
  toasterId?: string;
  isClosable?: boolean;
};

type ToasterObj = { cmp: TCMP; toasterId: string; settings: ToasterSettings };

const DEFAULT_ANIM_TIME = 200;
const DEFAULT_SHOW_TIME = 3200;
const DEFAULT_SHOW_TIMES = {
  info: DEFAULT_SHOW_TIME,
  warning: DEFAULT_SHOW_TIME,
  alert: 0,
};
export const DEFAULT_TOASTER_SETTINGS: ToasterSettings = {
  verticalPosition: 'bottom' as ToasterSettings['verticalPosition'],
  horizontalPosition: 'left' as ToasterSettings['horizontalPosition'],
  offset: { x: '0', y: '0' },
  toastDirection: 'up' as ToasterSettings['toastDirection'],
  toastAppearFromDirection: 'left' as ToasterSettings['toastAppearFromDirection'],
  toastMinWidth: '200px',
  toastMaxWidth: '200px',
  toastMinHeight: '0',
  toastMaxHeight: '100px',
  animationTimeMs: DEFAULT_ANIM_TIME,
  showingTimeMs: DEFAULT_SHOW_TIMES,
  isClosable: { alert: true },
};
const toasterCMPs: { [id: string]: ToasterObj } = {};
const toastCMPs: {
  [id: string]: {
    toasterId: string;
    cmp: TCMP;
    time: number;
    animationTime: number;
    timeout: NodeJS.Timeout;
  };
} = {};
let defaultToaster: ToasterObj | null = null;
const START_PHASE_CLASS = 'toastStart';
const END_PHASE_CLASS = 'toastEnd';
const TOASTER_UPDATE_CLASS = 'toasterUpdating';

export const createToaster = ({ id, className, settings, setAsDefaultToaster }: ToasterProps) => {
  const newId = id || `toaster-${performance.now()}`;
  const classes = ['toaster'];
  if (className) classes.push(className);
  const toasterStyle: TStyle = { position: 'fixed' };

  const config = {
    ...DEFAULT_TOASTER_SETTINGS,
    ...settings,
  };

  if (config.verticalPosition === 'top') {
    toasterStyle.top = 0;
  } else if (config.verticalPosition === 'center') {
    toasterStyle.bottom = '50%';
  } else {
    // 'bottom'
    toasterStyle.bottom = 0;
  }
  if (config.offset) {
    toasterStyle.transform = `translate(${config.offset.x}, ${config.offset.y})`;
  }

  const toaster = CMP({
    id: newId,
    idAttr: true,
    class: classes,
    style: toasterStyle,
  });

  toasterCMPs[newId] = { cmp: toaster, toasterId: newId, settings: config };
  if (!defaultToaster || setAsDefaultToaster) defaultToaster = toasterCMPs[newId];

  // @TODO: Add a style tag to the head HTML section that has the definitions for the START_PHASE_CLASS and the TOASTER_UPDATE_CLASS
  const head = document.head || document.getElementsByTagName('head')[0];
  if (head) {
    const css = `
  #${newId}.toaster {
    transition: none;
    font-size: 1.4rem;
  }
  #${newId}.toaster.${TOASTER_UPDATE_CLASS} {
    padding-top: 0;
    padding-bottom: 0;
    padding-left: 0;
    padding-right: 0;
    transition: padding-top ${config.animationTimeMs}ms ease-out, padding-bottom ${config.animationTimeMs}ms ease-out, padding-left ${config.animationTimeMs}ms ease-out, padding-right ${config.animationTimeMs}ms ease-out;
  }
  #${newId} .toast {
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
  #${newId} .toast .toastIcon {
    width: 1.6rem;
    height: 1.6rem;
    display: inline-block;
    vertical-align: top;
  }
  #${newId} .toast .toastContent {
    width: 100%;
    display: inline-block;
    vertical-align: top;
  }
  #${newId} .toast .toastIcon + .toastContent {
    width: calc(100% - 2.4rem);
    margin-left: 0.8rem;
  }
  #${newId} .toast .toastCloseBtn {
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
  #${newId} .toast .toastCloseBtn:hover {
    opacity: 1;
  }
  #${newId} .toast .toastCloseBtn.noIcon:before {
    display: block;
    content: "+";
    transform: rotate(45deg);
    font-size: 2rem;
    line-height: 0;
  }
  #${newId} .toast .toastTitle {
    font-weight: 700;
    padding-right: 1.6rem;
  }
  #${newId} .toast .toastMessage {
    font-size: 1.2rem;
  }
  #${newId} .toast .toastTitle + .toastMessage {
    margin-top: 0.4rem;
  }
  #${newId} .toast.${START_PHASE_CLASS} {
    transform: translate(0,0) !important;
    opacity: 1;
    transition: transform ${config.animationTimeMs}ms ease-in-out, opacity ${config.animationTimeMs}ms ease-in-out;
  }
  #${newId} .toast.${END_PHASE_CLASS} {
    opacity: 0;
  }'
  `;
    const style = document.createElement('style');
    style.setAttribute('id', newId);
    style.appendChild(document.createTextNode(css));
    head.appendChild(style);
  }

  return toaster;
};

export const removeToaster = (toasterId: string) => {
  const toastKeys = Object.keys(toastCMPs);
  for (let i = 0; i < toastKeys.length; i++) {
    const toast = toastCMPs[toastKeys[i]];
    if (toast?.toasterId === toasterId) {
      clearTimeout(toast.timeout);
      toast.cmp?.remove();
      delete toastCMPs[toastKeys[i]];
    }
  }

  const toaster = toasterCMPs[toasterId];
  if (toaster) {
    toaster.cmp?.remove();
    delete toasterCMPs[toasterId];
  }

  if (defaultToaster?.toasterId === toasterId) {
    let newDefaultToaster = null;
    const firstToasterId = Object.keys(toasterCMPs)[0];
    if (firstToasterId) newDefaultToaster = toasterCMPs[firstToasterId];
    defaultToaster = newDefaultToaster;
  }
};

export const addToast = ({
  type,
  title,
  message,
  icon,
  showingTime,
  animationTime,
  className,
  toasterId,
  isClosable,
}: ToastProps): AddToastResponse => {
  const toaster = toasterId ? toasterCMPs[toasterId] : defaultToaster;
  if (!toaster) {
    const errorMsg = `Error while adding toast. Could not find toaster (${toasterId ? `toasterId: ${toasterId}` : 'using defaultToaster'}).`;
    throw new Error(errorMsg);
  }

  const timeNow = performance.now();
  const id = `toast-${timeNow}`;

  const toastType = type || 'info';

  const animTime =
    animationTime !== undefined
      ? animationTime
      : toaster.settings.animationTimeMs || DEFAULT_ANIM_TIME;
  let showTime =
    showingTime !== undefined ? showingTime : toaster.settings.showingTimeMs || DEFAULT_SHOW_TIMES;
  if (typeof showTime !== 'number') {
    showTime = showTime[toastType] !== undefined ? showTime[toastType] : DEFAULT_SHOW_TIME;
  }
  const totalTime = showTime + animTime * 2;

  const classNames = ['toast', `toastType-${toastType || 'info'}`];
  if (className) classNames.push(className);
  const toastCmp = CMP({ class: classNames, id });

  let toastIcon = icon || toaster.settings.icons;
  if (toastIcon !== undefined && typeof toastIcon !== 'string') {
    toastIcon = (toaster.settings.icons as { [key in ToastType]?: string })[toastType] || '';
  }
  if (toastIcon) {
    toastCmp.add(
      typeof toastIcon === 'string'
        ? { html: `<div class="toastIcon">${toastIcon}</div>` }
        : toastIcon
    );
  }
  const contentCmp = toastCmp.add({
    class: 'toastContent',
    prepend:
      toaster.settings.toastDirection === 'down' || toaster.settings.toastDirection === 'right',
  });
  if (title) {
    contentCmp.add(typeof title === 'string' ? { class: 'toastTitle', text: title } : title);
  }
  if (message) {
    contentCmp.add(
      typeof message === 'string' ? { class: 'toastMessage', text: message } : message
    );
  }
  toastCmp.add(contentCmp);

  let hasCloseButton = isClosable !== undefined ? isClosable : toaster.settings.isClosable;
  if (typeof hasCloseButton !== 'boolean') {
    hasCloseButton =
      hasCloseButton[toastType] !== undefined ? Boolean(hasCloseButton[toastType]) : false;
  }
  const closeBtnIcon = toaster.settings.closeBtnIcon;
  if (hasCloseButton) {
    toastCmp.add({
      class: `toastCloseBtn${!closeBtnIcon ? ' noIcon' : ''}`,
      tag: 'button',
      ...(closeBtnIcon ? { html: `<button>${closeBtnIcon}</button>` } : {}),
      onClick: () => {
        removeToast(id);
      },
    });
  }

  const timeout = setTimeout(() => {
    // Start (appear) animation is done
    toastCmp?.updateStyle({
      position: 'relative',
      left: 'auto',
      right: 'auto',
      top: 'auto',
      bottom: 'auto',
    });
    toaster?.cmp.updateStyle({ paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 });
    toaster?.cmp.updateClass(TOASTER_UPDATE_CLASS, 'remove');
    if (showTime) {
      setTimeout(() => {
        removeToast(id);
      }, showTime);
    }
  }, animTime + 10);

  toastCMPs[id] = {
    toasterId: toaster.toasterId,
    cmp: toastCmp,
    animationTime: animTime,
    time: totalTime,
    timeout,
  };

  toaster.cmp.add(toastCmp);

  // Get toast dimensions
  const width = toastCmp.elem.offsetWidth;
  const height = toastCmp.elem.offsetHeight;

  // Get right start position for the appearance of the toast
  if (toaster.settings.toastAppearFromDirection === 'down') {
    toastCmp.updateStyle({ transform: `translate(0, -${height}px)` });
  } else if (toaster.settings.toastAppearFromDirection === 'up') {
    toastCmp.updateStyle({ transform: `translate(0, ${height}px)` });
  } else if (toaster.settings.toastAppearFromDirection === 'left') {
    toastCmp.updateStyle({ transform: `translate(-${width}px, 0)` });
  } else if (toaster.settings.toastAppearFromDirection === 'right') {
    toastCmp.updateStyle({ transform: `translate(${width}px, 0)` });
  }
  toaster.cmp.updateStyle({ paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 });

  setTimeout(() => {
    // Set the transition for the toast to appear
    toastCmp.updateClass(START_PHASE_CLASS, 'add');
    toaster.cmp.updateClass(TOASTER_UPDATE_CLASS, 'add');
    // Get right direction to push the existing toast
    if (toaster.settings.toastDirection === 'down') {
      toastCmp.updateStyle({ top: 0, left: 0, bottom: 'auto', right: 'auto' });
      toaster.cmp.updateStyle({ paddingTop: `${height}px` });
    } else if (toaster.settings.toastDirection === 'up') {
      toastCmp.updateStyle({ top: 'auto', left: 0, bottom: 0, right: 'auto' });
      toaster.cmp.updateStyle({ paddingBottom: `${height}px` });
    } else if (toaster.settings.toastDirection === 'left') {
      toastCmp.updateStyle({ top: 0, left: 'auto', bottom: 'auto', right: 0 });
      toaster.cmp.updateStyle({ paddingRight: `${width}px` });
    } else if (toaster.settings.toastDirection === 'right') {
      toastCmp.updateStyle({ top: 0, left: 0, bottom: 'auto', right: 'auto' });
      toaster.cmp.updateStyle({ paddingLeft: `${width}px` });
    }
  }, 10);

  return {
    id,
    toasterId: toaster.toasterId,
    dimensions: { x: width, y: height },
    startedTime: timeNow,
    animationTime: animTime,
    showingTime: showTime,
    totalTime,
    toastCmp,
    hasCloseButton,
    timeout,
    type: toastType,
    title,
    message,
    icon,
    removeToast: () => removeToast(id),
  };
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
  timeout: NodeJS.Timeout;
  type: ToastType;
  title: TCMP | string | undefined;
  message: TCMP | string | undefined;
  icon: TCMP | string | undefined;
  removeToast: () => void;
};

export const removeToast = (id: string) => {
  const toastData = toastCMPs[id];
  if (!toastData) return;

  const toastCmp = toastData.cmp;
  const animTime = toastData.animationTime;

  // Clear the timeout
  clearTimeout(toastData.timeout);

  // Set the end transition
  toastCmp?.updateClass(END_PHASE_CLASS, 'add');
  setTimeout(() => {
    // Destroy the cmp and clear queue
    toastCmp?.remove();
    delete toastCMPs[id];
  }, animTime);
};
