import { CMP, TCMP, TStyle } from '../../utils/CMP';

type ToasterSettings = {
  verticalPosition: 'top' | 'center' | 'bottom';
  horizontalPosition: 'left' | 'center' | 'right';
  toastDirection: 'up' | 'down' | 'left' | 'right';
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
    endTimeout: null | NodeJS.Timeout;
  };
} = {};
let defaultToaster: ToasterObj | null = null;

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
  const toastStyles = {
    minWidth: toaster.settings.toastMinWidth,
    maxWidth: toaster.settings.toastMaxWidth,
    minHeight: toaster.settings.toastMinHeight,
    maxHeight: toaster.settings.toastMaxHeight,
  };
  const wrapperCmp = CMP({ class: classNames, id, style: toastStyles });
  if (icon) {
    wrapperCmp.add(
      typeof icon === 'string' ? { html: `<div class="toastIcon">${icon || ''}</div>` } : icon
    );
  }
  const contentCmp = wrapperCmp.add({
    class: 'toastContent',
    prepend:
      toaster.settings.toastDirection === 'up' || toaster.settings.toastDirection === 'right',
  });
  if (title) {
    contentCmp.add(typeof title === 'string' ? { class: 'toastTitle', text: title } : title);
  }
  if (message) {
    contentCmp.add(
      typeof message === 'string' ? { class: 'toastMessage', text: message } : message
    );
  }
  wrapperCmp.add(contentCmp);

  let endTimeout = null;
  if (animTime) {
    endTimeout = setTimeout(() => {
      // Set the end transition
      setTimeout(() => {
        // Destroy the cmp and clear queue
      });
    }, showTime + animTime);
  }

  toastCMPs[id] = { cmp: wrapperCmp, time: totalTime, endTimeout };

  toaster.cmp.add(wrapperCmp);

  setTimeout(() => {
    // Set the transition for the toast to appear
  }, 10);
};
