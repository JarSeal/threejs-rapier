import * as THREE from 'three/webgpu';
import { markDebugHelper } from '../../../debug/Profiler';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../../AppECSRegistry';
import { ECSWorld, getECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import {
  BOX_EDGE_SEGMENT_COUNT,
  createLines,
  LineObject,
  type LineWriter,
  writeBox3Edges,
} from '../../LineManager';
import { getLodSelectionCamera, getLodWorldSphere } from '../../Lod/LodSystem';

// The LOD overlay (docs/plans/_DONE_p348_ecs-lod-selection.md §6): a wire box per LOD entity in view,
// coloured by the level it shows. The box bounds the sphere the selection measures (level 0's
// bounds, scaled), so it shows what the screen size is computed from. A line has one colour, so
// each level has its own line, refilled every frame while the overlay is on. Default world only.
//
// "In view" is the selection's view: inside the selection camera's frustum (the main camera, or
// the active one with "use active camera"), and not disabled, frustum-culled or LOD-culled.

/** Level 0 green, 1 yellow, 2 orange, 3 red, 4 magenta, 5 and on blue. */
export const LOD_OVERLAY_COLORS = [0x30c040, 0xe0c020, 0xf08020, 0xd03020, 0xc040d0, 0x4080f0];
export const LOD_OVERLAY_COLOR_NAMES = ['green', 'yellow', 'orange', 'red', 'magenta', 'blue'];

/** Boxes per level line. Past it the FIXED line drops the rest, with its own warning. */
const MAX_BOXES_PER_LEVEL = 8192;

/** Created on the first enable, one per colour. */
const lines: LineObject[] = [];
/** Each line's writer for the frame (index-aligned with `lines`). */
const writers: LineWriter[] = [];
let isEnabled = false;
let isSystemRegistered = false;

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();

const createLevelLine = (index: number) => {
  const line = createLines({
    id: `LOD_DEBUG_OVERLAY_LEVEL_${index}`,
    capacity: MAX_BOXES_PER_LEVEL * BOX_EDGE_SEGMENT_COUNT,
    growth: 'FIXED',
    color: LOD_OVERLAY_COLORS[index],
    // 12 segments per box; instanced quads would cost far more than 1px lines
    backend: 'THIN',
    // Created once and outlives scenes
    persistent: true,
  });
  markDebugHelper(line.object3D);
  return line;
};

const lodOverlaySystem = (world: ECSWorld) => {
  if (!isEnabled || world !== getECSWorld()) return;

  for (let i = 0; i < lines.length; i++) writers[i] = lines[i].beginWrite();
  const camera = getLodSelectionCamera();
  if (camera) {
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(
      _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    );
    const disabled = world.getStorage(ComponentType.DISABLED);
    const frustumCulled = world.getStorage(ComponentType.TAG_FRUSTUM_CULLED);
    const lodCulled = world.getStorage(ComponentType.TAG_LOD_CULLED);
    const last = writers.length - 1;
    for (const [entityId, lod] of world.getStorage(ComponentType.LOD)) {
      if (disabled.has(entityId) || frustumCulled.has(entityId) || lodCulled.has(entityId)) {
        continue;
      }
      if (!getLodWorldSphere(entityId, lod, world, _sphere)) continue;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      const r = _sphere.radius;
      const c = _sphere.center;
      _box.min.set(c.x - r, c.y - r, c.z - r);
      _box.max.set(c.x + r, c.y + r, c.z + r);
      // Not applied yet: the mesh shows what it was created with, level 0
      writeBox3Edges(writers[Math.min(Math.max(lod.applied, 0), last)], _box);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    lines[i].endWrite();
    // An empty line would still draw (0 vertices, a WebGPU warning)
    lines[i].setVisible(writers[i].segmentCount > 0);
  }
};

export const isLodOverlayEnabled = () => isEnabled;

/** Shows or hides the overlay. The lines and the system are created on the first enable. */
export const setLodOverlayEnabled = (enabled: boolean) => {
  isEnabled = enabled;
  if (enabled && lines.length === 0) {
    for (let i = 0; i < LOD_OVERLAY_COLORS.length; i++) lines.push(createLevelLine(i));
  }
  if (!enabled) for (let i = 0; i < lines.length; i++) lines[i].setVisible(false);
  if (enabled && !isSystemRegistered) {
    isSystemRegistered = true;
    // Right after the selection and apply (registered earlier at the same order), before light
    // culling and the render: the boxes show this frame's levels. LATE_MAIN would be a frame late
    // (it runs after the render). Like the selection, it stands still while the app loop is paused.
    ECSWorld.registerPlugin((w) => {
      w.addSystem(
        ECSSystemStage.APP_RENDER_SYNC,
        'lodOverlaySystem',
        lodOverlaySystem,
        APP_RENDER_SYNC_ORDER.LOD_SELECTION
      );
    });
  }
  // Filled now too: with the app loop paused, the system doesn't run
  if (enabled) lodOverlaySystem(getECSWorld());
};
