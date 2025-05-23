import arrowClockwiseIcon from '../../../../public/debugger/assets/icons/svg/arrow-clockwise.svg?raw';
import arrowCounterClockwiseIcon from '../../../../public/debugger/assets/icons/svg/arrow-counterclockwise.svg?raw';
import cameraIcon from '../../../../public/debugger/assets/icons/svg/camera2.svg?raw';
import cloudSunIcon from '../../../../public/debugger/assets/icons/svg/cloud-sun-fill.svg?raw';
import databaseXIcon from '../../../../public/debugger/assets/icons/svg/database-fill-x.svg?raw';
import fileAsterixIcon from '../../../../public/debugger/assets/icons/svg/file-earmark-medical-fill.svg?raw';
import fileCodeIcon from '../../../../public/debugger/assets/icons/svg/file-earmark-code-fill.svg?raw';
import gpuCardIcon from '../../../../public/debugger/assets/icons/svg/gpu-card.svg?raw';
import infinityIcon from '../../../../public/debugger/assets/icons/svg/infinity.svg?raw';
import lightBulbIcon from '../../../../public/debugger/assets/icons/svg/lightbulb-fill.svg?raw';
import rocketTakeoffIcon from '../../../../public/debugger/assets/icons/svg/rocket-takeoff-fill.svg?raw';
import speedometerIcon from '../../../../public/debugger/assets/icons/svg/speedometer.svg?raw';
import thrashIcon from '../../../../public/debugger/assets/icons/svg/trash3-fill.svg?raw';
import toolsIcon from '../../../../public/debugger/assets/icons/svg/tools.svg?raw';

const icons = {
  arrowClockwise: arrowClockwiseIcon,
  arrowCounterClockwise: arrowCounterClockwiseIcon,
  camera: cameraIcon,
  cloudSun: cloudSunIcon,
  databaseX: databaseXIcon,
  fileAsterix: fileAsterixIcon,
  fileCode: fileCodeIcon,
  gpuCard: gpuCardIcon,
  infinity: infinityIcon,
  lightBulb: lightBulbIcon,
  rocketTakeoff: rocketTakeoffIcon,
  speedometer: speedometerIcon,
  thrash: thrashIcon,
  tools: toolsIcon,
};

export const getSvgIcon = (iconKey: keyof typeof icons) => {
  const icon = icons[iconKey] || '??';
  return `<span class="uiIcon">${icon}</span>`;
};
