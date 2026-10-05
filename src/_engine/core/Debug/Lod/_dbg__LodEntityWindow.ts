import * as THREE from 'three/webgpu';
import { registerEntityWindowOpener } from '../../../debug/Profiler';
import { CMP } from '../../../utils/CMP';
import { ECSWorld, getECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import {
  DEFAULT_LOD_HYSTERESIS,
  getLodBias,
  getLodDebugOptions,
  getLodSelectionCamera,
  getLodWorldSphere,
  type LodMeasure,
  measureLodEntity,
} from '../../Lod/LodSystem';
import type { LodData } from '../../Lod/LodTypes';
import {
  getKindWindowId,
  getDraggableWindowsOfKind,
  registerDraggableWindowKind,
  toggleDraggableWindow,
} from '../../UI/DraggableWindow';

// The LOD window (docs/plans/p348_ecs-lod-selection.md §6, per mesh): one `LOD` entity's live
// screen size, what it shows and why, and each level's threshold as the distance it switches at
// with the current camera (FOV and zoom), both biases and the hysteresis included. Default world
// only. Entity ids don't outlive a scene, so the window closes on a scene change and isn't saved.

const LOD_WIN_KIND = 'lodEntityWindow';
const REFRESH_MS = 250;

const _measure: LodMeasure = {
  center: new THREE.Vector3(),
  worldRadius: 0,
  distance: 0,
  screenSize: 0,
  k: 0,
  isOrtho: false,
};

const getLodMesh = (entityId: number, world: ECSWorld) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  return obj instanceof THREE.Mesh ? obj : undefined;
};

/** A readable name: the mesh's id, the app id the entity was given, else level 0's geometry id (a
 * pool's meshes and their instances have no id of their own). */
export const getLodEntityName = (entityId: number, world: ECSWorld) => {
  const meshId = getLodMesh(entityId, world)?.userData.id;
  if (meshId) return String(meshId);
  const appId = world.getComponent(entityId, ComponentType.APP_ID);
  if (appId?.isFixed) return appId.id;
  const lod = world.getComponent(entityId, ComponentType.LOD);
  const geoId = lod?._levels[0]?.geometry.userData.id;
  if (geoId) return lod?._target ? `${geoId} instance` : String(geoId);
  return `Entity ${entityId}`;
};

const getKindLabel = (entityId: number, lod: LodData, world: ECSWorld) => {
  if (lod._target) return 'pool instance';
  const mesh = getLodMesh(entityId, world);
  if ((mesh as THREE.InstancedMesh | undefined)?.isInstancedMesh) {
    return `instanced mesh (${(mesh as THREE.InstancedMesh).count} instances)`;
  }
  return 'mesh';
};

const triangles = (geometry: THREE.BufferGeometry) =>
  Math.round((geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3);

const formatDistance = (d: number) => {
  if (!Number.isFinite(d)) return '∞';
  if (d >= 100) return `${d.toFixed(0)} m`;
  if (d >= 10) return `${d.toFixed(1)} m`;
  return `${d.toFixed(2)} m`;
};

const formatScreenSize = (s: number) => (Number.isFinite(s) ? s.toFixed(4) : '∞');

const getStateText = (entityId: number, lod: LodData, world: ECSWorld) => {
  const keeps = lod.applied >= 0 ? `, keeps level ${lod.applied}` : '';
  if (world.isDisabled(entityId)) return `out of view (disabled${keeps})`;
  if (world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)) {
    return `out of view (frustum culled${keeps})`;
  }
  if (world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)) return 'LOD culled (hidden)';
  if (lod.applied < 0) return 'not selected yet (shows level 0)';
  return lod.level === lod.applied
    ? `level ${lod.applied}`
    : `level ${lod.applied} (level ${lod.level} selected)`;
};

const getSelectionText = () => {
  const opts = getLodDebugOptions();
  const parts: string[] = [];
  if (opts.forceLevel >= 0) parts.push(`forced to level ${opts.forceLevel}`);
  else if (opts.freeze) parts.push('frozen');
  parts.push(opts.useActiveCamera ? 'active camera' : 'main camera');
  return parts.join(', ');
};

const getCameraText = () => {
  const camera = getLodSelectionCamera();
  if ((camera as THREE.PerspectiveCamera | undefined)?.isPerspectiveCamera) {
    const cam = camera as THREE.PerspectiveCamera;
    return `perspective, fov ${cam.fov.toFixed(1)}°${cam.zoom !== 1 ? `, zoom ${cam.zoom}` : ''}`;
  }
  if ((camera as THREE.OrthographicCamera | undefined)?.isOrthographicCamera) {
    return `orthographic, zoom ${(camera as THREE.OrthographicCamera).zoom}`;
  }
  return 'none';
};

const row = (label: string, value: string) => `${label.padEnd(13)}${value}`;

/** The window's text: the entity's live readout and its levels' switch distances. */
const getLodEntityText = (entityId: number, world: ECSWorld) => {
  if (!world.isAlive(entityId)) return 'The entity no longer exists.';
  const lod = world.getComponent(entityId, ComponentType.LOD);
  if (!lod) return 'The entity has no LOD (any more).';
  if (lod._levels.length === 0) return 'The LOD has no levels (see the console warnings).';

  const isMeasured = measureLodEntity(entityId, world, _measure);
  const m = _measure;
  const h = lod.def.hysteresis ?? DEFAULT_LOD_HYSTERESIS;
  const lines = [
    row('Entity', `${entityId}  ${getLodEntityName(entityId, world)}`),
    row('Kind', getKindLabel(entityId, lod, world)),
    row('State', getStateText(entityId, lod, world)),
    row('Selection', getSelectionText()),
    row('Camera', getCameraText()),
  ];
  if (!isMeasured) {
    lines.push('', 'Nothing to measure (no mesh, Transform or usable camera).');
    return lines.join('\n');
  }
  lines.push(
    row('Screen size', formatScreenSize(m.screenSize)),
    row('Distance', formatDistance(m.distance)),
    row('Radius', formatDistance(m.worldRadius)),
    row(
      'Bias',
      `${(lod.def.bias ?? 1).toFixed(2)} × global ${getLodBias().toFixed(2)}, hysteresis ${h}`
    ),
    ''
  );

  // A level i above the last is taken (coming from a coarser one) at s ≥ screenSize_i, so at a
  // distance ≤ worldRadius × k / screenSize_i, and left for a coarser one below
  // screenSize_i × (1 - h), so beyond that distance / (1 - h). Culling works the same way.
  const switchDistance = (screenSize: number) =>
    m.isOrtho || screenSize <= 0 ? NaN : (m.worldRadius * m.k) / screenSize;
  const formatSwitch = (d: number) => (Number.isNaN(d) ? '—' : formatDistance(d));
  const tableRow = (marker: string, label: string, s: string, tris: string, d: number) =>
    `${marker}${label.padEnd(7)}${s.padStart(8)}${tris.padStart(9)}${formatSwitch(d).padStart(10)}${formatSwitch(d / (1 - h)).padStart(10)}`;

  const isHidden =
    world.isDisabled(entityId) ||
    world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED) ||
    world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED);
  const shown = isHidden ? -1 : Math.max(lod.applied, 0);
  const last = lod._levels.length - 1;
  lines.push(
    `  ${'Level'.padEnd(7)}${'screen'.padStart(8)}${'tris'.padStart(9)}${'in ≤'.padStart(10)}${'out >'.padStart(10)}`
  );
  for (let i = 0; i <= last; i++) {
    const marker = i === shown ? '▶ ' : '  ';
    const tris = String(triangles(lod._levels[i].geometry));
    if (i === last) {
      lines.push(tableRow(marker, String(i), '—', tris, NaN));
    } else {
      const s = lod.def.levels[i].screenSize;
      lines.push(tableRow(marker, String(i), s.toFixed(3), tris, switchDistance(s)));
    }
  }
  const cull = lod.def.cullScreenSize ?? 0;
  if (cull > 0) {
    const marker = world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED) ? '▶ ' : '  ';
    lines.push(tableRow(marker, 'Cull', cull.toFixed(3), '', switchDistance(cull)));
  }
  lines.push(
    '',
    m.isOrtho
      ? 'Orthographic: the screen size doesn’t change with the distance.'
      : '"in ≤": switches to the row at or within this distance, "out >": leaves it for a coarser one (or hides) beyond it.'
  );
  return lines.join('\n');
};

const createLodEntityWindowContent = (data?: { [key: string]: unknown }) => {
  const entityId = Number(data?.entityId);
  const world = getECSWorld();
  const text = CMP({
    tag: 'pre',
    style: {
      margin: '0',
      fontFamily: 'monospace',
      fontSize: '11px',
      lineHeight: '1.45',
      whiteSpace: 'pre-wrap',
    },
    text: getLodEntityText(entityId, world),
  });
  const interval = window.setInterval(
    () => text.updateText(getLodEntityText(entityId, world)),
    REFRESH_MS
  );
  const container = CMP({
    class: 'winPaddedContent',
    onRemoveCmp: () => window.clearInterval(interval),
  });
  container.add(text);
  return container;
};

registerDraggableWindowKind(LOD_WIN_KIND, { content: createLodEntityWindowContent });

const _sphere = new THREE.Sphere();
const _camPos = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();

/** The `LOD` entity nearest to the selection camera among those in its view and shown (the
 * overlay's), pool instances included. Undefined when there is none. */
export const findNearestLodEntityInView = (world: ECSWorld) => {
  const camera = getLodSelectionCamera();
  if (!camera) return undefined;
  camera.updateMatrixWorld();
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  _frustum.setFromProjectionMatrix(
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );
  let nearest: number | undefined;
  let nearestDistance = Infinity;
  for (const [entityId, lod] of world.getStorage(ComponentType.LOD)) {
    if (
      world.isDisabled(entityId) ||
      world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED) ||
      world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)
    ) {
      continue;
    }
    if (!getLodWorldSphere(entityId, lod, world, _sphere)) continue;
    if (!_frustum.intersectsSphere(_sphere)) continue;
    const distance = _sphere.center.distanceTo(_camPos);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = entityId;
    }
  }
  return nearest;
};

/** The entity ids whose LOD window is open. */
export const getOpenLodEntityWindowIds = () =>
  getDraggableWindowsOfKind(LOD_WIN_KIND)
    .filter((win) => win.isOpen)
    .map((win) => String(win.data?.entityId));

/** Opens the entity's LOD window, brings it to the front, or closes it when it is on top. */
export const toggleLodEntityWindow = (entityId: number) => {
  const world = getECSWorld();
  toggleDraggableWindow({
    id: getKindWindowId(LOD_WIN_KIND, String(entityId)),
    kind: LOD_WIN_KIND,
    position: { x: 120, y: 70 },
    size: { w: 470, h: 430 },
    title: `LOD: ${getLodEntityName(entityId, world)}`,
    isDebugWindow: true,
    data: { entityId },
    closeOnSceneChange: true,
  });
};

// The profiler's heaviest objects: a LOD mesh without a more specific window opens this one
registerEntityWindowOpener({
  id: 'lodEntity',
  label: 'LOD',
  priority: -1,
  canOpen: (world, entityId) =>
    world === getECSWorld() && world.hasComponent(entityId, ComponentType.LOD),
  toggle: (_world, entityId) => toggleLodEntityWindow(entityId),
});
