import * as THREE from 'three/webgpu';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { getRootScene } from './Scene';
import { existsOrThrow, ThreeEuler, ThreeQuoternion } from '../utils/helpers';
import { ComponentType } from './ECS/ECSCoreComponents';
import { setTransform } from '../utils/ECSHelpers';
import { lwarn } from '../utils/Logger';
import { CoreEntityOpts } from '../schemas/_helperSchemas';

// Register onDeleteEntity hook for TAG_IS_GROUP
ECSWorld.registerComponentHooks(ComponentType.TAG_IS_GROUP, {
  onDeleteEntity: (entityId, world) => disposeGroup(entityId, world),
});

export type GroupProps = {
  appId?: string;
  objects?: THREE.Object3D | THREE.Object3D[];
  position?: { x?: number; y?: number; z?: number };
  rotation?: { x?: number; y?: number; z?: number };
  quaternion?: THREE.Quaternion;
};

/**
 * Creates a standard Three.js Group Entity context attached directly to the active ECS World
 */
export const createGroupEntity = (
  props: GroupProps,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createGroupEntity.');

  const group = new THREE.Group();
  const appId = props.appId || entityOpts?.appId || group.uuid;

  group.userData.id = appId;
  if (entityOpts?.debugData?.name) {
    group.name = entityOpts.debugData.name;
    group.userData.name = group.name;
  }
  if (entityOpts?.debugData?.description) {
    group.userData.description = entityOpts.debugData.description;
  }

  // Add sub-elements immediately if provided on instantiation pass
  if (props.objects) {
    addToGroupEntity(group, props.objects);
  }

  if (!entityOpts?.doNotAddToScene) {
    const rootScene = existsOrThrow(
      getRootScene(),
      'Could not find root scene in createGroupEntity.'
    );
    rootScene.add(group);
  }

  const entityId = world.createEntity(entityOpts);

  world.addComponent(entityId, ComponentType.OBJECT3D, {
    value: group,
    _lastVersion: -1,
  });
  world.addComponent(entityId, ComponentType.TAG_IS_GROUP, true);

  const tra = {
    pos: { x: group.position.x, y: group.position.y, z: group.position.z },
    rot: {
      x: group.quaternion.x,
      y: group.quaternion.y,
      z: group.quaternion.z,
      w: group.quaternion.w,
    },
  };

  if (props.position) {
    if (props.position.x !== undefined) tra.pos.x = props.position.x;
    if (props.position.y !== undefined) tra.pos.y = props.position.y;
    if (props.position.z !== undefined) tra.pos.z = props.position.z;
  }

  if (props.quaternion) {
    tra.rot.x = props.quaternion.x;
    tra.rot.y = props.quaternion.y;
    tra.rot.z = props.quaternion.z;
    tra.rot.w = props.quaternion.w;
  } else if (props.rotation) {
    const rot = ThreeEuler.set(group.rotation.x, group.rotation.y, group.rotation.z);
    if (props.rotation.x !== undefined) rot.x = props.rotation.x;
    if (props.rotation.y !== undefined) rot.y = props.rotation.y;
    if (props.rotation.z !== undefined) rot.z = props.rotation.z;
    const quat = ThreeQuoternion.setFromEuler(rot);
    tra.rot.x = quat.x;
    tra.rot.y = quat.y;
    tra.rot.z = quat.z;
    tra.rot.w = quat.w;
  }

  setTransform(entityId, tra);

  return entityId;
};

/**
 * Adds an Object3D or an array of elements into a managed Group Entity
 */
export const addToGroupEntity = (
  entityIdOrGroup: number | THREE.Group,
  objects: THREE.Object3D | THREE.Object3D[],
  ecsWorld?: ECSWorld
): THREE.Group | undefined => {
  let group: THREE.Group | undefined;

  if (typeof entityIdOrGroup === 'number') {
    const world = ecsWorld || getECSWorld();
    const objComp = world?.getComponent(entityIdOrGroup, ComponentType.OBJECT3D);
    if (!objComp) {
      lwarn(
        `[Group Manager] Entity "${entityIdOrGroup}" has no valid OBJECT3D track for additions.`
      );
      return;
    }
    group = objComp.value as THREE.Group;
  } else {
    group = entityIdOrGroup;
  }

  if (Array.isArray(objects)) {
    for (let i = 0; i < objects.length; i++) {
      group.add(objects[i]);
    }
  } else {
    group.add(objects);
  }

  return group;
};

/**
 * Removes elements from a group entity context, running structural reference reductions if configured
 */
export const removeFromGroupEntity = (
  entityIdOrGroup: number | THREE.Group,
  objectIdOrIndex: string | string[] | number | number[],
  opts?: {
    deleteMeshes?: boolean;
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
  },
  ecsWorld?: ECSWorld
): THREE.Group | undefined => {
  let group: THREE.Group | undefined;
  const world = ecsWorld || getECSWorld();

  if (typeof entityIdOrGroup === 'number') {
    const objComp = world?.getComponent(entityIdOrGroup, ComponentType.OBJECT3D);
    if (!objComp) return;
    group = objComp.value as THREE.Group;
  } else {
    group = entityIdOrGroup;
  }

  const groupId = group.userData.id;
  const objectsToRemove: THREE.Object3D[] = [];
  const targetTokens = Array.isArray(objectIdOrIndex) ? objectIdOrIndex : [objectIdOrIndex];

  for (let i = 0; i < targetTokens.length; i++) {
    const target = targetTokens[i];
    let foundChild: THREE.Object3D | undefined;

    if (typeof target === 'string') {
      foundChild = group.children.find((child) => child.userData.id === target);
    } else if (typeof target === 'number') {
      foundChild = group.children[target];
    }

    if (foundChild) {
      objectsToRemove.push(foundChild);
    } else {
      lwarn(
        `[Group Manager] Object target "${target}" was not found inside entity group space "${groupId}".`
      );
    }
  }

  // Safely detach tracking and trigger GPU recycling rules
  for (let i = 0; i < objectsToRemove.length; i++) {
    const child = objectsToRemove[i];
    group.remove(child);

    // If the child object has an active ECS presence matching the mesh tag, recycle it cleanly
    if (opts?.deleteMeshes && 'isMesh' in child && child.isMesh) {
      // Look up if this matching mesh child exists as a standalone entity to dispose it cleanly
      const id = child.userData.appId || child.userData.id;
      const childEntityId = getEntityIdByAppId(id);
      if (childEntityId !== undefined) {
        world?.deleteEntity(childEntityId);
      } else {
        // Fallback trace to raw memory clearing logic if object is unmanaged by ECS root tracks
        child.removeFromParent();
        if ('geometry' in child) (child as THREE.Mesh).geometry.dispose();
      }
    }
  }

  return group;
};

/**
 * Sweeps and cleans up native Three.js allocations on entity deletion
 */
export const disposeGroup = (entityId: number, world: ECSWorld) => {
  const groupComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (!groupComp) return;

  const group = groupComp.value as THREE.Group;

  // Process children in reverse order to protect underlying tracking array vectors from length mutations
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];

    // Auto-cascade resource removal loops to children entities if managed by the ECS world
    const id = child.userData.appId || child.userData.id;
    const childEntityId = getEntityIdByAppId(id);
    if (childEntityId !== undefined) {
      world.deleteEntity(childEntityId);
    } else {
      child.removeFromParent();
    }
  }

  group.removeFromParent();
};
