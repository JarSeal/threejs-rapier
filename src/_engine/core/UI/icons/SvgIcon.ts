import aekashaIcon from './svg/aekasha.svg?raw';
import alertIcon from './svg/exclamation-octagon-fill.svg?raw';
import arrowClockwiseIcon from './svg/arrow-clockwise.svg?raw';
import arrowCounterClockwiseIcon from './svg/arrow-counterclockwise.svg?raw';
import assetsIcon from './svg/assets-collection.svg?raw';
import aspectRatioIcon from './svg/aspect-ratio.svg?raw';
import cameraIcon from './svg/camera2.svg?raw';
import cameraReelsIcon from './svg/camera-reels.svg?raw';
import circleCheckCutoutIcon from './svg/circle-check-cutout.svg?raw';
import cloudSunIcon from './svg/cloud-sun-fill.svg?raw';
import databaseXIcon from './svg/database-fill-x.svg?raw';
import easelIcon from './svg/easel-fill.svg?raw';
import ecsNodesIcon from './svg/ecs-nodes.svg?raw';
import eraserIcon from './svg/eraser-fill.svg?raw';
import fileAsterixIcon from './svg/file-earmark-medical-fill.svg?raw';
import fileCodeIcon from './svg/file-earmark-code-fill.svg?raw';
import gearIcon from './svg/gear-fill.svg?raw';
import geometryIcon from './svg/geometry-cube.svg?raw';
import gpuCardIcon from './svg/gpu-card.svg?raw';
import heartArrowIcon from './svg/heart-arrow.svg?raw';
import infinityIcon from './svg/infinity.svg?raw';
import infoIcon from './svg/info-circle-fill.svg?raw';
import lightBulbIcon from './svg/lightbulb-fill.svg?raw';
import lampIcon from './svg/lamp.svg?raw';
import lockIcon from './svg/lock-fill.svg?raw';
import lodIcon from './svg/lod.svg?raw';
import materialIcon from './svg/material-sphere.svg?raw';
import memoryIcon from './svg/memory.svg?raw';
import objectsCubesIcon from './svg/cubes-wireframe.svg?raw';
import pauseIcon from './svg/pause-fill.svg?raw';
import pinIcon from './svg/pin-angle-fill.svg?raw';
import personArmsUpIcon from './svg/person-arms-up.svg?raw';
import playFillIcon from './svg/play-fill.svg?raw';
import postFxIcon from './svg/post-fx.svg?raw';
import profilerIcon from './svg/profiler-pulse.svg?raw';
import redoIcon from './svg/arrow-90deg-right.svg?raw';
import rocketIcon from './svg/rocket.svg?raw';
import rocketTakeoffIcon from './svg/rocket-takeoff-fill.svg?raw';
import runtimeViewIcon from './svg/runtime-view.svg?raw';
import spatialGridIcon from './svg/spatial-grid.svg?raw';
import speedometerIcon from './svg/speedometer.svg?raw';
import stopIcon from './svg/stop-fill.svg?raw';
import textureIcon from './svg/texture-image.svg?raw';
import thrashIcon from './svg/trash3-fill.svg?raw';
import toolsIcon from './svg/tools.svg?raw';
import undoIcon from './svg/arrow-90deg-left.svg?raw';
import warningIcon from './svg/exclamation-triangle-fill.svg?raw';
import xIcon from './svg/x.svg?raw';
import xBoldIcon from './svg/x-bold.svg?raw';

/**
 * @license Bootstrap Icons, Copyright 2019-2024 The Bootstrap Authors
 * SPDX-License-Identifier: MIT (LICENSE-bootstrap-icons.txt)
 */

/**
 * Every icon in `svg/` follows Bootstrap Icons' form: `<svg xmlns width="16" height="16"
 * fill="currentColor" class="bi bi-<file name>" viewBox="0 0 16 16">` and paths without
 * transforms or fixed colours, so it takes the text colour. A line icon has `fill="none"` and
 * `stroke="currentColor"` on its paths (1 wide, 0.75 for inner detail). Files without a key below
 * aren't in the bundle (`github.svg` and `three-js.svg` are the Hub's brand marks, copied into
 * `hub/_assets/icons/`).
 *
 * Most of them are Bootstrap Icons' own (https://icons.getbootstrap.com, MIT, the licence in
 * `LICENSE-bootstrap-icons.txt`); the rest are drawn for the engine in the same form. A new one
 * from Bootstrap Icons is copied as it is, under its own file name.
 */
const icons = {
  aekasha: aekashaIcon,
  alert: alertIcon,
  arrowClockwise: arrowClockwiseIcon,
  arrowCounterClockwise: arrowCounterClockwiseIcon,
  assets: assetsIcon,
  aspectRatio: aspectRatioIcon,
  camera: cameraIcon,
  cameraReels: cameraReelsIcon,
  circleCheckCutout: circleCheckCutoutIcon,
  cloudSun: cloudSunIcon,
  databaseX: databaseXIcon,
  easel: easelIcon,
  ecs: ecsNodesIcon,
  eraser: eraserIcon,
  fileAsterix: fileAsterixIcon,
  fileCode: fileCodeIcon,
  gear: gearIcon,
  geometry: geometryIcon,
  gpuCard: gpuCardIcon,
  heartArrow: heartArrowIcon,
  infinity: infinityIcon,
  info: infoIcon,
  lightBulb: lightBulbIcon,
  lamp: lampIcon,
  lock: lockIcon,
  lod: lodIcon,
  material: materialIcon,
  memory: memoryIcon,
  objectsCubes: objectsCubesIcon,
  pause: pauseIcon,
  personArmsUp: personArmsUpIcon,
  pin: pinIcon,
  playFill: playFillIcon,
  postFx: postFxIcon,
  profiler: profilerIcon,
  redo: redoIcon,
  rocket: rocketIcon,
  rocketTakeoff: rocketTakeoffIcon,
  runtime: runtimeViewIcon,
  spatialGrid: spatialGridIcon,
  speedometer: speedometerIcon,
  stop: stopIcon,
  texture: textureIcon,
  thrash: thrashIcon,
  tools: toolsIcon,
  undo: undoIcon,
  warning: warningIcon,
  x: xIcon,
  xBold: xBoldIcon,
};

/** Key of an engine UI icon (see {@link getSvgIcon}). */
export type SvgIconKey = keyof typeof icons;

export const getSvgIcon = (iconKey: SvgIconKey, size?: 'small') => {
  const icon = icons[iconKey] || '??';
  return `<span class="uiIcon${size === 'small' ? ' smallIcon' : ''}">${icon}</span>`;
};
