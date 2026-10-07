// Octahedral impostors (docs/plans/p351_impostor-billboard-lod.md §2.2, Phase 3): one camera-facing
// quad per instance sampling an atlas of the object baked from N × N directions on an octahedral
// map (Octahedral.ts), blending the frames nearest to the view direction. Correct from any angle,
// including above, so it's meant for rocks, buildings and anything seen from the air.
//
// The atlases hold albedo, normals and depth, never light (§2.3): the material shades with the
// scene's lights at runtime. Normals are in the object's space (the blended frames each have their
// own view space), and depth (along each frame's view direction) is the normal atlas's alpha.
import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';
import { retagAssetOwner } from '../../Assets/AssetOwners';
import { deleteGeometry, doesGeoExist, getGeometry, saveBufferGeometry } from '../../Geometry';
import {
  createMaterial,
  deleteMaterial,
  doesMatExist,
  getMaterial,
  type MatProps,
} from '../../Material';
import { deleteTexture, doesTextureExist, getTexture, saveTexture } from '../../Texture';
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
  IMPOSTOR_DEPTH_MIN,
  withBakeRendererState,
  type ImpostorBakePass,
  type ImpostorShading,
} from './ImpostorBake';
import { recordImpostor } from './ImpostorRegistry';
import { getOctahedralFrameBasis, getOctahedralFrameDirection } from './Octahedral';
import {
  createOctahedralImpostorNodes,
  createOctahedralImpostorQuad,
} from './OctahedralImpostorMaterial';

export type OctahedralImpostorOptions = {
  /** The id the generated assets are registered under: the geometry `id`, the material
   * `${id}.mat`, the atlases `${id}.albedo` and `${id}.normalDepth`. Default
   * `${geometry's id}#octahedral`: pass one when the same geometry is baked with other materials. */
  id?: string;
  /** Frames along each side of the grid (the atlas holds `frames²`), 2-32. Default 12. */
  frames?: number;
  /** The upper hemisphere only: for objects never seen from below, the same frames cover half the
   * directions. Default false. */
  hemi?: boolean;
  /** A frame's side, in texels. Default 64. */
  frameSize?: number;
  /** Texels between a frame and its cell's edge, which keep mipmaps from mixing frames. Default 4. */
  gutter?: number;
  /** Default 0.5. */
  alphaTest?: number;
  /** The shading model (see {@link ImpostorShading}). Default `AUTO`. */
  shading?: ImpostorShading;
  /** Draw the baked surface's depth in the main and the shadow pass, and receive shadows on that
   * surface. Default true. false draws the quad's flat depth (it cuts into neighbours and the
   * ground along a plane through the centre) and receives no shadows, as the flat quad would
   * shadow half of itself with its own light-facing quad. It still casts its silhouette. Writing
   * depth from the shader turns off early depth tests (and a tile GPU's hidden-surface removal),
   * so false costs much less where impostors cover many pixels: 217 rock impostors from
   * largeWorld's overview camera took 0.34 ms of GPU time a frame with it, 0.09 ms without
   * (docs/plans/p351_impostor-billboard-lod.md, Phase 3). Keep it on for objects sunk deep in
   * the ground: a flat quad through a buried centre is mostly underground. */
  surfaceDepth?: boolean;
};

/** Where an impostor's frames are and what they show: what its material needs besides the atlases.
 * Stored on the albedo atlas (`userData.octahedralImpostor`), so a registered bake can be reused. */
export type OctahedralImpostorLayout = {
  frames: number;
  hemi: boolean;
  frameSize: number;
  gutter: number;
  /** Texels per side of the (square) atlases: `frames × (frameSize + 2 × gutter)`. Frame (`i`, `j`)'s
   * cell starts at texel (`i`, `j`) × the cell size, from the image's top left (v = 0 is the top). */
  atlasSize: number;
  /** The object's bounding sphere centre (local space), which every frame is centred on. */
  center: [x: number, y: number, z: number];
  /** The bounding sphere's radius: depth runs from -radius to radius around the centre. */
  radius: number;
  /** Half a frame's side, in local units (the radius plus a margin). */
  extent: number;
};

export type OctahedralImpostor = {
  id: string;
  layout: OctahedralImpostorLayout;
  /** Registered: one quad around the bounding sphere's centre (its bounds are the sphere), turned
   * to face the camera by `material`. */
  geometry: THREE.BufferGeometry;
  /** Registered: alpha-tested and double-sided, drawing the atlases through its `positionNode`,
   * `colorNode`, `depthNode` (the baked surface's depth, in the main and the shadow pass; not with
   * `surfaceDepth: false`) and, when lit, `normalNode` and `receivedShadowPositionNode` (with
   * `surfaceDepth: false`, a `receivedShadowNode` that ignores shadows instead;
   * `OctahedralImpostorMaterial.ts`); a lit one also has `normalDepth` as its `normalMap`, so the
   * asset tooling sees it. Use it on an InstancedMesh (eg. a LOD pool's level) or a plain mesh. */
  material: THREE.Material;
  /** Registered sRGB atlas: albedo and coverage alpha. */
  albedo: THREE.Texture;
  /** Registered linear atlas: the object-space normal (`n × 0.5 + 0.5`) and, in alpha, the depth
   * toward the frame's camera (`encodeImpostorDepth`). */
  normalDepth: THREE.Texture;
};

/** Texels between the object's bounding sphere and a frame's edge, so its silhouette never touches it. */
const FRAME_MARGIN = 2;
const LAYOUT_KEY = 'octahedralImpostor';

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/** The registered result of an earlier bake under `id`, when all of it is still registered. */
const getRegistered = (id: string): OctahedralImpostor | null => {
  if (!doesGeoExist(id) || !doesMatExist(`${id}.mat`)) return null;
  if (!doesTextureExist(`${id}.albedo`) || !doesTextureExist(`${id}.normalDepth`)) return null;
  const geometry = getGeometry(id) as THREE.BufferGeometry;
  const material = getMaterial(`${id}.mat`) as THREE.Material;
  const albedo = getTexture(`${id}.albedo`) as THREE.Texture;
  const normalDepth = getTexture(`${id}.normalDepth`) as THREE.Texture;
  const layout = albedo.userData[LAYOUT_KEY] as OctahedralImpostorLayout | undefined;
  if (!layout) return null;
  // To the loading scene, as any cache hit is
  for (const asset of [geometry, material, albedo, normalDepth]) retagAssetOwner(asset);
  return { id, layout, geometry, material, albedo, normalDepth };
};

/** Unregisters what's left of a bake under `id` that isn't complete (eg. a released atlas). */
const deleteLeftovers = (id: string) => {
  if (doesMatExist(`${id}.mat`)) deleteMaterial(`${id}.mat`);
  if (doesGeoExist(id)) deleteGeometry(id);
  for (const texId of [`${id}.albedo`, `${id}.normalDepth`]) {
    if (doesTextureExist(texId)) deleteTexture(texId);
  }
};

/**
 * The options a bake of `geometry` drawn with `material` uses: `opts` with their defaults, and the
 * shading resolved (never `AUTO`). What an export writes, and its fingerprint covers
 * (`getImpostorSourceHash`).
 */
export const resolveOctahedralImpostorOptions = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  opts: OctahedralImpostorOptions = {}
) => {
  const {
    frames = 12,
    hemi = false,
    frameSize = 64,
    gutter = 4,
    alphaTest = 0.5,
    shading = 'AUTO',
    surfaceDepth = true,
  } = opts;
  return {
    kind: 'OCTAHEDRAL' as const,
    frames,
    hemi,
    frameSize,
    gutter,
    alphaTest,
    surfaceDepth,
    shading: getShadingProps(getDominantMaterial(geometry, material), shading),
  };
};

/**
 * Bakes `geometry` drawn with `material` (a per-group array works as on a mesh) into an octahedral
 * impostor: atlases of `frames × frames` orthographic views of its bounding sphere, from the
 * directions of a full or hemi octahedral map, each into its own atlas cell, and a camera-facing
 * quad with a material that blends the three frames nearest to the view direction (each moved
 * onto the object's surface by its baked depth), lit at runtime with the baked normals and
 * shadowed at that surface. Its geometry, material and atlases are registered (owned by the
 * loading scene, released with it), and a later call with the same `id` returns them as they are,
 * without baking (or reading `opts`), while they're registered.
 *
 * Bakes synchronously with the renderer (after `InitEngine`), restoring its target and clear
 * state. Frames are in the object's local space, so they're used with its instance transforms.
 */
export const generateOctahedralImpostor = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  opts: OctahedralImpostorOptions = {}
): OctahedralImpostor => {
  const id =
    opts.id ?? `${(geometry.userData.id as string | undefined) ?? geometry.uuid}#octahedral`;
  const registered = getRegistered(id);
  if (registered) return registered;
  const { frames, hemi, frameSize, gutter, alphaTest, surfaceDepth, shading } =
    resolveOctahedralImpostorOptions(geometry, material, opts);
  deleteLeftovers(id);
  if (!Number.isInteger(frames) || frames < 2 || frames > 32) {
    throw new Error(`generateOctahedralImpostor: '${id}' frames must be an integer 2-32.`);
  }
  const renderer = getBakeRenderer('generateOctahedralImpostor');
  const bakeStart = performance.now();

  // Every frame shows the bounding sphere, at one texel size
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere!;
  const radius = sphere.radius;
  if (!(radius > 0)) {
    throw new Error(`generateOctahedralImpostor: '${id}' has no extent to bake.`);
  }
  const extent = (radius * frameSize) / (frameSize - 2 * FRAME_MARGIN);
  const cellSize = frameSize + 2 * gutter;
  const atlasSize = frames * cellSize;
  const layout: OctahedralImpostorLayout = {
    frames,
    hemi,
    frameSize,
    gutter,
    atlasSize,
    center: sphere.center.toArray(),
    radius,
    extent,
  };

  // The camera stands well outside the sphere, so depth stays precise across it
  const depthRange = { distance: 2 * radius, radius };
  const passes: Exclude<ImpostorBakePass, 'NORMAL'>[] = ['ALBEDO', 'NORMAL_DEPTH'];
  const atlases = {
    ALBEDO: createAtlasTarget(atlasSize, atlasSize, 'ALBEDO', `${id}.albedo`),
    NORMAL_DEPTH: createAtlasTarget(atlasSize, atlasSize, 'NORMAL_DEPTH', `${id}.normalDepth`),
  };
  const bakeMaterials = {
    ALBEDO: createBakeMaterials(material, 'ALBEDO'),
    NORMAL_DEPTH: createBakeMaterials(material, 'NORMAL_DEPTH', depthRange),
  };
  const frame = createFrameTarget(frameSize, frameSize);
  const dilates = {
    ALBEDO: createDilateCopy(frame, gutter),
    // Covered where the depth is (never 0 there), and the depth is filled in with the normal, so
    // filtering at the silhouette doesn't pull it toward the back
    NORMAL_DEPTH: createDilateCopy(frame, gutter, {
      coverage: IMPOSTOR_DEPTH_MIN / 2,
      dilateAlpha: true,
    }),
  };
  const scene = new THREE.Scene();
  scene.name = 'ImpostorBake.scene';
  const mesh = new THREE.Mesh(geometry, bakeMaterials.ALBEDO);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(
    -extent,
    extent,
    extent,
    -extent,
    depthRange.distance - radius * 1.01,
    depthRange.distance + radius * 1.01
  );

  try {
    withBakeRendererState(renderer, () => {
      for (const pass of passes) clearBakeTarget(renderer, atlases[pass]);
      for (let j = 0; j < frames; j++) {
        for (let i = 0; i < frames; i++) {
          // The camera's axes are the frame's basis, which the material rebuilds the same way
          getOctahedralFrameDirection(i, j, frames, hemi, _dir);
          getOctahedralFrameBasis(_dir, _right, _up);
          _basis.makeBasis(_right, _up, _dir);
          camera.quaternion.setFromRotationMatrix(_basis);
          camera.position.copy(sphere.center).addScaledVector(_dir, depthRange.distance);
          camera.updateMatrixWorld();

          for (const pass of passes) {
            mesh.material = bakeMaterials[pass];
            clearBakeTarget(renderer, frame);
            renderer.render(scene, camera);
            dilates[pass].copy(
              renderer,
              atlases[pass],
              i * cellSize,
              j * cellSize,
              cellSize,
              cellSize
            );
          }
        }
      }
    });
  } catch (error) {
    atlases.ALBEDO.dispose();
    atlases.NORMAL_DEPTH.dispose();
    throw error;
  } finally {
    disposeBakeMaterials(bakeMaterials.ALBEDO);
    disposeBakeMaterials(bakeMaterials.NORMAL_DEPTH);
    dilates.ALBEDO.dispose();
    dilates.NORMAL_DEPTH.dispose();
    frame.dispose();
  }

  const albedo = saveTexture(atlases.ALBEDO.texture, `${id}.albedo`);
  albedo.userData[LAYOUT_KEY] = layout;
  const normalDepth = saveTexture(atlases.NORMAL_DEPTH.texture, `${id}.normalDepth`);

  const quad = createOctahedralImpostorQuad(layout);
  quad.name = id;
  saveBufferGeometry(quad, { id });
  const { type, params } = shading;
  const impostorMaterial = createMaterial({
    id: `${id}.mat`,
    type,
    params: { ...params, alphaTest, side: THREE.DoubleSide },
  } as MatProps) as THREE.NodeMaterial & { normalMap: THREE.Texture | null };
  impostorMaterial.name = id;
  const nodes = createOctahedralImpostorNodes(layout, albedo, normalDepth);
  impostorMaterial.positionNode = nodes.positionNode;
  impostorMaterial.colorNode = nodes.colorNode;
  if (surfaceDepth) impostorMaterial.depthNode = nodes.depthNode;
  // An unlit impostor has no use for normals or received shadows
  if (type !== 'BASICNODEMATERIAL') {
    impostorMaterial.normalNode = nodes.normalNode;
    impostorMaterial.normalMap = normalDepth;
    if (surfaceDepth) {
      impostorMaterial.receivedShadowPositionNode = nodes.receivedShadowPositionNode;
    } else {
      // Lit by every light as if unshadowed: in the material, not `receiveShadow: false` on the
      // object, so it holds on any mesh (a pool's level meshes share one receiveShadow)
      impostorMaterial.receivedShadowNode = () => float(1);
    }
  }

  recordImpostor({
    id,
    kind: 'OCTAHEDRAL',
    origin: 'BAKED',
    bakeMs: performance.now() - bakeStart,
    source: { geometry, material, options: { ...opts, id } },
  });
  return { id, layout, geometry: quad, material: impostorMaterial, albedo, normalDepth };
};
