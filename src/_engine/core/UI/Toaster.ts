import { CMP, TCMP, TStyle } from '../../utils/CMP';

type ToasterSettings = {
  verticalPosition: 'top' | 'center' | 'bottom';
  horizontalPosition: 'left' | 'center' | 'right';
  toastDirection: 'up' | 'down' | 'left' | 'right';
  toastAppearFromDirection: 'up' | 'down' | 'left' | 'right';
  toastMinWidth: string;
  toastMaxWidth: string;
  toastMinHeight: string;
  toastMaxHeight: string;
  animationTimeMs: number;
  showingTimeMs: number; // 0 is infinite
  offset?: { x: string; y: string };
};

type ToasterProps = {
  id?: string;
  className?: string;
  settings?: Partial<ToasterSettings>;
  setAsDefaultToaster?: boolean;
};

type ToastProps = {
  type?: 'info' | 'warning' | 'alert';
  title?: string | TCMP;
  message?: string | TCMP;
  icon?: string | TCMP;
  showingTime?: number; // 0 is infinite
  animationTime?: number;
  className?: string;
  toasterId?: string;
};

type ToasterObj = { cmp: TCMP; settings: ToasterSettings };

const DEFAULT_SETTINGS: ToasterSettings = {
  verticalPosition: 'bottom' as ToasterSettings['verticalPosition'],
  horizontalPosition: 'left' as ToasterSettings['horizontalPosition'],
  offset: { x: '0', y: '0' },
  toastDirection: 'up' as ToasterSettings['toastDirection'],
  toastAppearFromDirection: 'left' as ToasterSettings['toastAppearFromDirection'],
  toastMinWidth: '200px',
  toastMaxWidth: '200px',
  toastMinHeight: '0',
  toastMaxHeight: '100px',
  animationTimeMs: 200,
  showingTimeMs: 2500,
};
const toasterCMPs: { [id: string]: ToasterObj } = {};
const toastCMPs: {
  [id: string]: {
    cmp: TCMP;
    time: number;
    endTimeout: NodeJS.Timeout;
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
    ...DEFAULT_SETTINGS,
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
    class: classes,
    style: toasterStyle,
  });

  toasterCMPs[newId] = { cmp: toaster, settings: config };
  if (!defaultToaster || setAsDefaultToaster) defaultToaster = toasterCMPs[newId];

  // @TODO: Add a style tag to the head HTML section that has the definitions for the START_PHASE_CLASS and the TOASTER_UPDATE_CLASS
  const head = document.head || document.getElementsByTagName('head')[0];
  if (head) {
    const css = `
    .toaster {
      transition: none;
    }
    .toaster.${TOASTER_UPDATE_CLASS} {
      padding-top: 0;
      padding-bottom: 0;
      padding-left: 0;
      padding-right: 0;
      transition: padding-top ${config.animationTimeMs}ms ease-out, padding-bottom ${config.animationTimeMs}ms ease-out, padding-left ${config.animationTimeMs}ms ease-out, padding-right ${config.animationTimeMs}ms ease-out;
    }
    .toast {
      min-width: ${config.toastMinWidth};
      max-width: ${config.toastMaxWidth};
      min-height: ${config.toastMinHeight};
      max-height: ${config.toastMaxHeight};
      position: absolute;
      top: -9999px;
      left: -9999px;
      opacity: 0;
    }
    .toast.${START_PHASE_CLASS} {
      transform: translate(0,0) !important;
      opacity: 1;
      transition: transform ${config.animationTimeMs}ms ease-in-out, opacity ${config.animationTimeMs}ms ease-in-out;
    }
    .toast.${END_PHASE_CLASS} {
      opacity: 0;
    }'
  `;
    const style = document.createElement('style');
    style.appendChild(document.createTextNode(css));
    head.appendChild(style);
  }

  return toaster;
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
}: ToastProps) => {
  const toaster = toasterId ? toasterCMPs[toasterId] : defaultToaster;
  if (!toaster) {
    const errorMsg = `Error while adding toast. Could not find toaster (${toasterId ? `toasterId: ${toasterId}` : 'using defaultToaster'}).`;
    throw new Error(errorMsg);
  }

  const timeNow = performance.now();
  const id = `toast-${timeNow}`;

  const animTime =
    animationTime !== undefined ? animationTime : toaster.settings.animationTimeMs || 0;
  const showTime = showingTime !== undefined ? showingTime : toaster.settings.showingTimeMs || 0;
  const totalTime = showTime + animTime * 2;

  const classNames = ['toast', `toastType-${type || 'info'}`];
  if (className) classNames.push(className);
  const toastCmp = CMP({ class: classNames, id });
  if (icon) {
    toastCmp.add(
      typeof icon === 'string' ? { html: `<div class="toastIcon">${icon || ''}</div>` } : icon
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

  const endTimeout = setTimeout(() => {
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
        // Set the end transition
        toastCmp.updateClass(END_PHASE_CLASS, 'add');
        setTimeout(() => {
          // Destroy the cmp and clear queue
          toastCmp.remove();
        }, animTime);
      }, showTime);
    }
  }, animTime + 10);

  toastCMPs[id] = { cmp: toastCmp, time: totalTime, endTimeout };

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
};
