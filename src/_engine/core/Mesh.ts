import * as THREE from 'three/webgpu';
import { MatProps, createMaterial, deleteMaterial, doesMatExist, saveMaterial } from './Material';
import {
  createGeometry,
  deleteGeometry,
  doesGeoExist,
  saveGeometry,
  type GeoProps,
} from './Geometry';
import {
  createPhysicsObjectWithMesh,
  deletePhysicsObject,
  doesPOExist,
  type PhysicsParams,
} from './PhysicsRapier';

const meshes: { [id: string]: THREE.Mesh } = {};

export type MeshProps = {
  id?: string;
  geo: THREE.BufferGeometry | GeoProps;
  mat: THREE.Material | MatProps;
  phy?: PhysicsParams & { sceneId?: string; noWarnForUnitializedScene?: boolean };
  castShadow?: boolean;
  receiveShadow?: boolean;
};

/**
 * Creates a Three.js mesh
 * @param params (object) mesh params, { id: string (optional), geo: THREE.BufferGeometry | {@link GeoPropsB}, mat: THREE.Material | {@link MatProps}, phy?: {@link PhysicsParams} & { sceneId?: string, noWarnForUnitializedScene?: boolean } }
 * @returns THREE.Mesh
 */
export const createMesh = ({ id, geo, mat, phy, castShadow, receiveShadow }: MeshProps) => {
  if (id && meshes[id] && !phy) return meshes[id];

  let mesh: THREE.Mesh | null = null;
  let g = geo as THREE.BufferGeometry;
  let m = mat as THREE.Material;

  if (!id || (id && !meshes[id])) {
    if (!('isBufferGeometry' in geo)) g = createGeometry(geo);
    if (!('isMaterial' in mat)) m = createMaterial(mat);

    mesh = new THREE.Mesh(g, m);
  } else {
    mesh = meshes[id];
  }

  if (castShadow !== undefined) mesh.castShadow = castShadow;
  if (receiveShadow !== undefined) mesh.receiveShadow = receiveShadow;

  const savedMesh = saveMesh(mesh, id, true);

  if (phy && savedMesh) {
    createPhysicsObjectWithMesh({
      physicsParams: phy,
      meshOrMeshId: savedMesh,
      sceneId: phy.sceneId,
      noWarnForUnitializedScene: phy.noWarnForUnitializedScene,
    });
  }

  return savedMesh || mesh;
};

/**
 * Returns a created and existing Three.js mesh depending on the id
 * @param id (string) mesh id
 * @returns THREE.Mesh | undefined
 */
export const getMesh = (id: string) => meshes[id];

/**
 * Returns a created and existing Three.js meshes depending on the ids
 * @param id (array of strings) mesh ids
 * @returns array of (THREE.Mesh | undefined)
 */
export const getMeshes = (id: string[]) => id.map((meshId) => meshes[meshId]);

/** Returns all existing meshes
 * @returns (object) { [meshId: string]: THREE.Mesh }
 */
export const getAllMeshes = () => meshes;

export type DeleteMeshOptions = {
  deleteGeometries?: boolean;
  deleteMaterials?: boolean;
  deleteTextures?: boolean;
  deleteAll?: boolean;
};

const deleteOneMesh = (id: string, opts?: DeleteMeshOptions) => {
  const mesh = meshes[id];
  if (!mesh) return;
  if (opts?.deleteGeometries || opts?.deleteAll) {
    const geoId = mesh.geometry.userData.id;
    if (geoId) deleteGeometry(geoId);
  }
  if (opts?.deleteMaterials || opts?.deleteAll) {
    const deleteTextures =
      opts?.deleteTextures !== undefined ? opts.deleteTextures : opts?.deleteAll;
    if (Array.isArray(mesh.material)) {
      const matIds: string[] = [];
      for (let i = 0; i < mesh.material.length; i++) {
        const matId = mesh.material[i].userData.id;
        if (matId) matIds.push(matId);
      }
      deleteMaterial(matIds, deleteTextures);
    } else {
      const matId = mesh.material.userData.id;
      if (matId) deleteMaterial(matId, deleteTextures);
    }
  }

  if (mesh.userData.isPhysicsObject || doesPOExist(id)) {
    deletePhysicsObject(id);
  }

  mesh.removeFromParent();

  delete meshes[id];
};

/**
 * Deletes a mesh based on the mesh id. Options to delete the mesh's geometries, materials, and textures can also be given.
 * @param id (string) scene id
 * @param opts (object) optional delete options
 */
export const deleteMesh = (
  id: string | string[],
  opts?: {
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
    deleteAll?: boolean;
  }
) => {
  if (typeof id === 'string') {
    deleteOneMesh(id, opts);
    return;
  }

  for (let i = 0; i < id.length; i++) {
    deleteOneMesh(id[i], opts);
  }
};

/**
 * Saves a mesh to memory so it can be accessed efficiently
 * @param mesh (THREE.Mesh) the mesh that is saved
 * @param givenId (string) optional mesh id to use when saving
 * @param doNotSaveMaterial (boolean) optional value to determine whether the material should be saved or not (default false)
 * @returns THREE.Mesh | undefined
 */
export const saveMesh = (mesh: THREE.Mesh, givenId?: string, doNotSaveMaterial?: boolean) => {
  if (!mesh.isMesh) return;
  if (givenId && meshes[givenId]) return meshes[givenId];

  const id = givenId || mesh.uuid;

  // Save mesh
  mesh.userData.id = id;
  meshes[id] = mesh;

  // Save geometry
  if (!doesGeoExist(mesh.geometry.userData.id)) {
    saveGeometry(mesh.geometry);
  }

  // Save material
  if (!doNotSaveMaterial && Array.isArray(mesh.material)) {
    for (let i = 0; i < mesh.material.length; i++) {
      const meshMat = mesh.material[i];
      if (!doNotSaveMaterial && !doesMatExist(meshMat.userData.id)) {
        saveMaterial(mesh.material, givenId ? `${givenId}-mat` : undefined);
      }
    }
  } else if (
    !doNotSaveMaterial &&
    !Array.isArray(mesh.material) &&
    !doesMatExist(mesh.material.userData.id)
  ) {
    saveMaterial(mesh.material, givenId ? `${givenId}-mat` : undefined);
  }

  return mesh;
};
