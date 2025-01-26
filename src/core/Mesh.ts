import * as THREE from 'three/webgpu';
import { MatProps, createMaterial, deleteMaterial, saveMaterial } from './Material';
import { createGeometry, deleteGeometry, saveGeometry, type GeoProps } from './Geometry';

const meshes: { [id: string]: THREE.Mesh } = {};

/**
 * Creates a Three.js mesh
 * @param params (object) mesh params, { id: string (optional), geo: THREE.BufferGeometry | {@link GeoPropsB}, and mat: THREE.Material | {@link MatProps} }
 * @returns THREE.Mesh
 */
export const createMesh = ({
  id,
  geo,
  mat,
}: {
  id?: string;
  geo: THREE.BufferGeometry | GeoProps;
  mat: THREE.Material | MatProps;
}) => {
  let mesh: THREE.Mesh | null = null;

  if (id && meshes[id]) {
    throw new Error(
      `Mesh with id "${id}" already exists. Pick another id or delete the mesh first before recreating it.`
    );
  }

  let g = geo as THREE.BufferGeometry;
  if (!('isBufferGeometry' in geo)) {
    g = createGeometry(geo);
  }

  let m = mat as THREE.Material;
  if (!('isMaterial' in mat)) {
    m = createMaterial(mat);
  }

  mesh = new THREE.Mesh(g, m);
  saveMesh(mesh, id, true);

  return mesh;
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

const deleteOneMesh = (
  id: string,
  opts?: {
    deleteGeometries?: boolean;
    deleteMaterials?: boolean;
    deleteTextures?: boolean;
    deleteAll?: boolean;
  }
) => {
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
 * Saves a mesh to memory so it can be accessed more easily
 * @param mesh (THREE.Mesh) the mesh that is saved
 * @param givenId (string) optional mesh id to use when saving
 * @param doNotSaveMaterial (boolean) optional value to determine whether the material should be saved or not (default false)
 * @returns THREE.Mesh | undefined
 */
export const saveMesh = (mesh: THREE.Mesh, givenId?: string, doNotSaveMaterial?: boolean) => {
  if (!mesh.isMesh) return;
  if (givenId && meshes[givenId]) {
    throw new Error(
      `Mesh with id "${givenId}" already exists. Pick another id or delete the mesh first before recreating it.`
    );
  }

  const id = givenId || mesh.uuid;

  // Save mesh
  mesh.userData.id = id;
  meshes[id] = mesh;

  // Save geometry
  saveGeometry(mesh.geometry, givenId ? `${givenId}-geo` : undefined);

  // Save material
  if (!doNotSaveMaterial) saveMaterial(mesh.material, givenId ? `${givenId}-mat` : undefined);

  return mesh;
};

/** Returns all existing meshes
 * @returns (object) { [meshId: string]: THREE.Mesh }
 */
export const getAllMeshes = () => meshes;
