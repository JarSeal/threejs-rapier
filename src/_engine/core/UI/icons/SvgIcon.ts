import fileCodeIcon from './svg/file-earmark-code-fill.svg?raw';
import fileAsterixIcon from './svg/file-earmark-medical-fill.svg?raw';
import thrashIcon from './svg/trash3-fill.svg?raw';

const icons = {
  fileAsterix: fileAsterixIcon,
  fileCode: fileCodeIcon,
  thrash: thrashIcon,
};

export const getSvgIcon = (iconKey: keyof typeof icons) => {
  const icon = icons[iconKey];
  return `<span class="ui-icon">${icon}</span>`;
};
