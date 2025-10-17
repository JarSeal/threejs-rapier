import { CMP, TCMP } from '../../utils/CMP';

type ToasterSettings = {
  verticalPosition?: 'top' | 'center' | 'bottom';
  horizontalPosition?: 'left' | 'center' | 'right';
  offset?: { x: number; y: number };
  toastDirection?: 'up' | 'down' | 'left' | 'right';
  toastMinWidthPx?: number;
  toastMaxWidthPx?: number;
  toastMinHeightPx?: number;
  toastMaxHeightPx?: number;
  animationTimeMs?: number;
  showingTimeMs?: number; // 0 is infinite
};

type ToasterProps = {
  id?: string;
  className?: string;
  settings?: ToasterSettings;
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

const DEFAULT_SETTINGS = {
  verticalPosition: 'bottom' as ToasterSettings['verticalPosition'],
  horizontalPosition: 'left' as ToasterSettings['horizontalPosition'],
  offset: { x: 0, y: 0 },
  toastDirection: 'up' as ToasterSettings['toastDirection'],
  toastMinWidthPx: 200,
  toastMaxWidthPx: 200,
  toastMinHeightPx: 100,
  toastMaxHeightPx: 100,
  animationSpeedMs: 200,
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
  const toaster = CMP({
    id: newId,
    html: `<div class="toaster${className ? ` ${className}` : ''}"></div>`,
  });
  const config = {
    ...DEFAULT_SETTINGS,
    ...settings,
  };
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

  const classNames = ['toast', `toastType-${type}`];
  if (className) classNames.push(className);
  const wrapperCmp = CMP({ class: classNames, id });
  if (icon) {
    wrapperCmp.add(
      typeof icon === 'string' ? { html: `<div class="toastIcon">${icon || ''}</div>` } : icon
    );
  }
  const contentCmp = wrapperCmp.add({ class: 'toastContent' });
  if (title) {
    contentCmp.add(typeof title === 'string' ? { class: 'toastTitle' } : title);
  }
  if (message) {
    contentCmp.add(typeof message === 'string' ? { class: 'toastMessage' } : message);
  }

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

  setTimeout(() => {
    // Set the transition for the toast to appear
  }, 10);
};
