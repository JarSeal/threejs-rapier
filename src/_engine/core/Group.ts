import * as THREE from 'three/webgpu';
import { deleteMesh } from './Mesh';
import { lwarn } from '../utils/Logger';

const groups: { [id: string]: THREE.Group } = {};

/**
 * Adds a Three.js object to a group
 * @param idOrGroup (string | THREE.Group) group id or Three.js group
 * @param obj (THREE.Object3D | THREE.Object3D[]) Three.js object3D or array of them
 * @returns Three.js group or undefined
 */
export const addToGroup = (
  idOrGroup: string | THREE.Group,
  obj: THREE.Object3D | THREE.Object3D[]
) => {
  if (typeof idOrGroup === 'string') {
    const group = groups[idOrGroup];
    if (!group) {
      lwarn(`Could not find group with id "${idOrGroup}" in addToGroup.`);
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

/**
 * Removes the Three.js object3D's from the group and possibly deletes meshes, geometries, materials, and/or textures
 * @param groupIdOrGroup (string | THREE.Group) group id or Three.js group
 * @param objIdOrIndex (string | string[] | number | number[]) Three.js object's id or index number to be removed in the group, or array of them
 * @param opts (object) optional delete options for meshes, geometries, materials, and/or textures
 * @returns Three.js group or undefined
 */
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
    lwarn(`Could not find group with id "${groupId}" in removeFromGroup.`);
    return;
  }
  if (typeof objIdOrIndex === 'string') {
    const obj = group.children.find((obj) => obj.userData.id === objIdOrIndex);
    if (!obj) {
      lwarn(
        `Could not find object in group "${groupId}" with object id "${objIdOrIndex}" in removeFromGroup.`
      );
      return group;
    }
    objectsToRemove.push(obj);
  } else if (typeof objIdOrIndex === 'number') {
    const obj = group.children[objIdOrIndex];
    if (!obj) {
      lwarn(
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
          lwarn(
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
        lwarn(
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

/**
 * Creates a Three.js group
 * @param id (string) optional group id, if not provided then the group's uuid is used as and id
 * @param obj (THREE.Object3D | THREE.Object3D[]) optional Three.js object3Ds to be added to the group on creation
 * @returns Three.js group
 */
export const createGroup = ({
  id,
  obj,
}: {
  id?: string;
  obj?: THREE.Object3D | THREE.Object3D[];
}) => {
  if (id && groups[id]) return groups[id];

  const group: THREE.Group | null = new THREE.Group();

  group.userData.id = id || group.uuid;
  groups[id || group.uuid] = group;

  if (obj) addToGroup(group, obj);

  return group;
};

/**
 * Returns a group or undefined based on the id
 * @param id (string) group id
 * @returns Three.js group | undefined
 */
export const getGroup = (id: string) => groups[id];

/**
 * Returns one or multiple groups based on the ids
 * @param id (array of strings) one or multiple groups ids
 * @returns Array of Three.js groups
 */
export const getGroups = (id: string[]) => id.map((meshId) => groups[meshId]);

const deleteOneGroup = (
  id: string,
  opts?: {
    deleteMeshes?: boolean;
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
    deleteAll?: boolean;
  }
) => {
  const group = groups[id];
  if (!group) return;
  const children = group.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if ((opts?.deleteMeshes || opts?.deleteAll) && 'isMesh' in child) {
      deleteMesh(child.userData.id, {
        deleteGeometries: opts?.deleteGeometries,
        deleteMaterials: opts?.deleteMaterials,
        deleteTextures: opts?.deleteTextures,
        deleteAll: opts?.deleteAll,
      });
    }
  }
  group.removeFromParent();
  delete groups[id];
};

/**
 * Deletes a light based on an id or Three.js group, or array of them
 * @param idOrGroup (string | string[] | THREE.Group | THREE.Group[]) group id or Three.js group, or array of them to be deleted
 * @param opts (object) optional delete options for meshes, geometries, materials, and/or textures
 */
export const deleteGroup = (
  idOrGroup: string | string[] | THREE.Group | THREE.Group[],
  opts?: {
    deleteMeshes?: boolean;
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
    deleteAll?: boolean;
  }
) => {
  if (typeof idOrGroup === 'string') {
    deleteOneGroup(idOrGroup, opts);
    return;
  }
  if ('isGroup' in idOrGroup) {
    const id = idOrGroup.userData.id;
    if (!id) {
      lwarn(`Could not find group with id "${id}" in deleteGroup.`);
      return;
    }
    deleteOneGroup(id, opts);
    return;
  }

  for (let i = 0; i < idOrGroup.length; i++) {
    const item = idOrGroup[i];
    if (typeof item === 'string') {
      deleteOneGroup(item as string, opts);
    } else {
      const id = item.userData.id;
      if (!id) {
        lwarn(`Could not find group with id "${id}" in deleteGroup (array of groups).`);
        return;
      }
      deleteOneGroup(id, opts);
    }
  }
};

/**
 * Returns all created groups that exist
 * @returns array of Three.js groups
 */
export const getAllGroups = () => groups;

/**
 * Checks, with a group id, whether a group exists or not
 * @param id (string) group id
 * @returns boolean
 */
export const doesGroupExist = (id: string) => Boolean(groups[id]);
