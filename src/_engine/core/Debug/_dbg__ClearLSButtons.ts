import { CMP, TCMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { openDialog } from '../UI/DialogWindow';
import { closeDraggableWindow } from '../UI/DraggableWindow';
import { lsGetItem, lsSubscribe } from '../../utils/LocalAndSessionStorage';

const CONFIRM_CLEAR_SCOPE_DIALOG_ID = 'clearLSScopeConfirmDialog';

/**
 * Whether a flat (non-scene-scoped) LocalStorage key currently has any data stored.
 */
export const lsKeyHasData = (key: string): boolean => lsGetItem(key, null) !== null;

type ClearLSButtonOpts = {
  hasData: () => boolean;
  onClear: () => void;
  /** LS key to watch for writes made through `lsSetItem`/`lsRemoveItem` (by this
   * button's own `onClear`, a sibling button's `onClear`, or unrelated edits
   * elsewhere in the tab) so the disabled state stays live instead of only
   * updating on this button's own click. Omit for buttons that are always
   * disabled regardless of any LS key (e.g. no backing key exists yet). */
  watchKey?: string;
};

const createClearLSButton = (
  opts: ClearLSButtonOpts & { icon: 'eraser' | 'databaseX'; title: string }
): TCMP => {
  let lastHasData = opts.hasData();
  const btn: TCMP = CMP({
    class: 'debuggerClearLSButton',
    html: () => {
      lastHasData = opts.hasData();
      return `<button title="${opts.title}"${!lastHasData ? ' disabled' : ''}>${getSvgIcon(opts.icon)}</button>`;
    },
    onClick: () => {
      if (!opts.hasData()) return;
      opts.onClear();
    },
    onRemoveCmp: () => unsubscribe?.(),
  });
  const unsubscribe = opts.watchKey
    ? lsSubscribe(opts.watchKey, () => {
        if (opts.hasData() === lastHasData) return;
        btn.update();
      })
    : undefined;
  return btn;
};

export const createClearTabLSButton = (opts: ClearLSButtonOpts): TCMP =>
  createClearLSButton({ ...opts, icon: 'eraser', title: 'Clear local storage data for this tab' });

export const createClearListLSButton = (opts: ClearLSButtonOpts): TCMP =>
  createClearLSButton({
    ...opts,
    icon: 'databaseX',
    title: 'Clear local storage data for all items in this list',
  });

export const confirmClearScope = (opts: {
  onClearAllScenes: () => void;
  onClearThisScene: () => void;
}) => {
  openDialog({
    id: CONFIRM_CLEAR_SCOPE_DIALOG_ID,
    closeIfOpen: true,
    title: 'Clear local storage data',
    content: () => {
      const wrapper = CMP({
        html: () => `<p>Do you want to clear this from all scenes or just the current scene?</p>`,
      });
      const buttonRow = wrapper.add({ class: 'debuggerClearLSDialogButtonRow' });
      buttonRow.add({
        tag: 'button',
        text: 'Clear all scenes',
        class: ['debuggerClearLSDialogButton', 'dangerColor'],
        onClick: () => {
          closeDraggableWindow(CONFIRM_CLEAR_SCOPE_DIALOG_ID);
          opts.onClearAllScenes();
        },
      });
      buttonRow.add({
        tag: 'button',
        text: 'Clear this scene',
        class: 'debuggerClearLSDialogButton',
        onClick: () => {
          closeDraggableWindow(CONFIRM_CLEAR_SCOPE_DIALOG_ID);
          opts.onClearThisScene();
        },
      });
      buttonRow.add({
        tag: 'button',
        text: 'Cancel',
        class: 'debuggerClearLSDialogButton',
        onClick: () => closeDraggableWindow(CONFIRM_CLEAR_SCOPE_DIALOG_ID),
      });
      return wrapper;
    },
  });
};
