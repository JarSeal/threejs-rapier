import { isDebugEnvironment } from '../core/Config';
import { getHUDRootCMP } from '../core/HUD';
import { getSvgIcon } from '../core/UI/icons/SvgIcon';
import { CMP, TCMP } from '../utils/CMP';
import { isUsingDebugCamera } from './DebugTools';
import styles from './OnScreenTools.module.scss';

let switchToolsCMP: TCMP | null = null;

const switchTools = () => {
  const hudRootCMP = getHUDRootCMP();
  if (!hudRootCMP) return;

  if (switchToolsCMP) switchToolsCMP.remove();
  switchToolsCMP = CMP({ class: [styles.switchTools, 'onScreenToolGroup', 'switchTools'] });

  const useDebugCamBtnClasses = [styles.onScreenBtn, 'onScreenBtn'];
  if (isUsingDebugCamera()) useDebugCamBtnClasses.push(styles.active, 'onScreenBtnActive');
  const useDebugCamBtn = CMP({
    class: useDebugCamBtnClasses,
    html: () => getSvgIcon('aspectRatio'),
    attr: { title: 'Toggle between debug camera and app camera' },
    onClick: (e) => {
      e.stopPropagation();
      console.log('CLICK');
    },
  });

  switchToolsCMP.add(useDebugCamBtn);

  hudRootCMP.add(switchToolsCMP);
};

export const InitOnScreenTools = () => {
  if (!isDebugEnvironment()) return;

  switchTools();
};

type ToolTypes = 'SWITCH';

const updateTool = (toolType: ToolTypes) => {
  switch (toolType) {
    case 'SWITCH':
      switchTools();
  }
};

export const updateOnScreenTools = (tools?: ToolTypes[] | ToolTypes) => {
  // Updates all tools
  if (!tools) InitOnScreenTools();

  if (Array.isArray(tools)) {
    // Update an array of selected tools
    for (let i = 0; i < tools.length; i++) {
      updateTool(tools[i]);
    }
    return;
  }

  // Update one tool
  updateOnScreenTools(tools);
};
