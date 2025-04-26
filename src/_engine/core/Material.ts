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
  | THREE.Material
  | THREE.MeshBasicNodeMaterial;

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

/**
 * Creates a Three.js Material
 * @param id (string) optional id for the material, if id is not provided the uuid of the material is used as id.
 * @param type ({@link MatProps.type}) required enum string that defines the type of material.
 * @param params ({@link MatProps.params}) optional material params, the params props depends on the type of the material.
 * @returns Three.js material {@link Materials}
 */
export const createMaterial = ({ id, type, params }: MatProps) => {
  let mat: Materials | null = null;

  if (id && materials[id]) return materials[id];

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

/**
 * Returns a material or undefined based on the id
 * @param id (string) material id
 * @returns Three.js material | undefined
 */
export const getMaterial = (id: string) => materials[id];

/**
 * Returns one or multiple materials based on the ids
 * @param id (array of strings) one or multiple material ids
 * @returns Array of Three.js materials
 */
export const getMaterials = (id: string[]) => id.map((matId) => materials[matId]);

/**
 * Deletes a materials textures
 * @param mat (Three.js material) {@link Materials}
 */
export const deleteTexturesFromMaterial = (mat: Materials) => {
  for (let i = 0; i < textureMapKeys.length; i++) {
    const key = textureMapKeys[i] as keyof Materials;
    const texture = mat[key] as THREE.Texture;
    if (texture && texture.userData?.id) {
      deleteTexture(texture.userData.id);
    }
  }
};

/**
 * Deletes a material based on an id
 * @param id (string) material id
 * @param deleteTextures (boolean) optional value to determine whether the textures in the material should be deleted or not
 */
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

/**
 * Returns all created materials that exist
 * @returns array of Three.js lights
 */
export const getAllMaterials = () => materials;

/**
 * Saves a material to be easily accessed later
 * @param material (Three.js material or array of Three.js materials) {@link Materials}
 * @param givenId (string) optional id for the material, if no id is provided then the material's uuid is used as id. For arrays of materials, the givenId will be formed like this: `${givenId}-${i}`.
 * @returns Three.js material {@link Materials}
 */
export const saveMaterial = (material: Materials | Materials[], givenId?: string) => {
  if (!Array.isArray(material)) {
    if (givenId && materials[givenId]) return materials[givenId];

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
    if (givenId && materials[newId]) continue;

    const id = givenId || mat.uuid;

    // Save material
    mat.userData.id = id;
    materials[id] = mat;
  }

  return material;
};

/**
 * Checks, with a material id, whether a material exists or not
 * @param id (string) material id
 * @returns boolean
 */
export const doesMatExist = (id: string) => Boolean(materials[id]);
