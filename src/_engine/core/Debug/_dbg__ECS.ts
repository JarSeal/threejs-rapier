import { createNewDebuggerContainer, createDebuggerTab } from '../../debug/DebuggerGUI';
import { getSvgIcon } from '../../core/UI/icons/SvgIcon';

export const _initECSDebugGUI = () => {
  const icon = getSvgIcon('ecs');
  createDebuggerTab({
    id: 'ecsControls',
    buttonText: icon,
    title: 'ECS',
    orderNr: 15,
    container: () => {
      const container = createNewDebuggerContainer('debuggerECS', `${icon} ECS`);
      container.add({ text: 'Hello world' });
      return container;
    },
  });
};
