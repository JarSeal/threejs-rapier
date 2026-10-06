// Octahedral impostors (docs/plans/p351_impostor-billboard-lod.md §2.2, Phase 3): one camera-facing
// quad per instance sampling an atlas of the object baked from N × N directions on an octahedral
// map (Octahedral.ts), blending the frames nearest to the view direction. Correct from any angle,
// including above, so it's meant for rocks, buildings and anything seen from the air.
//
// The atlases hold albedo, normals and depth, never light (§2.3): the material shades with the
// scene's lights at runtime. Normals are in the object's space (the blended frames each have their
// own view space), and depth (along each frame's view direction) is the normal atlas's alpha.
import * as THREE from 'three/webgpu';
import { retagAssetOwner } from '../../Assets/AssetOwners';
import { deleteTexture, doesTextureExist, getTexture, saveTexture } from '../../Texture';
import {
  clearBakeTarget,
  createAtlasTarget,
  createBakeMaterials,
  createDilateCopy,
  createFrameTarget,
  disposeBakeMaterials,
  getBakeRenderer,
  IMPOSTOR_DEPTH_MIN,
  withBakeRendererState,
  type ImpostorBakePass,
} from './ImpostorBake';
import { getOctahedralFrameBasis, getOctahedralFrameDirection } from './Octahedral';

export type OctahedralImpostorOptions = {
  /** The id the generated assets are registered under: the atlases `${id}.albedo` and
   * `${id}.normalDepth`. Default `${geometry's id}#octahedral`: pass one when the same geometry is
   * baked with other materials. */
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
  if (!doesTextureExist(`${id}.albedo`) || !doesTextureExist(`${id}.normalDepth`)) return null;
  const albedo = getTexture(`${id}.albedo`) as THREE.Texture;
  const normalDepth = getTexture(`${id}.normalDepth`) as THREE.Texture;
  const layout = albedo.userData[LAYOUT_KEY] as OctahedralImpostorLayout | undefined;
  if (!layout) return null;
  // To the loading scene, as any cache hit is
  for (const asset of [albedo, normalDepth]) retagAssetOwner(asset);
  return { id, layout, albedo, normalDepth };
};

/** Unregisters what's left of a bake under `id` that isn't complete (eg. a released atlas). */
const deleteLeftovers = (id: string) => {
  for (const texId of [`${id}.albedo`, `${id}.normalDepth`]) {
    if (doesTextureExist(texId)) deleteTexture(texId);
  }
};

/**
 * Bakes `geometry` drawn with `material` (a per-group array works as on a mesh) into an octahedral
 * impostor's atlases: `frames × frames` orthographic views of its bounding sphere, from the
 * directions of a full or hemi octahedral map, each into its own atlas cell. The atlases are
 * registered (owned by the loading scene, released with it), and a later call with the same `id`
 * returns them as they are, without baking (or reading `opts`), while they're registered.
 *
 * Bakes synchronously with the renderer (after `InitEngine`), restoring its target and clear
 * state. Frames are in the object's local space, so they're used with its instance transforms.
 */
export const generateOctahedralImpostor = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  opts: OctahedralImpostorOptions = {}
): OctahedralImpostor => {
  const { frames = 12, hemi = false, frameSize = 64, gutter = 4 } = opts;
  const id =
    opts.id ?? `${(geometry.userData.id as string | undefined) ?? geometry.uuid}#octahedral`;
  const registered = getRegistered(id);
  if (registered) return registered;
  deleteLeftovers(id);
  if (!Number.isInteger(frames) || frames < 2 || frames > 32) {
    throw new Error(`generateOctahedralImpostor: '${id}' frames must be an integer 2-32.`);
  }
  const renderer = getBakeRenderer('generateOctahedralImpostor');

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
  return { id, layout, albedo, normalDepth };
};
