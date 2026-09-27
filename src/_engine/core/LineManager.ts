import { lerror } from '../utils/Logger';
import { existsOrThrow } from '../utils/assert';
import type { CoreEntityOpts } from '../schemas/_helperSchemas';
import { ECSWorld, getECSWorld } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import { getFatLineBackendFactory, loadFatLineBackend } from './Lines/LineBackend';
import { retagLineEntity } from './Lines/LineEntity';
import { LineObject } from './Lines/LineObject';
import {
  getRegisteredLine,
  getRegisteredLines,
  nextLineId,
  registerLine,
} from './Lines/LineRegistry';
import { registerLineTimeSystem } from './Lines/LineSystem';
import type { LineProps } from './Lines/LineTypes';

export { LineObject } from './Lines/LineObject';
export type { LineWriter } from './Lines/LineWriter';
export type * from './Lines/LineTypes';
export * from './Lines/LineBuilders';
export { LINE_PULSE_MAX_COLORS, lineTimeUniform } from './Lines/LinePulse';

let hooksRegistered = false;

/** The entity side went first (deleted, or its LINE component removed): dispose the line
 * without it trying to take the entity down again. */
const disposeEntityLine = (entityId: number, world: ECSWorld) => {
  const line = getLineForEntity(entityId, world);
  if (!line || line.entityBinding?.world !== world || line.entityBinding.entityId !== entityId) {
    return;
  }
  line.entityBinding = null;
  line.dispose();
};

/**
 * Registers the line system: the per-frame time uniform every pulsing line reads, and the
 * LINE component hooks that dispose an entity's line with it. Called once by InitEngine;
 * without it, pulses stand still and entity lines outlive their entities.
 */
export const registerLineManager = () => {
  registerLineTimeSystem();
  if (hooksRegistered) return;
  hooksRegistered = true;
  // deleteEntity runs only onDeleteEntity hooks, removeComponent only onRemoveComponent
  ECSWorld.registerComponentHooks(ComponentType.LINE, {
    onDeleteEntity: disposeEntityLine,
    onRemoveComponent: disposeEntityLine,
  });
};

/**
 * Creates a line-segment object and attaches it (to the root scene unless `props.attach`
 * says otherwise). The returned handle is plain gameplay API: no ECS world involved. It
 * lives until it is disposed or the scene changes — a scene switch disposes every line
 * that is not `persistent` or owned by an entity (disposeNonPersistentLines).
 *
 * A line wider than 1px needs the thick-line backend, which is loaded on demand: until it
 * arrives the line draws 1px and then upgrades itself. Await `preloadFatLineBackend()`
 * first when the width must be right on the first frame.
 *
 * @example
 * // Build once
 * const outline = createLines({ segments: box3EdgesToSegments(box), color: 0x00ffff });
 *
 * // Refill every frame, allocation-free
 * const trail = createLines({ capacity: 256, growth: 'FIXED' });
 * const w = trail.beginWrite();
 * for (...) w.segment(ax, ay, az, bx, by, bz);
 * trail.endWrite();
 */
export const createLines = (props: LineProps = {}): LineObject => {
  const id = props.id ?? nextLineId();
  if (getRegisteredLine(id)) {
    const msg = `A line with the id "${id}" already exists. Dispose the old line first or pick another id (createLines).`;
    lerror(msg);
    throw new Error(msg);
  }
  const line = new LineObject(id, props);
  registerLine(line);
  return line;
};

/** Returns a live line by id. */
export const getLine = (id: string) => getRegisteredLine(id);

/** Returns every live line. */
export const getAllLines = () => Array.from(getRegisteredLines().values());

/** Disposes every live line, entity-owned and persistent ones included. */
export const disposeAllLines = () => {
  for (const line of getAllLines()) line.dispose();
};

/** Disposes every line that is neither `persistent` nor owned by an entity (those follow
 * their entity: clearNonPersistent deletes it, and its line with it). Runs on every scene
 * switch (SceneLoader). */
export const disposeNonPersistentLines = () => {
  for (const line of getAllLines()) {
    if (!line.persistent && !line.entityBinding) line.dispose();
  }
};

// ----------------------------------------------------------------------------
// ECS
// ----------------------------------------------------------------------------

/**
 * Creates a line as an ECS entity, like createMeshEntity/createGroupEntity: its Object3D
 * is the entity's OBJECT3D (tagged TAG_IS_LINE, never TAG_IS_MESH), the ECS transform
 * places it (`props.localTransform` seeds it), deleting the entity disposes the line and
 * disposing the line deletes the entity. A backend swap re-points OBJECT3D at the new
 * Object3D, so read OBJECT3D (or `getLineForEntity(id).object3D`) each time, never cache it.
 * @returns (number) the entity id
 */
export const createLineEntity = (
  props: LineProps = {},
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createLineEntity.');
  const line = createLines({
    ...props,
    id: props.id ?? entityOpts?.appId,
    attach: entityOpts?.doNotAddToScene ? { to: 'NONE' } : props.attach ?? { to: 'ROOT_SCENE' },
  });
  const obj = line.object3D;

  const entityId = world.createEntity(entityOpts);
  obj.userData.entityId = entityId;
  line.entityBinding = { world, entityId, ownsEntity: true };
  world.addComponent(entityId, ComponentType.OBJECT3D, { value: obj, _lastVersion: -1 });
  world.addComponent(entityId, ComponentType.LINE, { lineId: line.id });
  retagLineEntity(world, entityId);
  if (entityOpts?.persistent) world.addComponent(entityId, ComponentType.PERSISTENT, true);

  // The ECS transform owns placement from here on, starting where the props put it
  world.setTransform(entityId, {
    pos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rot: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
  });
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (transform && (obj.scale.x !== 1 || obj.scale.y !== 1 || obj.scale.z !== 1)) {
    transform.scale.copy(obj.scale);
    transform.setDirty();
    world.commitTransform(entityId, transform);
  }

  return entityId;
};

/**
 * Ties an existing line's lifetime to an entity: deleting the entity (or removing its LINE
 * component) disposes the line, disposing the line removes the component. Placement is
 * separate — `line.attach({ to: 'ENTITY', entityId })` parents it to the entity's Object3D.
 * An entity holds at most one line.
 */
export const bindLineToEntity = (line: LineObject, entityId: number, ecsWorld?: ECSWorld) => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in bindLineToEntity.');
  if (line.isDisposed || line.entityBinding || world.hasComponent(entityId, ComponentType.LINE)) {
    const msg = `Cannot bind line "${line.id}" to entity ${entityId}: the line is disposed or already bound, or the entity already has a line (bindLineToEntity).`;
    lerror(msg);
    throw new Error(msg);
  }
  line.entityBinding = { world, entityId, ownsEntity: false };
  world.addComponent(entityId, ComponentType.LINE, { lineId: line.id });
};

/** Returns the line an entity holds (createLineEntity/bindLineToEntity), if any. */
export const getLineForEntity = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  const lineId = world?.getComponent(entityId, ComponentType.LINE)?.lineId;
  return lineId === undefined ? undefined : getRegisteredLine(lineId);
};

/**
 * Loads the thick-line (FAT) backend, which draws lines wider than 1px. It lives in its own
 * chunk so an app that only draws 1px lines never downloads it — which also means a width
 * above 1px can never be honoured synchronously. Lines created before it has loaded draw
 * 1px and upgrade themselves when it arrives; await this first to avoid that.
 * @returns (Promise<boolean>) whether the backend is available
 */
export const preloadFatLineBackend = () => loadFatLineBackend();

/** Whether the thick-line backend has loaded (new wide lines are then created thick). */
export const isFatLineBackendAvailable = () => getFatLineBackendFactory() !== null;
