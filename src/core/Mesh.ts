import * as THREE from 'three';
import { MatProps, createMaterial } from './Material';
import { createGeometry, type GeoProps } from './Geometry';

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
  mesh.userData.id = id;
  meshes[id || mesh.uuid] = mesh;

  return mesh;
};
