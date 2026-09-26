import type * as THREE from 'three/webgpu';
import type { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';

/**
 * @internal
 * A line's tie to an ECS entity. `ownsEntity` is true when the line IS the entity (its
 * Object3D is the entity's OBJECT3D, see createLineEntity): disposing the line then
 * deletes the entity, and a backend swap re-points OBJECT3D. Otherwise the entity only
 * owns the line's lifetime (bindLineToEntity).
 */
export type LineEntityBinding = { world: ECSWorld; entityId: number; ownsEntity: boolean };

/**
 * @internal
 * Makes an entity whose OBJECT3D is a line tagged as a line. A thick line is a Mesh
 * subclass, so the OBJECT3D auto-tagger (ECSCoreSystems.ts) stamps it TAG_IS_MESH, which
 * would subscribe it to MeshManager's disposeMesh — a second owner tearing the same
 * object down. Neither tag has add/remove hooks, so swapping them is side-effect free.
 */
export const retagLineEntity = (world: ECSWorld, entityId: number) => {
  if (world.hasComponent(entityId, ComponentType.TAG_IS_MESH)) {
    world.removeComponent(entityId, ComponentType.TAG_IS_MESH);
  }
  if (!world.hasComponent(entityId, ComponentType.TAG_IS_LINE)) {
    world.addComponent(entityId, ComponentType.TAG_IS_LINE, true);
  }
};

/** @internal After a backend swap: point the entity's OBJECT3D at the new object, re-tag. */
export const repointLineEntity = (
  binding: LineEntityBinding,
  from: THREE.Object3D,
  to: THREE.Object3D
) => {
  const { world, entityId } = binding;
  if (!world.isAlive(entityId)) return;
  const obj3D = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (obj3D?.value !== from) return;
  obj3D.value = to;
  retagLineEntity(world, entityId);
};

/** @internal A bound line was disposed by its owner: take the entity side down too. (When
 * the entity goes first, LineManager's hooks clear the binding before disposing.) */
export const releaseLineEntity = ({ world, entityId, ownsEntity }: LineEntityBinding) => {
  if (!world.isAlive(entityId)) return;
  if (ownsEntity) {
    world.deleteEntity(entityId);
  } else {
    world.removeComponent(entityId, ComponentType.LINE);
  }
};
