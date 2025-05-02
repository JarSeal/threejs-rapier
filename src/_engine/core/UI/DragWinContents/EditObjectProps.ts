import { CMP } from '../../../utils/CMP';

export const editObjectPropsContentFn = () => {
  const wrapperCMP = CMP({
    html: () =>
      // '<div>Hello world!</div>',
      '<div>Hello world!</br>This is my content for the draggable window. This should overflow and show the scroll bar in the window. This should not be too hard to implement, right?</div>',
  });
  return wrapperCMP;
};
