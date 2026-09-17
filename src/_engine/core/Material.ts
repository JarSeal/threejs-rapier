import * as THREE from 'three/webgpu';
import { deleteTexture, getTexture } from './Texture';
import { getRootScene } from './Scene';
import { existsOrThrow } from '../utils/assert';
import { tslMaterialFileObjects } from '../generatedAppFns';
import { lerror, lwarn } from '../utils/Logger';
import { color, Node, texture, uniform } from 'three/tsl';
import { textureMapKeys } from '../utils/constants';

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
  // RawShaderMaterial does not work with WebGPU, but keeping it here if there is future possibility to transpile
  | THREE.RawShaderMaterial
  // ShaderMaterial does not work with WebGPU, but keeping it here if there is future possibility to transpile
  | THREE.ShaderMaterial
  | THREE.ShadowMaterial
  | THREE.SpriteMaterial
  | THREE.Material
  | THREE.MeshBasicNodeMaterial
  | THREE.MeshLambertNodeMaterial
  | THREE.MeshPhongNodeMaterial
  | THREE.MeshPhysicalNodeMaterial
  | THREE.MeshStandardNodeMaterial
  | THREE.MeshMatcapNodeMaterial
  | THREE.MeshMatcapNodeMaterial
  | THREE.MeshNormalNodeMaterial
  | THREE.MeshToonNodeMaterial;

const materials: {
  [id: string]: {
    resource: Materials;
    count: number;
    persistent?: boolean;
  };
} = {};

type TextureMapKeys =
  | 'map'
  | 'alphaMap'
  | 'aoMap'
  | 'bumpMap'
  | 'envMap'
  | 'emissiveMap'
  | 'lightMap'
  | 'matcap'
  | 'normalMap'
  | 'specularMap'
  | 'displacementMap'
  | 'anisotropyMap'
  | 'clearcoatMap'
  | 'clearcoatNormalMap'
  | 'clearcoatRoughnessMap'
  | 'iridescenceMap'
  | 'iridescenceThicknessMap'
  | 'sheenRoughnessMap'
  | 'sheenColorMap'
  | 'specularIntensityMap'
  | 'specularColorMap'
  | 'thicknessMap'
  | 'transmissionMap';

type AllowTextureStrings<T> = T extends unknown
  ? { [K in keyof T]: K extends TextureMapKeys ? T[K] | string : T[K] }
  : never;

export type MatProps = {
  id?: string;
  isPersistent?: boolean;
  debugData?: { name?: string; description?: string };
  userData?: Record<string, unknown>;
} & (
  | { type: 'LINEBASIC'; params?: AllowTextureStrings<THREE.LineBasicMaterialParameters> }
  | { type: 'LINEDASHED'; params?: AllowTextureStrings<THREE.LineDashedMaterialParameters> }
  | { type: 'BASIC'; params?: AllowTextureStrings<THREE.MeshBasicMaterialParameters> }
  | { type: 'DEPTH'; params?: AllowTextureStrings<THREE.MeshDepthMaterialParameters> }
  | { type: 'DISTANCE'; params?: AllowTextureStrings<THREE.MeshDistanceMaterialParameters> }
  | { type: 'LAMBERT'; params?: AllowTextureStrings<THREE.MeshLambertMaterialParameters> }
  | { type: 'MATCAP'; params?: AllowTextureStrings<THREE.MeshMatcapMaterialParameters> }
  | { type: 'NORMAL'; params?: AllowTextureStrings<THREE.MeshNormalMaterialParameters> }
  | { type: 'PHONG'; params?: AllowTextureStrings<THREE.MeshPhongMaterialParameters> }
  | { type: 'PHYSICAL'; params?: AllowTextureStrings<THREE.MeshPhysicalMaterialParameters> }
  | { type: 'STANDARD'; params?: AllowTextureStrings<THREE.MeshStandardMaterialParameters> }
  | { type: 'TOON'; params?: AllowTextureStrings<THREE.MeshToonMaterialParameters> }
  | { type: 'POINTS'; params?: AllowTextureStrings<THREE.PointsMaterialParameters> }
  | { type: 'SHADERRAW'; params?: AllowTextureStrings<THREE.ShaderMaterialParameters> }
  | { type: 'SHADER'; params?: AllowTextureStrings<THREE.ShaderMaterialParameters> }
  | { type: 'SHADOW'; params?: AllowTextureStrings<THREE.ShadowMaterialParameters> }
  | { type: 'SPRITE'; params?: AllowTextureStrings<THREE.SpriteMaterialParameters> }
  | {
      type: 'BASICNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshBasicNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'LAMBERTNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshLambertNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'PHONGNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshPhongNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'PHYSICALNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshPhysicalNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'STANDARDNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshStandardNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'MATCAPNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshMatcapNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'NORMALNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshNormalNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
  | {
      type: 'TOONNODEMATERIAL';
      params?: AllowTextureStrings<THREE.MeshToonNodeMaterialParameters>;
      tslFile?: string;
      nodes?: Record<string, Record<string, unknown>>;
      staticDefines?: Record<string, unknown>;
    }
);

export const incMaterialRef = (id: string) => {
  if (materials[id]) {
    materials[id].count++;
  }
};

export const decMaterialRef = (id: string) => {
  const entry = materials[id];
  if (!entry) return;

  entry.count--;

  if (entry.count <= 0 && !entry.persistent) {
    deleteTexturesFromMaterial(entry.resource);
    entry.resource.dispose();
    delete materials[id];
  }
};

export const setMaterialPersistence = (id: string, state: boolean) => {
  const entry = materials[id];
  if (!entry) return;
  entry.persistent = state;

  if (!state && entry.count === 0) {
    deleteTexturesFromMaterial(entry.resource);
    entry.resource.dispose();
    delete materials[id];
  }
};

/**
 * Creates a Three.js Material supporting both standard descriptions and modern dynamic TSL graphs.
 * @param props - Material configuration settings.
 * @returns An instantiated, indexed Three.js material.
 */
export const createMaterial = (props: MatProps) => {
  const id = props.id;

  if (id && materials[id]) return materials[id].resource;

  let mat: Materials | null = null;

  // Standard Static Parameters Definitions
  const type = props.type;
  const params = props.params;

  let processedParams: Record<string, unknown> | undefined = undefined;

  if (params) {
    processedParams = { ...params };

    for (const key of textureMapKeys) {
      if (typeof processedParams[key] === 'string') {
        const texId = processedParams[key] as string;
        const texResource = getTexture(texId);

        if (texResource) {
          processedParams[key] = texResource;
        } else {
          lwarn(
            `[Material Manager] Could not locate texture resource "${texId}" for parameter field "${key}" in material "${id}". Safely stripping field.`
          );
          delete processedParams[key];
        }
      }
    }
  }

  switch (type) {
    case 'LINEBASIC':
      mat = new THREE.LineBasicMaterial(processedParams);
      break;
    case 'LINEDASHED':
      mat = new THREE.LineDashedMaterial(processedParams);
      break;
    case 'BASIC':
      mat = new THREE.MeshBasicMaterial(processedParams);
      break;
    case 'DEPTH':
      mat = new THREE.MeshDepthMaterial(processedParams);
      break;
    case 'DISTANCE':
      mat = new THREE.MeshDistanceMaterial(processedParams);
      break;
    case 'LAMBERT':
      mat = new THREE.MeshLambertMaterial(processedParams);
      break;
    case 'MATCAP':
      mat = new THREE.MeshMatcapMaterial(processedParams);
      break;
    case 'NORMAL':
      mat = new THREE.MeshNormalMaterial(processedParams);
      break;
    case 'PHONG':
      mat = new THREE.MeshPhongMaterial(processedParams);
      break;
    case 'PHYSICAL':
      mat = new THREE.MeshPhysicalMaterial(processedParams);
      break;
    case 'STANDARD':
      mat = new THREE.MeshStandardMaterial(processedParams);
      break;
    case 'TOON':
      mat = new THREE.MeshToonMaterial(processedParams);
      break;
    case 'POINTS':
      mat = new THREE.PointsMaterial(processedParams);
      break;
    case 'SHADERRAW':
    case 'SHADER':
      mat = new THREE.ShaderMaterial(processedParams);
      break;
    case 'SHADOW':
      mat = new THREE.ShadowMaterial(processedParams);
      break;
    case 'SPRITE':
      mat = new THREE.SpriteMaterial(processedParams);
      break;
    case 'BASICNODEMATERIAL':
      mat = new THREE.MeshBasicNodeMaterial(processedParams);
      break;
    case 'LAMBERTNODEMATERIAL':
      mat = new THREE.MeshLambertNodeMaterial(processedParams);
      break;
    case 'PHONGNODEMATERIAL':
      mat = new THREE.MeshPhongNodeMaterial(processedParams);
      break;
    case 'PHYSICALNODEMATERIAL':
      mat = new THREE.MeshPhysicalNodeMaterial(processedParams);
      break;
    case 'STANDARDNODEMATERIAL':
      mat = new THREE.MeshStandardNodeMaterial(processedParams);
      break;
    case 'MATCAPNODEMATERIAL':
      mat = new THREE.MeshMatcapNodeMaterial(processedParams);
      break;
    case 'NORMALNODEMATERIAL':
      mat = new THREE.MeshNormalNodeMaterial(processedParams);
      break;
    case 'TOONNODEMATERIAL':
      mat = new THREE.MeshToonNodeMaterial(processedParams);
      break;
  }

  if (mat) {
    if (props.userData) mat.userData = props.userData;
    mat.userData.type = type;
  } else {
    const msg = `[Material Manager] Incomplete properties for material (id: ${id}).`;
    lerror(msg);
    throw new Error(msg);
  }

  // TSL file
  if ('tslFile' in props && props.tslFile) {
    const activeMaterialRegistry = existsOrThrow(
      id && (tslMaterialFileObjects as Record<string, Record<string, unknown>>)[id],
      `[Material Manager] Could not locate compiled TSL Master Graph registry entry for material ID "${id}. Materials with a TSL file must have a *.material.json file."`
    );
    if (activeMaterialRegistry === '') {
      const msg = `[Material Manager] Empty TSL Master Graph function export for material entry ID: "${id}".`;
      lerror(msg);
      throw new Error(msg);
    }

    const staticDefines = props.staticDefines || {};

    if (props.nodes) {
      for (const nodeSocket of Object.keys(props.nodes)) {
        const masterGraphFunction = activeMaterialRegistry[nodeSocket];

        // If a named layout node function isn't explicitly exported or the node socket does not exist, gracefully pass it
        if (!masterGraphFunction || !(nodeSocket in mat)) {
          if (mat.type.endsWith('NodeMaterial')) {
            lwarn(`Could not locate node "${nodeSocket}" for material id "${id}".`);
          } else {
            lwarn(
              `Material id "${id}" is not a node material, it does not have node sockets (in this case "${nodeSocket}").`
            );
          }
          continue;
        }

        if (masterGraphFunction === ' ' || masterGraphFunction === '') {
          const msg = `[Material Manager] Empty TSL function export caught at socket "${nodeSocket}" for material entry ID: "${id}".`;
          lerror(msg);
          throw new Error(msg);
        }

        const genericGraphFn = masterGraphFunction as (
          inputs: Record<string, unknown>,
          material: THREE.NodeMaterial,
          defines?: Record<string, unknown>
        ) => Node;

        const rawInputs = props.nodes[nodeSocket];
        const uniformNodesPayload: Record<string, unknown> = {};
        let nodeStaticDefines: Record<string, unknown> | undefined = undefined;

        for (const inputKey of Object.keys(rawInputs)) {
          const value = rawInputs[inputKey];
          let instantiatedNode;

          // Handle Texture Asset References
          if (inputKey === 'staticDefines' && typeof value === 'object' && value !== null) {
            nodeStaticDefines = { ...staticDefines, ...(value as Record<string, unknown>) };
          }
          // Handle textures
          else if (typeof value === 'string' && !value.startsWith('#')) {
            const texResource = getTexture(value as string);
            if (!texResource) {
              lwarn(
                `Could not locate texture resource for input "${inputKey}" in material "${id}" with value "${value}", setting a uniform value of 1.`
              );
              instantiatedNode = uniform(1);
            }
            // Convert directly into a sampler node, not a uniform buffer allocation
            instantiatedNode = texture(texResource);
          }
          // Handle Hex Color Strings
          else if (typeof value === 'string' && value.startsWith('#')) {
            instantiatedNode = uniform(color(value));
          }
          // Handle Booleans (Flags / Switches)
          else if (typeof value === 'boolean') {
            instantiatedNode = uniform(value);
          }
          // Handle Arrays (Alternative Vector Format: [x, y] or [x, y, z])
          else if (Array.isArray(value)) {
            if (value.length === 4) {
              instantiatedNode = uniform(new THREE.Vector4(value[0], value[1], value[2], value[3]));
            } else if (value.length === 3) {
              instantiatedNode = uniform(new THREE.Vector3(value[0], value[1], value[2]));
            } else if (value.length === 2) {
              instantiatedNode = uniform(new THREE.Vector2(value[0], value[1]));
            } else {
              const msg = `[Material Manager] Unsupported array length (${value.length}) for input "${inputKey}" in material "${id}".`;
              lerror(msg);
              throw new Error(msg);
            }
          }
          // Handle Vector and Color Objects
          else if (typeof value === 'object' && value !== null) {
            const obj = value as Record<string, number>;

            if ('w' in obj) {
              instantiatedNode = uniform(
                new THREE.Vector4(obj.x || 0, obj.y || 0, obj.z || 0, obj.w || 0)
              );
            } else if ('z' in obj) {
              instantiatedNode = uniform(new THREE.Vector3(obj.x || 0, obj.y || 0, obj.z || 0));
            } else if ('y' in obj) {
              instantiatedNode = uniform(new THREE.Vector2(obj.x || 0, obj.y || 0));
            } else if ('r' in obj && 'g' in obj && 'b' in obj && 'a' in obj) {
              instantiatedNode = uniform(new THREE.Vector4(obj.r, obj.g, obj.b, obj.a));
            } else if ('r' in obj && 'g' in obj && 'b' in obj) {
              instantiatedNode = uniform(new THREE.Color(obj.r, obj.g, obj.b));
            } else {
              const msg = `[Material Manager] Unknown object footprint for input "${inputKey}" in material "${id}". Keys: ${Object.keys(obj).join(', ')}`;
              lerror(msg);
              throw new Error(msg);
            }
          }
          // Handle Standard Float / Scalar Numbers
          else if (typeof value === 'number') {
            instantiatedNode = uniform(value);
          }
          // Everything else is forbidden
          else {
            const msg = `[Material Manager] Unsupported input value type at socket "${nodeSocket}" for input "${inputKey}" in material entry ID: "${id}". Value: ${JSON.stringify(value)}.`;
            lerror(msg);
            throw new Error(msg);
          }

          // Cache dynamically so runtime update scripts can pinpoint the uniform
          if (!mat.userData.uniforms) mat.userData.uniforms = {};
          mat.userData.uniforms[`${nodeSocket}_${inputKey}`] = instantiatedNode;
          uniformNodesPayload[inputKey] = instantiatedNode;
        }

        // Execute graph function with its flat parameter values and assign directly to material socket
        mat[nodeSocket] = genericGraphFn(
          uniformNodesPayload,
          mat as THREE.NodeMaterial,
          nodeStaticDefines
        );
      }
    }

    mat.userData.hasTslFile = true;
  }

  if (props.debugData) {
    if (props.debugData.name) {
      mat.name = props.debugData.name;
      mat.userData.name = props.debugData.name;
    }
    if (props.debugData.description) {
      mat.userData.description = props.debugData.description;
    }
  }

  saveMaterial(mat, id, props.isPersistent);
  return mat;
};

/**
 * Returns a material or undefined based on the id
 * @param id material id
 * @returns Three.js material | undefined
 */
export const getMaterial = (id: string) => materials[id]?.resource;

/**
 * Returns one or multiple materials based on the ids
 * @param id one or multiple material ids
 * @returns Array of Three.js materials
 */
export const getMaterials = (id: string[]) =>
  id.map((matId) => materials[matId]?.resource).filter(Boolean) as Materials[];

/**
 * Returns all created materials that exist
 * @returns all materials map object
 */
export const getAllMaterials = () => {
  const flatMap: { [id: string]: Materials } = {};
  Object.keys(materials).forEach((key) => {
    flatMap[key] = materials[key].resource;
  });
  return flatMap;
};

export const getMaterialRegistry = () => materials;

/**
 * Deletes a materials textures from VRAM cache.
 * @param mat Target material asset.
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
 * Forcefully destroys one or multiple materials, running cleanup protocols.
 * @param id material id or array of ids
 * @param deleteTextures optionally purges texture samplers from GPU memory alongside material
 */
export const deleteMaterial = (id: string | string[], deleteTextures?: boolean) => {
  const targetIds = Array.isArray(id) ? id : [id];

  for (const matId of targetIds) {
    const entry = materials[matId];
    if (!entry) continue;

    if (deleteTextures) deleteTexturesFromMaterial(entry.resource);
    entry.resource.dispose();
    delete materials[matId];
  }
};

/**
 * Saves a material instance inside the engine tracking array mapping.
 * @param material Target material or multi-material group array.
 * @param givenId Identifiable registration appId.
 * @param isPersistent Bypasses standard cross-scene cleanup loops when true.
 */
export const saveMaterial = (
  material: Materials | Materials[],
  givenId?: string,
  isPersistent?: boolean
) => {
  if (!Array.isArray(material)) {
    const id = givenId || material.uuid;
    if (materials[id]) return materials[id].resource;

    material.userData.id = id;
    materials[id] = {
      resource: material,
      count: 0,
      ...(isPersistent ? { persistent: true } : {}),
    };
    return material;
  }

  for (let i = 0; i < material.length; i++) {
    const mat = material[i];
    if (!mat.isMaterial) continue;
    const combinedId = givenId ? `${givenId}-${i}` : mat.uuid;
    if (materials[combinedId]) continue;

    mat.userData.id = combinedId;
    materials[combinedId] = {
      resource: mat,
      count: 0,
      ...(isPersistent ? { persistent: true } : {}),
    };
  }

  return material;
};

/**
 * Checks with an identifier whether a matching material instance exists in memory.
 * @param id target identifier string
 */
export const doesMatExist = (id: string) => Boolean(materials[id]);

/**
 * Re-flags every material in the active display list to recompile on the next draw wave.
 */
export const updateAllMaterials = () => {
  const rootScene = getRootScene();
  if (!rootScene) return;

  rootScene.traverse((child) => {
    const c = child as THREE.Mesh;
    if (c?.material) {
      if (Array.isArray(c.material)) {
        for (let i = 0; i < c.material.length; i++) {
          c.material[i].needsUpdate = true;
        }
      } else {
        c.material.needsUpdate = true;
      }
    }
  });
};
