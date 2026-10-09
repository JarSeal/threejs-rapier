import type * as THREE from 'three/webgpu';
import { IS_DEBUG_ENV } from '../../../_engine/core/Config';
import { getECSWorld } from '../../../_engine/core/ECS';
import { getMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';

export const DEBUG_TAB_SCENE_ID = 'exampleDebugTab';

// #region debug-tab-scene (shown in the Hub: hub/pages/examples/debug-tab/)
/** The scene's settings. The debug tab binds to this object and saves its two keys. */
export const BOX_DEFAULTS = { count: 12, color: '#e8833a' };
export const boxSettings = { ...BOX_DEFAULTS };

let boxIds: number[] = [];

/** (Re)builds the ring of boxes from the settings */
export const buildBoxes = () => {
  const world = getECSWorld();
  for (const id of boxIds) if (world.isAlive(id)) world.deleteEntity(id);
  boxIds = Array.from({ length: boxSettings.count }, (_, i) => {
    const angle = (i / boxSettings.count) * Math.PI * 2;
    return createMeshEntity({
      geo: { id: 'debugTabBox', type: 'BOX' },
      mat: { id: 'debugTabBox', type: 'STANDARD', params: { color: boxSettings.color } },
      position: { x: Math.cos(angle) * 4, y: 0.5, z: Math.sin(angle) * 4 },
      castShadow: true,
    });
  });
};

/** Every box shares one material: changing its colour changes them all */
export const setBoxColor = (color: string) => {
  boxSettings.color = color;
  (getMaterial('debugTabBox') as THREE.MeshStandardMaterial | undefined)?.color.set(color);
};

/** Moves every box to a random place on the ground */
export const shuffleBoxes = () => {
  const world = getECSWorld();
  for (const id of boxIds) {
    const pos = { x: Math.random() * 10 - 5, y: 0.5, z: Math.random() * 10 - 5 };
    world.setTransform(id, { pos });
  }
};

export const getBoxCount = () => boxIds.length;

export const scene = async () => {
  createMeshEntity({
    geo: { id: 'debugTabGround', type: 'BOX', params: { width: 12, height: 0.2, depth: 12 } },
    mat: { id: 'debugTabGround', type: 'STANDARD', params: { color: '#59606e' } },
    position: { y: -0.1 },
    receiveShadow: true,
  });

  // Debug env only: a dynamic import, so the tab's code (and Tweakpane) isn't in a production
  // build. Creating the tab loads the saved settings into boxSettings, before the boxes are built.
  if (IS_DEBUG_ENV) {
    const { createBoxesTab } = await import('./_dbg__exampleDebugTab');
    createBoxesTab();
  }

  buildBoxes();
};
// #endregion debug-tab-scene
