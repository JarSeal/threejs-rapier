import * as THREE from 'three';

export type Materials =
  | THREE.LineBasicMaterial
  | THREE.LineDashedMaterial
  | THREE.MeshBasicMaterial
  | THREE.MeshDepthMaterial
  | THREE.MeshDistanceMaterial
  | THREE.MeshLambertMaterial
  | THREE.MeshMatcapMaterial
  | THREE.MeshNormalMaterial
  | THREE.MeshPhongMaterial
  | THREE.MeshPhysicalMaterial
  | THREE.MeshStandardMaterial
  | THREE.MeshToonMaterial
  | THREE.PointsMaterial
  | THREE.RawShaderMaterial
  | THREE.ShaderMaterial
  | THREE.ShadowMaterial
  | THREE.SpriteMaterial;

const materials: { [id: string]: Materials } = {};

const textureMapKeys = [
  'map',
  'alphaMap',
  'aoMap',
  'bumpMap',
  'envMap',
  'emissiveMap',
  'lightMap',
  'matcap',
  'normalMap',
  'specularMap',
  'displacementMap',
  'anisotropyMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'sheenRoughnessMap',
  'sheenColorMap',
  'specularIntensityMap',
  'specularColorMap',
  'thicknessMap',
  'transmissionMap',
];

export type MatParams = { id?: string } & (
  | { type: 'LINEBASIC'; params: THREE.LineBasicMaterialParameters }
  | { type: 'LINEDASHED'; params: THREE.LineDashedMaterialParameters }
  | { type: 'BASIC'; params: THREE.MeshBasicMaterialParameters }
  | { type: 'DEPTH'; params: THREE.MeshDepthMaterialParameters }
  | { type: 'DISTANCE'; params: THREE.MeshDistanceMaterialParameters }
  | { type: 'LAMBERT'; params: THREE.MeshLambertMaterialParameters }
  | { type: 'MATCAP'; params: THREE.MeshMatcapMaterialParameters }
  | { type: 'NORMAL'; params: THREE.MeshNormalMaterialParameters }
  | { type: 'PHONG'; params: THREE.MeshPhongMaterialParameters }
  | { type: 'PHYSICAL'; params: THREE.MeshPhysicalMaterialParameters }
  | { type: 'STANDARD'; params: THREE.MeshStandardMaterialParameters }
  | { type: 'TOON'; params: THREE.MeshToonMaterialParameters }
  | { type: 'POINTS'; params: THREE.PointsMaterialParameters }
  | { type: 'SHADERRAW'; params: THREE.ShaderMaterialParameters }
  | { type: 'SHADER'; params: THREE.ShaderMaterialParameters }
  | { type: 'SHADOW'; params: THREE.ShadowMaterialParameters }
  | { type: 'SPRITE'; params: THREE.SpriteMaterialParameters }
);

export const createMaterial = ({ id, type, params }: MatParams) => {
  let mat: Materials | null = null;

  if (id && materials[id]) {
    throw new Error(
      `Material with id "${id}" already exists. Pick another id or delete the material first before recreating it.`
    );
  }

  switch (type) {
    case 'BASIC':
      mat = new THREE.MeshBasicMaterial(params);
      mat.userData.type = 'BASIC';
      break;
    case 'LAMBERT':
      mat = new THREE.MeshLambertMaterial(params);
      mat.userData.type = 'LAMBERT';
      break;
    // @TODO: add all material types
  }

  if (!mat) {
    throw new Error(`Could not create material (unknown type: '${type}').`);
  }

  mat.userData.id = id;
  materials[id || mat.uuid] = mat;

  return mat;
};

export const getMaterial = (id: string | string[]) => {
  if (typeof id === 'string') return materials[id];
  return id.map((matId) => materials[matId]);
};

export const deleteTexturesFromMaterial = (mat: Materials) => {
  for (let i = 0; i < textureMapKeys.length; i++) {
    const key = textureMapKeys[i] as keyof Materials;
    if (mat[key]) {
      // @TODO: delete textures here
    }
  }
};

export const deleteMaterial = (id: string | string[], deleteTextures?: boolean) => {
  if (typeof id === 'string') {
    const mat = materials[id];
    if (deleteTextures) deleteTexturesFromMaterial(mat);
    mat.dispose();
    delete materials[id];
    return;
  }

  for (let i = 0; i < id.length; i++) {
    const matId = id[i];
    const mat = materials[matId];
    if (deleteTextures) deleteTexturesFromMaterial(mat);
    mat.dispose();
    delete materials[matId];
  }
};

export const getAllMaterials = () => materials;
