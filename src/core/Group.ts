import * as THREE from 'three';
import { deleteMesh } from './Mesh';
import { getLogger } from '../utils/Logger';

const groups: { [id: string]: THREE.Group } = {};

// @TODO: add JSDoc comment
export const addToGroup = (
  idOrGroup: string | THREE.Group,
  obj: THREE.Object3D | THREE.Object3D[]
) => {
  if (typeof idOrGroup === 'string') {
    const group = groups[idOrGroup];
    if (!group) {
      getLogger().warn(`Could not find group with id "${idOrGroup}" in addToGroup.`);
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        group.add(obj[i]);
      }
    } else {
      group.add(obj);
    }
    return group;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      idOrGroup.add(obj[i]);
    }
  } else {
    idOrGroup.add(obj);
  }
  return idOrGroup;
};

// @TODO: add JSDoc comment
export const removeFromGroup = (
  groupIdOrGroup: string | THREE.Group,
  objIdOrIndex: string | string[] | number | number[],
  opts?: {
    deleteMeshes?: boolean;
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
  }
) => {
  const objectsToRemove: THREE.Object3D[] = [];
  const group = typeof groupIdOrGroup === 'string' ? groups[groupIdOrGroup] : groupIdOrGroup;
  const groupId = group.userData.id;
  if (!group) {
    getLogger().warn(`Could not find group with id "${groupId}" in removeFromGroup.`);
    return;
  }
  if (typeof objIdOrIndex === 'string') {
    const obj = group.children.find((obj) => obj.userData.id === objIdOrIndex);
    if (!obj) {
      getLogger().warn(
        `Could not find object in group "${groupId}" with object id "${objIdOrIndex}" in removeFromGroup.`
      );
      return group;
    }
    objectsToRemove.push(obj);
  } else if (typeof objIdOrIndex === 'number') {
    const obj = group.children[objIdOrIndex];
    if (!obj) {
      getLogger().warn(
        `Could not find object in group "${groupId}" with index "${objIdOrIndex}" in removeFromGroup.`
      );
      return group;
    }
    objectsToRemove.push(obj);
  } else {
    // objIdOrIndex is an Array
    for (let i = 0; i < objIdOrIndex.length; i++) {
      if (typeof objIdOrIndex === 'string') {
        const obj = group.children.find((obj) => obj.userData.id === objIdOrIndex[i]);
        if (!obj) {
          getLogger().warn(
            `Could not find object in group "${groupId}" with object id "${objIdOrIndex[i]}" in removeFromGroup.`
          );
          continue;
        }
        objectsToRemove.push(obj);
        continue;
      }
      // objIdOrIndex[i] is a number
      const obj = group.children[objIdOrIndex[i] as number];
      if (!obj) {
        getLogger().warn(
          `Could not find object in group "${groupId}" with index "${objIdOrIndex[i]}" in removeFromGroup.`
        );
        continue;
      }
      objectsToRemove.push(obj);
    }
  }

  for (let i = 0; i < objectsToRemove.length; i++) {
    const child = objectsToRemove[i];
    group.remove(child);
    if (opts?.deleteMeshes && 'isMesh' in child && child.isMesh) {
      deleteMesh(child.userData.id, {
        deleteGeometries: opts?.deleteGeometries,
        deleteMaterials: opts?.deleteMaterials,
        deleteTextures: opts?.deleteTextures,
      });
    }
  }

  return group;
};

// @TODO: add JSDoc comment
export const createGroup = ({
  id,
  obj,
}: {
  id?: string;
  obj?: THREE.Object3D | THREE.Object3D[];
}) => {
  const group: THREE.Group | null = new THREE.Group();

  if (id && groups[id]) {
    throw new Error(
      `Group with id "${id}" already exists. Pick another id or delete the group first before recreating it.`
    );
  }

  group.userData.id = id || group.uuid;
  groups[id || group.uuid] = group;

  if (obj) addToGroup(group, obj);

  return group;
};

// @TODO: add JSDoc comment
export const getGroup = (id: string) => groups[id];

// @TODO: add JSDoc comment
export const getGroups = (id: string[]) => id.map((meshId) => groups[meshId]);

const deleteOneGroup = (
  id: string,
  opts?: {
    deleteMeshes?: boolean;
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
  }
) => {
  const group = groups[id];
  if (!group) return;
  const children = group.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (opts?.deleteMeshes && 'isMesh' in child && child.isMesh) {
      deleteMesh(child.userData.id, {
        deleteGeometries: opts?.deleteGeometries,
        deleteMaterials: opts?.deleteMaterials,
        deleteTextures: opts?.deleteTextures,
      });
    }
  }
  group.removeFromParent();
  delete groups[id];
};

// @TODO: add JSDoc comment
export const deleteGroup = (
  id: string | string[],
  opts?: {
    deleteMeshes?: boolean;
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
  }
) => {
  if (typeof id === 'string') {
    deleteOneGroup(id, opts);
    return;
  }

  for (let i = 0; i < id.length; i++) {
    deleteOneGroup(id[i], opts);
  }
};

// @TODO: add JSDoc comment
export const getAllGroups = () => groups;
