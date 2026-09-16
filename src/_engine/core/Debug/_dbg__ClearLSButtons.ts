import { CMP, TCMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { openDialog } from '../UI/DialogWindow';
import { closeDraggableWindow } from '../UI/DraggableWindow';

const CONFIRM_CLEAR_SCOPE_DIALOG_ID = 'clearLSScopeConfirmDialog';

export const createClearTabLSButton = (opts: {
  hasData: () => boolean;
  onClear: () => void;
}): TCMP => {
  const btn: TCMP = CMP({
    class: 'debuggerClearLSButton',
    html: () =>
      `<button title="Clear local storage data for this tab"${!opts.hasData() ? ' disabled' : ''}>${getSvgIcon('eraser')}</button>`,
    onClick: () => {
      if (!opts.hasData()) return;
      opts.onClear();
      btn.update();
    },
  });
  return btn;
};

export const createClearListLSButton = (opts: {
  hasData: () => boolean;
  onClear: () => void;
}): TCMP => {
  const btn: TCMP = CMP({
    class: 'debuggerClearLSButton',
    html: () =>
      `<button title="Clear local storage data for all items in this list"${!opts.hasData() ? ' disabled' : ''}>${getSvgIcon('databaseX')}</button>`,
    onClick: () => {
      if (!opts.hasData()) return;
      opts.onClear();
      btn.update();
    },
  });
  return btn;
};

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
