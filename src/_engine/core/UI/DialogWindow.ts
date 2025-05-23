import { openDraggableWindow, OpenDraggableWindowProps } from './DraggableWindow';

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
>;

export const openDialog = (props: DialogProps) => {
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
};
