import * as THREE from 'three';
import { MatProps, createMaterial, deleteMaterial, saveMaterial } from './Material';
import { createGeometry, deleteGeometry, saveGeometry, type GeoProps } from './Geometry';

const meshes: { [id: string]: THREE.Mesh } = {};

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

export const getMesh = (id: string) => meshes[id];

export const getMeshes = (id: string[]) => id.map((meshId) => meshes[meshId]);

const deleteOneMesh = (
  id: string,
  opts?: { deleteGeometries?: boolean; deleteMaterials?: boolean; deleteTextures?: boolean }
) => {
  const mesh = meshes[id];
  if (!mesh) return;
  if (opts?.deleteGeometries) {
    const geoId = mesh.geometry.userData.id;
    if (geoId) deleteGeometry(geoId);
  }
  if (opts?.deleteMaterials) {
    if (Array.isArray(mesh.material)) {
      const matIds: string[] = [];
      for (let i = 0; i < mesh.material.length; i++) {
        const matId = mesh.material[i].userData.id;
        if (matId) matIds.push(matId);
      }
      deleteMaterial(matIds, opts?.deleteTextures);
    } else {
      const matId = mesh.material.userData.id;
      if (matId) deleteMaterial(matId, opts?.deleteTextures);
    }
  }
  mesh.removeFromParent();
  delete meshes[id];
};

export const deleteMesh = (
  id: string | string[],
  opts?: { deleteGeometries?: boolean; deleteMaterials?: boolean; deleteTextures?: boolean }
) => {
  if (typeof id === 'string') {
    deleteOneMesh(id, opts);
    return;
  }

  for (let i = 0; i < id.length; i++) {
    deleteOneMesh(id[i], opts);
  }
};

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

export const getAllMeshes = () => meshes;
