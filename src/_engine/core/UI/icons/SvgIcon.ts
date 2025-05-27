import arrowClockwiseIcon from './svg/arrow-clockwise.svg?raw';
import arrowCounterClockwiseIcon from './svg/arrow-counterclockwise.svg?raw';
import aspectRatioIcon from './svg/aspect-ratio.svg?raw';
import cameraIcon from './svg/camera2.svg?raw';
import cameraReelsIcon from './svg/camera-reels-fill.svg?raw';
import cloudSunIcon from './svg/cloud-sun-fill.svg?raw';
import databaseXIcon from './svg/database-fill-x.svg?raw';
import easelIcon from './svg/easel-fill.svg?raw';
import fileAsterixIcon from './svg/file-earmark-medical-fill.svg?raw';
import fileCodeIcon from './svg/file-earmark-code-fill.svg?raw';
import gpuCardIcon from './svg/gpu-card.svg?raw';
import infinityIcon from './svg/infinity.svg?raw';
import lightBulbIcon from './svg/lightbulb-fill.svg?raw';
import lampFillIcon from './svg/lamp-fill.svg?raw';
import rocketTakeoffIcon from './svg/rocket-takeoff-fill.svg?raw';
import speedometerIcon from './svg/speedometer.svg?raw';
import thrashIcon from './svg/trash3-fill.svg?raw';
import toolsIcon from './svg/tools.svg?raw';

const icons = {
  arrowClockwise: arrowClockwiseIcon,
  arrowCounterClockwise: arrowCounterClockwiseIcon,
  aspectRatio: aspectRatioIcon,
  camera: cameraIcon,
  cameraReels: cameraReelsIcon,
  cloudSun: cloudSunIcon,
  databaseX: databaseXIcon,
  easel: easelIcon,
  fileAsterix: fileAsterixIcon,
  fileCode: fileCodeIcon,
  gpuCard: gpuCardIcon,
  infinity: infinityIcon,
  lightBulb: lightBulbIcon,
  lamp: lampFillIcon,
  rocketTakeoff: rocketTakeoffIcon,
  speedometer: speedometerIcon,
  thrash: thrashIcon,
  tools: toolsIcon,
};

export const getSvgIcon = (iconKey: keyof typeof icons, size?: 'small') => {
  const icon = icons[iconKey] || '??';
  return `<span class="uiIcon${size === 'small' ? ' smallIcon' : ''}">${icon}</span>`;
};
