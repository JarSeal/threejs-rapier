import {
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  OpenDraggableWindowProps,
} from './DraggableWindow';

export type DialogProps = Omit<
  OpenDraggableWindowProps,
  | 'isCollapsed'
  | 'position'
  | 'resetPosition'
  | 'resetSize'
  | 'disableVertResize'
  | 'disableHoriResize'
  | 'disableDragging'
  | 'disableCollapseBtn'
> & {
  /** Closes the dialog with the Escape key (default false). While such a dialog is open, Escape
   * only closes it: no key binding (app or engine) or other Escape listener gets the press. */
  closeOnEscape?: boolean;
};

/** The closeOnEscape dialogs in open order: Escape closes the last one that is still open. */
const escapeDialogIds: string[] = [];
/** The keyup of an Escape press that closed a dialog, so a KEY_UP Escape binding doesn't fire
 * right after the dialog is gone. */
let isEscapeKeyUpSwallowed = false;

const getTopEscapeDialogId = () => {
  for (let i = escapeDialogIds.length - 1; i >= 0; i--) {
    const id = escapeDialogIds[i];
    // windowCMP: only a live window has one (getDraggableWindow can fall back to the LS state)
    const dialog = getDraggableWindow(id);
    if (dialog?.isOpen && dialog.windowCMP) return id;
    escapeDialogIds.splice(i, 1); // closed some other way
  }
  return null;
};

const onEscapeKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  if (e.type === 'keyup') {
    if (!isEscapeKeyUpSwallowed) return;
    isEscapeKeyUpSwallowed = false;
    e.stopImmediatePropagation();
    return;
  }
  isEscapeKeyUpSwallowed = false;
  const id = getTopEscapeDialogId();
  if (!id) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  isEscapeKeyUpSwallowed = true;
  // A held Escape closes one dialog, not every stacked one
  if (!e.repeat) closeDraggableWindow(id);
};

// Registered at module load, in the capture phase on window: the first listener on the first
// target of the event, so it runs before KeyboardInput's (bubble phase) and before any capture
// listener added later (eg. the ray tester's Esc cancel)
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onEscapeKey, true);
  window.addEventListener('keyup', onEscapeKey, true);
}

export const openDialog = ({ closeOnEscape, ...props }: DialogProps) => {
  openDraggableWindow({
    maxSize: { w: 90, h: 90 },
    minSize: { w: 320, h: 320 },
    size: { w: 600, h: 600 },
    ...props,
    units: {
      maxSize: { w: '%', h: '%' },
      minSize: { w: 'px', h: 'px' },
      size: { w: 'px', h: 'px' },
      ...props.units,
      position: { x: '%', y: '%' },
    },
    position: { x: 50, y: 50 },
    resetPosition: true,
    resetSize: true,
    disableVertResize: true,
    disableHoriResize: true,
    disableDragging: true,
    disableCollapseBtn: true,
    hasBackDrop: true,
  });

  const index = escapeDialogIds.indexOf(props.id);
  if (index !== -1) escapeDialogIds.splice(index, 1);
  if (closeOnEscape) escapeDialogIds.push(props.id); // (re)opened: on top
};
