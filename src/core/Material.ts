import * as THREE from 'three';

const materials: { [id: string]: THREE.Material } = {};

export const createMaterial = (
  id: string,
  props: { type: 'BASIC'; params: THREE.MeshBasicMaterialParameters }
) => {
  let mat;
  if (materials[id]) {
    throw new Error(
      `Material with id "${id}" already exists. Pick another id or delete the material first before recreating it.`
    );
  }

  if (props.type === 'BASIC') {
    mat = new THREE.MeshBasicMaterial(props.params);
  }

  if (!mat) {
    throw new Error('Could not create material (propably unknown type).');
  }

  materials[id] = mat;

  return mat;
};

// getMaterial

// deleteMaterial

// getAllMaterials
