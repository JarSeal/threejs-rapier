import * as THREE from 'three/webgpu';
import { getRootScene } from './Scene';
import { getDebugToolsState } from '../debug/DebugToolsManager';

// Global helpers and won't be deleted on scene change
let axesHelper: THREE.AxesHelper | null = null;
let gridHelper: THREE.GridHelper | null = null;
let polarGridHelper: THREE.PolarGridHelper | null = null;

// Axes helper
export const createAxesHelper = (size?: number) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (axesHelper) {
    axesHelper.removeFromParent();
    axesHelper.dispose();
  }
  if (!size) size = getDebugToolsState().helpers.axesHelperSize;
  axesHelper = new THREE.AxesHelper(size);
  rootScene.add(axesHelper);
};
export const toggleAxesHelperVisibility = (show: boolean) => {
  if (axesHelper) {
    axesHelper.visible = show;
    return;
  }
  if (!show) return;
  createAxesHelper();
};

// Grid helper
export const createGridHelper = (
  gridSize: number,
  gridDivisionsSize: number,
  centerLineColor: number,
  gridColor: number
) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (gridHelper) {
    gridHelper.removeFromParent();
    gridHelper.dispose();
  }
  gridHelper = new THREE.GridHelper(gridSize, gridDivisionsSize, centerLineColor, gridColor);
  rootScene.add(gridHelper);
};
export const toggleGridHelperVisibility = (show: boolean) => {
  if (gridHelper) {
    gridHelper.visible = show;
    return;
  }
  if (!show) return;
  const debugToolsState = getDebugToolsState();
  createGridHelper(
    debugToolsState.helpers.gridSize,
    debugToolsState.helpers.gridDivisionsSize,
    debugToolsState.helpers.gridColorCenterLine,
    debugToolsState.helpers.gridColorGrid
  );
};

// Polar grid helper
export const createPolarGridHelper = (
  radius: number,
  sectors: number,
  rings: number,
  divisions: number
) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (polarGridHelper) {
    polarGridHelper.removeFromParent();
    polarGridHelper.dispose();
  }
  polarGridHelper = new THREE.PolarGridHelper(radius, sectors, rings, divisions);
  rootScene.add(polarGridHelper);
};
export const togglePolarGridHelperVisibility = (show: boolean) => {
  if (polarGridHelper) {
    polarGridHelper.visible = show;
    return;
  }
  if (!show) return;
  const debugToolsState = getDebugToolsState();
  createPolarGridHelper(
    debugToolsState.helpers.polarGridRadius,
    debugToolsState.helpers.polarGridSectors,
    debugToolsState.helpers.polarGridRings,
    debugToolsState.helpers.polarGridDivisions
  );
};
