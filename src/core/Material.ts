import * as THREE from 'three/webgpu';
import { deleteTexture } from './Texture';

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
  | THREE.SpriteMaterial
  | THREE.Material;

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

export type MatProps = { id?: string } & (
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
  | { type: 'BASICNODEMATERIAL'; params: THREE.MeshBasicNodeMaterialParameters }
);

// @TODO: add JSDoc comment
export const createMaterial = ({ id, type, params }: MatProps) => {
  let mat: Materials | null = null;

  if (id && materials[id]) {
    throw new Error(
      `Material with id "${id}" already exists. Pick another id or delete the material first before recreating it.`
    );
  }

  switch (type) {
    case 'LINEBASIC':
      mat = new THREE.LineBasicMaterial(params);
      break;
    case 'LINEDASHED':
      mat = new THREE.LineDashedMaterial(params);
      break;
    case 'BASIC':
      mat = new THREE.MeshBasicMaterial(params);
      break;
    case 'DEPTH':
      mat = new THREE.MeshDepthMaterial(params);
      break;
    case 'DISTANCE':
      mat = new THREE.MeshDistanceMaterial(params);
      break;
    case 'LAMBERT':
      mat = new THREE.MeshLambertMaterial(params);
      break;
    case 'MATCAP':
      mat = new THREE.MeshMatcapMaterial(params);
      break;
    case 'NORMAL':
      mat = new THREE.MeshNormalMaterial(params);
      break;
    case 'PHONG':
      mat = new THREE.MeshPhongMaterial(params);
      break;
    case 'PHYSICAL':
      mat = new THREE.MeshPhysicalMaterial(params);
      break;
    case 'STANDARD':
      mat = new THREE.MeshStandardMaterial(params);
      break;
    case 'TOON':
      mat = new THREE.MeshToonMaterial(params);
      break;
    case 'POINTS':
      mat = new THREE.PointsMaterial(params);
      break;
    case 'SHADERRAW':
    case 'SHADER':
      mat = new THREE.ShaderMaterial(params);
      break;
    case 'SHADOW':
      mat = new THREE.ShadowMaterial(params);
      break;
    case 'SPRITE':
      mat = new THREE.SpriteMaterial(params);
      break;
    case 'BASICNODEMATERIAL':
      mat = new THREE.MeshBasicNodeMaterial(params);
      break;
    // @TODO: add all node materials
  }

  if (!mat) {
    throw new Error(`Could not create material (unknown type: '${type}').`);
  }

  mat.userData.type = type;
  saveMaterial(mat, id);

  return mat;
};

// @TODO: add JSDoc comment
export const getMaterial = (id: string) => materials[id];

// @TODO: add JSDoc comment
export const getMaterials = (id: string[]) => id.map((matId) => materials[matId]);

// @TODO: add JSDoc comment
export const deleteTexturesFromMaterial = (mat: Materials) => {
  for (let i = 0; i < textureMapKeys.length; i++) {
    const key = textureMapKeys[i] as keyof Materials;
    const texture = mat[key] as THREE.Texture;
    if (texture && texture.userData?.id) {
      deleteTexture(texture.userData.id);
    }
  }
};

// @TODO: add JSDoc comment
export const deleteMaterial = (id: string | string[], deleteTextures?: boolean) => {
  if (typeof id === 'string') {
    const mat = materials[id];
    if (!mat) return;
    if (deleteTextures) deleteTexturesFromMaterial(mat);
    mat.dispose();
    delete materials[id];
    return;
  }

  for (let i = 0; i < id.length; i++) {
    const matId = id[i];
    const mat = materials[matId];
    if (!mat) continue;
    if (deleteTextures) deleteTexturesFromMaterial(mat);
    mat.dispose();
    delete materials[matId];
  }
};

// @TODO: add JSDoc comment
export const getAllMaterials = () => materials;

// @TODO: add JSDoc comment
export const saveMaterial = (material: Materials | Materials[], givenId?: string) => {
  if (!Array.isArray(material)) {
    if (givenId && materials[givenId]) {
      throw new Error(
        `Material with id "${givenId}" already exists. Pick another id or delete the mesh first before recreating it.`
      );
    }

    const id = givenId || material.uuid;

    // Save material
    material.userData.id = id;
    materials[id] = material;

    return material;
  }

  const mats = material;
  for (let i = 0; i < mats.length; i++) {
    const mat = mats[i];
    if (!mat.isMaterial) continue;
    const newId = `${givenId}-${i}`;
    if (givenId && materials[newId]) {
      throw new Error(
        `Material with id "${newId}" already exists. Pick another id or delete the mesh first before recreating it.`
      );
    }

    const id = givenId || mat.uuid;

    // Save material
    mat.userData.id = id;
    materials[id] = mat;
  }

  return material;
};
