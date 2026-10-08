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
  getDominantMaterial,
  getShadingProps,
  withBakeRendererState,
  type ImpostorBakePass,
  type ImpostorShading,
} from './ImpostorBake';
import { getImpostorExport, warnIfImpostorExportStale } from './ImpostorExports';
import type { ImpostorAtlasVOrigin } from './ImpostorFormat';
import { recordImpostor } from './ImpostorRegistry';

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
  /** The shading model (see {@link ImpostorShading}). Default `AUTO`. */
  shading?: ImpostorShading;
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

/** Where a cross-quad impostor's frames are and how its planes stand: what its geometry needs
 * besides the atlases. What an export writes (`*.impostor.json`'s `layout`). */
export type CrossQuadsLayout = {
  planes: 2 | 3;
  /** A frame's size in texels: the object's bounds plus a margin, grown so a cell is a whole number
   * of compression blocks. */
  frameWidth: number;
  frameHeight: number;
  gutter: number;
  /** `[planes × (frameWidth + 2 × gutter), frameHeight + 2 × gutter]`: plane `i`'s cell starts at
   * texel `i × (frameWidth + 2 × gutter)` from the image's left. */
  atlasSize: [width: number, height: number];
  /** Where the planes cross (local space): the object's vertical axis, at its bounds' middle height. */
  center: [x: number, y: number, z: number];
  /** Half a plane's width and height, in local units (a frame's, margins included). */
  halfWidth: number;
  halfHeight: number;
};

/** Texels between the object's bounds and a frame's edge, so its silhouette never touches it. */
const FRAME_MARGIN = 2;
/** A cell's sides are multiples of this: an export's atlas is block-compressed (4 × 4 texels), and
 * p299 places cells on that grid */
const CELL_ALIGN = 4;

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _center = new THREE.Vector3();

/** Plane `i`'s normal (its front) and its u direction, the camera's right in its bake */
const getPlaneAxes = (i: number, planes: number, dir: THREE.Vector3, right: THREE.Vector3) => {
  const angle = (i * Math.PI) / planes;
  dir.set(Math.sin(angle), 0, Math.cos(angle));
  right.set(dir.z, 0, -dir.x);
};

/**
 * The view-space normal of a plane texel: the baked normal is in the plane's own frame (x along
 * its u, y up, z out of its front), so it's rebuilt from the plane's screen-space cotangent frame
 * and its geometry normal, which three rotates per instance (its tangent attribute it doesn't,
 * r186). On the back face only the out component flips, which mirrors the normal through the
 * plane: three's own double-sided normal maps negate the whole frame instead, which would light a
 * plane seen from behind from below. Up is along -v on a bake's atlas (v runs down the image),
 * along +v on a loaded one (`vOrigin`).
 */
const createPlaneNormalNode = (normalMap: THREE.Texture, vOrigin: ImpostorAtlasVOrigin) =>
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
    const alongV = q1Perp.mul(st0.y).add(q0Perp.mul(st1.y)).normalize();
    const up = vOrigin === 'TOP' ? alongV.negate() : alongV;
    return tangent
      .mul(n.x)
      .add(up.mul(n.y))
      .add(planeNormal.mul(faceDirection).mul(n.z))
      .normalize();
  })();

/** The planes of `layout`: one per direction, four vertices each, with uvs into the atlases for
 * their `vOrigin`. Not registered. */
const createCrossQuadsGeometry = (layout: CrossQuadsLayout, vOrigin: ImpostorAtlasVOrigin) => {
  const { planes, frameWidth, frameHeight, gutter, atlasSize, center, halfWidth, halfHeight } =
    layout;
  const [atlasWidth, atlasHeight] = atlasSize;
  const cellWidth = frameWidth + 2 * gutter;
  // From the image's top: the frame's top and bottom edges
  const top = gutter / atlasHeight;
  const bottom = (gutter + frameHeight) / atlasHeight;
  const vTop = vOrigin === 'TOP' ? top : 1 - top;
  const vBottom = vOrigin === 'TOP' ? bottom : 1 - bottom;
  const [cx, cy, cz] = center;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < planes; i++) {
    getPlaneAxes(i, planes, _dir, _right);
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
        cx + _right.x * sx * halfWidth,
        cy + sy * halfHeight,
        cz + _right.z * sx * halfWidth
      );
      normals.push(_dir.x, _dir.y, _dir.z);
      uvs.push(u, v);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

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

/** Unregisters what's left of an impostor under `id` that isn't complete (eg. a released atlas):
 * its geometry and material, and, unless `keepAtlases` (building from an export's loaded atlas
 * slots, which have those ids), its atlases. A bake must clear them: saveTexture would return a
 * texture already registered under the id instead of its new one. */
const deleteLeftovers = (id: string, keepAtlases = false) => {
  if (doesMatExist(`${id}.mat`)) deleteMaterial(`${id}.mat`);
  if (doesGeoExist(id)) deleteGeometry(id);
  if (keepAtlases) return;
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
 * The options a bake of `geometry` drawn with `material` uses: `opts` with their defaults, and the
 * shading resolved (never `AUTO`; an unlit one bakes no normals). What an export writes, and its
 * fingerprint covers (`getImpostorSourceHash`).
 */
export const resolveCrossQuadsOptions = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  opts: CrossQuadsOptions = {}
) => {
  const { planes = 3, frameSize = 128, gutter = 4, alphaTest = 0.5, shading = 'AUTO' } = opts;
  const resolvedShading = getShadingProps(getDominantMaterial(geometry, material), shading);
  return {
    kind: 'CROSS_QUADS' as const,
    planes,
    frameSize,
    gutter,
    alphaTest,
    // An unlit impostor has no use for normals
    normals: (opts.normals ?? true) && resolvedShading.type !== 'BASICNODEMATERIAL',
    shading: resolvedShading,
  };
};

/**
 * Bakes `geometry` drawn with `material` (a per-group array works as on a mesh) into a cross-quad
 * impostor: `planes` vertical planes through the vertical axis of its bounding box, each with the
 * object as seen along its normal by an orthographic camera fitted to its bounds. Its geometry,
 * material and atlases are registered (owned by the loading scene, released with it), and a
 * later call with the same `id` returns them as they are, without baking (or reading `opts`),
 * while they're registered.
 *
 * When the loading scene lists `id` in its JSON's `impostors` (an export: `*.impostor.json` and
 * its atlas, written by the LOD tab's Impostors), the impostor is built from the export and its
 * loaded atlas slots instead, with the export's layout, shading, `alphaTest` and normals: nothing
 * is baked, and the other `opts` only feed the staleness check. In the debug env a source or
 * options that changed since the export warn that it's stale (it's still used). An export that
 * can't be used (another format, a slot that didn't load) warns and bakes.
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
  const id =
    opts.id ?? `${(geometry.userData.id as string | undefined) ?? geometry.uuid}#crossQuads`;
  const registered = getRegistered(id);
  if (registered) return registered;
  const settings = resolveCrossQuadsOptions(geometry, material, opts);
  const source = { geometry, material, options: { ...opts, id } };

  // Listed by the scene and loaded: built from the export, nothing baked
  const exported = getImpostorExport(id, 'CROSS_QUADS', 'generateCrossQuads');
  if (exported) {
    const { def, slots } = exported;
    warnIfImpostorExportStale(def, geometry, material, settings, 'generateCrossQuads');
    deleteLeftovers(id, true);
    const impostor = buildCrossQuads(
      def.layout,
      slots.albedo as THREE.Texture,
      def.normals ? (slots.normal as THREE.Texture) : null,
      { id, alphaTest: def.alphaTest, shading: def.shading, vOrigin: 'BOTTOM' }
    );
    recordImpostor({ id, kind: 'CROSS_QUADS', origin: 'EXPORTED', bakeMs: null, source });
    return impostor;
  }

  deleteLeftovers(id);
  const bakeStart = performance.now();
  const atlases = bakeCrossQuadsAtlases(geometry, material, settings, id);
  const impostor = buildCrossQuads(
    atlases.layout,
    saveTexture(atlases.albedo.texture, `${id}.albedo`),
    atlases.normal ? saveTexture(atlases.normal.texture, `${id}.normal`) : null,
    { id, alphaTest: settings.alphaTest, shading: settings.shading, vOrigin: 'TOP' }
  );
  recordImpostor({
    id,
    kind: 'CROSS_QUADS',
    origin: 'BAKED',
    bakeMs: performance.now() - bakeStart,
    source,
  });
  return impostor;
};

/** What {@link buildCrossQuads} needs besides the layout and the atlases: the resolved options of
 * a bake, or an export's */
export type CrossQuadsBuildOptions = {
  /** Registers the planes under `id` and the material under `${id}.mat` */
  id: string;
  alphaTest: number;
  /** Resolved (never `AUTO`): `getShadingProps`' type and params (a colour may be a hex string) */
  shading: { type: string; params: Record<string, unknown> };
  /** The atlases' v origin: `TOP` for a bake's render targets, `BOTTOM` for loaded KTX2 slots */
  vOrigin: ImpostorAtlasVOrigin;
};

/**
 * Builds and registers a cross-quad impostor's planes and material over registered atlases (a
 * bake's, or an export's loaded slots; `normal` null lights each plane flat), so a later
 * `generateCrossQuads` with the same id returns them. Both of its paths end here.
 */
export const buildCrossQuads = (
  layout: CrossQuadsLayout,
  albedo: THREE.Texture,
  normal: THREE.Texture | null,
  { id, alphaTest, shading, vOrigin }: CrossQuadsBuildOptions
): CrossQuads => {
  const quads = createCrossQuadsGeometry(layout, vOrigin);
  quads.name = id;
  saveBufferGeometry(quads, { id });

  const { type, params } = shading;
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
    impostorMaterial.normalNode = createPlaneNormalNode(normal, vOrigin);
  }
  return { id, geometry: quads, material: impostorMaterial, albedo, normal };
};

/** What {@link bakeCrossQuadsAtlases} reads of the resolved options */
export type CrossQuadsBakeSettings = Pick<
  ReturnType<typeof resolveCrossQuadsOptions>,
  'planes' | 'frameSize' | 'gutter' | 'normals'
>;

/**
 * Renders the atlases of a cross-quad impostor of `geometry` drawn with `material` (see
 * {@link generateCrossQuads}) into new atlas targets, named `${id}.albedo` and `${id}.normal`
 * (null without `normals`), and returns them with their layout. Nothing is registered: the
 * targets are the caller's to dispose (disposing a target's texture disposes the target). What
 * `generateCrossQuads` registers, and what an export reads back.
 *
 * Synchronous, with the renderer (after `InitEngine`), restoring its target and clear state.
 */
export const bakeCrossQuadsAtlases = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  { planes, frameSize, gutter, normals }: CrossQuadsBakeSettings,
  id: string
): { layout: CrossQuadsLayout; albedo: THREE.RenderTarget; normal: THREE.RenderTarget | null } => {
  const renderer = getBakeRenderer('bakeCrossQuadsAtlases');

  // Frame layout: every plane spans the object's bounds around its axis, at one texel size
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  box.getCenter(_center);
  const radius = getAxisRadius(geometry, _center.x, _center.z);
  const height = box.max.y - box.min.y;
  if (!(radius > 0) || !(height > 0)) {
    throw new Error(`bakeCrossQuadsAtlases: '${id}' has no extent to bake.`);
  }
  const texelWorld = Math.max(2 * radius, height) / (frameSize - 2 * FRAME_MARGIN);
  // Grown to whole cells of blocks, the extra texels split around the object
  const alignFrame = (texels: number) =>
    texels + ((CELL_ALIGN - ((texels + 2 * gutter) % CELL_ALIGN)) % CELL_ALIGN);
  const frameWidth = alignFrame(Math.ceil((2 * radius) / texelWorld) + 2 * FRAME_MARGIN);
  const frameHeight = alignFrame(Math.ceil(height / texelWorld) + 2 * FRAME_MARGIN);
  const halfWidth = (frameWidth * texelWorld) / 2;
  const halfHeight = (frameHeight * texelWorld) / 2;
  const cellWidth = frameWidth + 2 * gutter;
  const cellHeight = frameHeight + 2 * gutter;
  const atlasWidth = planes * cellWidth;
  const axisCenter = new THREE.Vector3(_center.x, (box.min.y + box.max.y) / 2, _center.z);
  const layout: CrossQuadsLayout = {
    planes,
    frameWidth,
    frameHeight,
    gutter,
    atlasSize: [atlasWidth, cellHeight],
    center: axisCenter.toArray(),
    halfWidth,
    halfHeight,
  };

  const passes: Exclude<ImpostorBakePass, 'NORMAL_DEPTH'>[] = normals
    ? ['ALBEDO', 'NORMAL']
    : ['ALBEDO'];
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

  try {
    withBakeRendererState(renderer, () => {
      for (const pass of passes) clearBakeTarget(renderer, atlases[pass]!);
      for (let i = 0; i < planes; i++) {
        // The camera looks along -dir, so the plane's front faces it and its u runs along the
        // camera's right
        getPlaneAxes(i, planes, _dir, _right);
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

  return { layout, albedo: atlases.ALBEDO, normal: atlases.NORMAL };
};
