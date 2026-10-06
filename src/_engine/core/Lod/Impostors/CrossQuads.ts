// Cross-quads (docs/plans/p351_impostor-billboard-lod.md §2.1): the cheapest impostor, two or three
// intersecting alpha-cut planes through an object's vertical axis, each with the object's silhouette
// baked on it. Reads as volumetric from most ground-level angles, so it's meant for vegetation's
// farthest LOD level: `createInstancedLodPool`'s levels take its geometry and material as is.
//
// The planes are lit at runtime (§2.3): the atlases hold albedo and a normal per texel, in each
// plane's own frame, so the trees keep their shape under a moving sun and darken at night.
import * as THREE from 'three/webgpu';
import { faceDirection, Fn, normalViewGeometry, positionView, texture, uv } from 'three/tsl';
import { retagAssetOwner } from '../../Assets/AssetOwners';
import {
  createMaterial,
  deleteMaterial,
  doesMatExist,
  getMaterial,
  type MatProps,
} from '../../Material';
import { deleteGeometry, doesGeoExist, getGeometry, saveBufferGeometry } from '../../Geometry';
import { deleteTexture, doesTextureExist, saveTexture } from '../../Texture';
import {
  clearBakeTarget,
  createAtlasTarget,
  createBakeMaterials,
  createDilateCopy,
  createFrameTarget,
  disposeBakeMaterials,
  getBakeRenderer,
  withBakeRendererState,
  type ImpostorBakePass,
} from './ImpostorBake';

export type CrossQuadsOptions = {
  /** The id the generated assets are registered under: the geometry `id`, the material
   * `${id}.mat`, the atlases `${id}.albedo` and `${id}.normal`. Default
   * `${geometry's id}#crossQuads`: pass one when the same geometry is baked with other materials. */
  id?: string;
  /** Default 3 (60° apart). 2 are 90° apart. */
  planes?: 2 | 3;
  /** A frame's larger side, in texels. Default 128. */
  frameSize?: number;
  /** Texels between a frame and its cell's edge, which keep mipmaps from mixing frames. Default 4. */
  gutter?: number;
  /** Default 0.5. */
  alphaTest?: number;
  /** Bake a normal atlas, so the planes shade like the object. Default true; false lights each
   * plane flat. */
  normals?: boolean;
  /** The shading model. `AUTO` (default): the one of the material drawing the most triangles
   * (Phong, Lambert, unlit), else standard, with that material's shininess or roughness and
   * metalness. Matching it keeps colours from jumping at the switch. */
  shading?: 'AUTO' | 'PHONG' | 'LAMBERT' | 'STANDARD';
};

export type CrossQuads = {
  id: string;
  /** Registered: one plane per direction, four vertices each, uvs into the atlases. */
  geometry: THREE.BufferGeometry;
  /** Registered: double-sided, alpha-tested, `map` = `albedo`. With `normals`, its `normalNode`
   * reads `normal` (also its `normalMap`, so the asset tooling sees the texture). */
  material: THREE.Material;
  /** Registered sRGB atlas: the frames side by side, each in its own cell. */
  albedo: THREE.Texture;
  /** Registered linear atlas (null without `normals`). */
  normal: THREE.Texture | null;
};

/** Texels between the object's bounds and a frame's edge, so its silhouette never touches it. */
const FRAME_MARGIN = 2;

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _center = new THREE.Vector3();

/** The material drawing the most triangles of `geometry`. */
const getDominantMaterial = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[]
) => {
  if (!Array.isArray(material)) return material;
  if (geometry.groups.length === 0) return material[0];
  const counts = new Map<number, number>();
  for (const { count, materialIndex = 0 } of geometry.groups) {
    counts.set(materialIndex, (counts.get(materialIndex) ?? 0) + count);
  }
  let best = 0;
  let bestCount = -1;
  for (const [index, count] of counts) {
    if (count > bestCount && material[index]) [best, bestCount] = [index, count];
  }
  return material[best];
};

/** The impostor material's type and shading params, from `opts.shading` and the source. */
const getShadingProps = (
  source: THREE.Material,
  shading: NonNullable<CrossQuadsOptions['shading']>
): Pick<MatProps, 'type'> & { params: Record<string, unknown> } => {
  const src = source as THREE.Material & {
    isMeshPhongMaterial?: boolean;
    isMeshLambertMaterial?: boolean;
    isMeshBasicMaterial?: boolean;
    shininess?: number;
    specular?: THREE.Color;
    roughness?: number;
    metalness?: number;
  };
  const type =
    shading !== 'AUTO'
      ? shading
      : src.isMeshPhongMaterial
        ? 'PHONG'
        : src.isMeshLambertMaterial
          ? 'LAMBERT'
          : src.isMeshBasicMaterial
            ? 'BASIC'
            : 'STANDARD';
  switch (type) {
    case 'PHONG':
      return {
        type: 'PHONGNODEMATERIAL',
        params: {
          ...(src.shininess !== undefined ? { shininess: src.shininess } : {}),
          ...(src.specular ? { specular: src.specular.clone() } : {}),
        },
      };
    case 'LAMBERT':
      return { type: 'LAMBERTNODEMATERIAL', params: {} };
    case 'BASIC':
      return { type: 'BASICNODEMATERIAL', params: {} };
    case 'STANDARD':
      return {
        type: 'STANDARDNODEMATERIAL',
        params: {
          ...(src.roughness !== undefined ? { roughness: src.roughness } : {}),
          ...(src.metalness !== undefined ? { metalness: src.metalness } : {}),
        },
      };
  }
};

/**
 * The view-space normal of a plane texel: the baked normal is in the plane's own frame (x along
 * its u, y up, which is along -v, z out of its front), so it's rebuilt from the plane's screen-space
 * cotangent frame and its geometry normal, which three rotates per instance (its tangent attribute
 * it doesn't, r186). On the back face only the out component flips, which mirrors the normal
 * through the plane: three's own double-sided normal maps negate the whole frame instead, which
 * would light a plane seen from behind from below.
 */
const createPlaneNormalNode = (normalMap: THREE.Texture) =>
  Fn(() => {
    const sample = texture(normalMap) as unknown as THREE.Node<'vec4'>;
    const n = sample.xyz.mul(2).sub(1).toVar();
    const q0 = positionView.dFdx();
    const q1 = positionView.dFdy();
    const st0 = uv().dFdx();
    const st1 = uv().dFdy();
    const planeNormal = normalViewGeometry;
    const q1Perp = q1.cross(planeNormal);
    const q0Perp = planeNormal.cross(q0);
    const tangent = q1Perp.mul(st0.x).add(q0Perp.mul(st1.x)).normalize();
    // Along -v: the atlas's v runs down the image
    const up = q1Perp.mul(st0.y).add(q0Perp.mul(st1.y)).normalize().negate();
    return tangent
      .mul(n.x)
      .add(up.mul(n.y))
      .add(planeNormal.mul(faceDirection).mul(n.z))
      .normalize();
  })();

/** The registered result of an earlier bake under `id`, when all of it is still registered. */
const getRegistered = (id: string): CrossQuads | null => {
  if (!doesGeoExist(id) || !doesMatExist(`${id}.mat`)) return null;
  const geometry = getGeometry(id) as THREE.BufferGeometry;
  const material = getMaterial(`${id}.mat`) as THREE.Material & {
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
  };
  const albedo = material.map;
  const normal = material.normalMap ?? null;
  if (!albedo || !doesTextureExist(`${id}.albedo`)) return null;
  if (normal && !doesTextureExist(`${id}.normal`)) return null;
  // To the loading scene, as any cache hit is
  for (const asset of [geometry, material, albedo, normal]) if (asset) retagAssetOwner(asset);
  return { id, geometry, material, albedo, normal };
};

/** Unregisters what's left of a bake under `id` that isn't complete (eg. a released atlas). */
const deleteLeftovers = (id: string) => {
  if (doesMatExist(`${id}.mat`)) deleteMaterial(`${id}.mat`);
  if (doesGeoExist(id)) deleteGeometry(id);
  for (const texId of [`${id}.albedo`, `${id}.normal`]) {
    if (doesTextureExist(texId)) deleteTexture(texId);
  }
};

/** The radius of `geometry` around the vertical axis through `(cx, cz)`, from its vertices. */
const getAxisRadius = (geometry: THREE.BufferGeometry, cx: number, cz: number) => {
  const position = geometry.getAttribute('position');
  let maxSq = 0;
  for (let i = 0; i < position.count; i++) {
    const dx = position.getX(i) - cx;
    const dz = position.getZ(i) - cz;
    maxSq = Math.max(maxSq, dx * dx + dz * dz);
  }
  return Math.sqrt(maxSq);
};

/**
 * Bakes `geometry` drawn with `material` (a per-group array works as on a mesh) into a cross-quad
 * impostor: `planes` vertical planes through the vertical axis of its bounding box, each with the
 * object as seen along its normal by an orthographic camera fitted to its bounds. Its geometry,
 * material and atlases are registered (owned by the loading scene, released with it), and a
 * later call with the same `id` returns them as they are, without baking (or reading `opts`),
 * while they're registered.
 *
 * Bakes synchronously with the renderer (after `InitEngine`), restoring its target and clear
 * state. The geometry is in the object's local space, so it's used with the object's instance
 * transforms. An unlit source (`MeshBasicMaterial`) gets no normal atlas.
 */
export const generateCrossQuads = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  opts: CrossQuadsOptions = {}
): CrossQuads => {
  const { planes = 3, frameSize = 128, gutter = 4, alphaTest = 0.5, shading = 'AUTO' } = opts;
  const id =
    opts.id ?? `${(geometry.userData.id as string | undefined) ?? geometry.uuid}#crossQuads`;
  const registered = getRegistered(id);
  if (registered) return registered;
  deleteLeftovers(id);
  const renderer = getBakeRenderer('generateCrossQuads');
  const { type, params } = getShadingProps(getDominantMaterial(geometry, material), shading);
  // An unlit impostor has no use for normals
  const normals = (opts.normals ?? true) && type !== 'BASICNODEMATERIAL';

  // Frame layout: every plane spans the object's bounds around its axis, at one texel size
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  box.getCenter(_center);
  const radius = getAxisRadius(geometry, _center.x, _center.z);
  const height = box.max.y - box.min.y;
  if (!(radius > 0) || !(height > 0)) {
    throw new Error(`generateCrossQuads: '${id}' has no extent to bake.`);
  }
  const texelWorld = Math.max(2 * radius, height) / (frameSize - 2 * FRAME_MARGIN);
  const frameWidth = Math.ceil((2 * radius) / texelWorld) + 2 * FRAME_MARGIN;
  const frameHeight = Math.ceil(height / texelWorld) + 2 * FRAME_MARGIN;
  const halfWidth = (frameWidth * texelWorld) / 2;
  const halfHeight = (frameHeight * texelWorld) / 2;
  const cellWidth = frameWidth + 2 * gutter;
  const cellHeight = frameHeight + 2 * gutter;
  const atlasWidth = planes * cellWidth;

  const passes: ImpostorBakePass[] = normals ? ['ALBEDO', 'NORMAL'] : ['ALBEDO'];
  const atlases = {
    ALBEDO: createAtlasTarget(atlasWidth, cellHeight, 'ALBEDO', `${id}.albedo`),
    NORMAL: normals ? createAtlasTarget(atlasWidth, cellHeight, 'NORMAL', `${id}.normal`) : null,
  };
  const bakeMaterials = {
    ALBEDO: createBakeMaterials(material, 'ALBEDO'),
    NORMAL: normals ? createBakeMaterials(material, 'NORMAL') : null,
  };
  const frame = createFrameTarget(frameWidth, frameHeight);
  const dilate = createDilateCopy(frame, gutter);
  const scene = new THREE.Scene();
  scene.name = 'ImpostorBake.scene';
  const mesh = new THREE.Mesh(geometry, bakeMaterials.ALBEDO);
  mesh.frustumCulled = false;
  scene.add(mesh);
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const distance = geometry.boundingSphere!.radius + 1;
  const camera = new THREE.OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    0.01,
    2 * distance
  );
  const axisCenter = new THREE.Vector3(_center.x, (box.min.y + box.max.y) / 2, _center.z);

  const positions: number[] = [];
  const normalsAttr: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // A render target texture's v = 0 is the top of the rendered image (three r186, both backends:
  // WebGPU's texel rows start at the top, and WebGL's render target samples are flipped to match)
  const vTop = gutter / cellHeight;
  const vBottom = (gutter + frameHeight) / cellHeight;

  try {
    withBakeRendererState(renderer, () => {
      for (const pass of passes) clearBakeTarget(renderer, atlases[pass]!);
      for (let i = 0; i < planes; i++) {
        // The camera looks along -dir, so the plane's front faces it and its u runs along the
        // camera's right
        const angle = (i * Math.PI) / planes;
        _dir.set(Math.sin(angle), 0, Math.cos(angle));
        _right.set(_dir.z, 0, -_dir.x);
        camera.position.copy(axisCenter).addScaledVector(_dir, distance);
        camera.up.copy(_up);
        camera.lookAt(axisCenter);
        camera.updateMatrixWorld();

        for (const pass of passes) {
          mesh.material = bakeMaterials[pass]!;
          clearBakeTarget(renderer, frame);
          renderer.render(scene, camera);
          dilate.copy(renderer, atlases[pass]!, i * cellWidth, 0, cellWidth, cellHeight);
        }

        const base = i * 4;
        const u0 = (i * cellWidth + gutter) / atlasWidth;
        const u1 = (i * cellWidth + gutter + frameWidth) / atlasWidth;
        for (const [sx, sy, u, v] of [
          [-1, -1, u0, vBottom],
          [1, -1, u1, vBottom],
          [1, 1, u1, vTop],
          [-1, 1, u0, vTop],
        ]) {
          positions.push(
            axisCenter.x + _right.x * sx * halfWidth,
            axisCenter.y + sy * halfHeight,
            axisCenter.z + _right.z * sx * halfWidth
          );
          normalsAttr.push(_dir.x, _dir.y, _dir.z);
          uvs.push(u, v);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    });
  } catch (error) {
    atlases.ALBEDO.dispose();
    atlases.NORMAL?.dispose();
    throw error;
  } finally {
    disposeBakeMaterials(bakeMaterials.ALBEDO);
    if (bakeMaterials.NORMAL) disposeBakeMaterials(bakeMaterials.NORMAL);
    dilate.dispose();
    frame.dispose();
  }

  const quads = new THREE.BufferGeometry();
  quads.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  quads.setAttribute('normal', new THREE.Float32BufferAttribute(normalsAttr, 3));
  quads.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  quads.setIndex(indices);
  quads.computeBoundingBox();
  quads.computeBoundingSphere();
  quads.name = id;
  saveBufferGeometry(quads, { id });

  const albedo = saveTexture(atlases.ALBEDO.texture, `${id}.albedo`);
  const normal = atlases.NORMAL ? saveTexture(atlases.NORMAL.texture, `${id}.normal`) : null;
  const impostorMaterial = createMaterial({
    id: `${id}.mat`,
    type,
    params: { ...params, map: albedo.userData.id, alphaTest, side: THREE.DoubleSide },
  } as MatProps) as THREE.Material & {
    normalMap: THREE.Texture | null;
    normalNode: THREE.Node | null;
  };
  impostorMaterial.name = id;
  if (normal) {
    impostorMaterial.normalMap = normal;
    impostorMaterial.normalNode = createPlaneNormalNode(normal);
  }

  return { id, geometry: quads, material: impostorMaterial, albedo, normal };
};
