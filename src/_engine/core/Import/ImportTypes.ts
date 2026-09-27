import type { ColliderParams, RigidBodyParams } from '../Physics/PhysicsAPITypes';
import type { TextureMapKeys } from '../Material';
import type { TexOpts } from '../Texture';
import type { MeshProps } from '../MeshManager';
import type { CoreEntityOpts } from '../../schemas/_helperSchemas';
import type * as THREE from 'three/webgpu';

/** Plain, structured-clone-safe vector (no THREE classes: a manifest must survive a worker hop). */
export type Vector3Like = { x: number; y: number; z: number };
/** Plain, structured-clone-safe quaternion. */
export type QuatLike = { x: number; y: number; z: number; w: number };

export type ImportAssetParams = {
  /** Import id, also the geometry id prefix (`${id}/${nodeName}`). Default: file basename
   * without the extension. */
  id?: string;
  /** URL of a .glb or .gltf file (eg. '/debugger/assets/testModels/box01.glb'). */
  fileName: string;
  /** Default false: glTF materials and their textures are disposed. true = also register every
   * texture used by an imported primitive's glTF material slot (as `${id}/${textureName}`), with
   * GLTFLoader's settings (flipY false, sRGB for color maps). `texOpts` override those settings for
   * every imported texture; `isPersistent` defaults to the import's own. */
  importTextures?: boolean | { texOpts?: TexOpts; isPersistent?: boolean };
  /** Only import one node (and its child nodes), picked by child index of the glTF root (after
   * the empty-wrapper unwrap) or by a nested index path ([2, 0] = first child of the third child).
   * Transforms stay relative to the glTF root. */
  meshIndex?: number | number[];
  /** Registers the geometries as persistent (they survive a ref count of 0 and
   * releaseImportedAsset without `includePersistent`). */
  isPersistent?: boolean;
  /** Throw instead of logging an error and resolving to null. */
  throwOnError?: boolean;
  /** Name/description for debug tooling (the Assets debugger tab). */
  debugData?: { name?: string; description?: string };
};

/** Physics override for one imported node. Wins field-by-field over the node's Blender custom
 * props, or adds physics to a node that has none (then a collider and a rigid body are needed). */
export type ImportPhysicsParams = {
  collider?: ColliderParams;
  rigidBody?: RigidBodyParams;
  /** Overrides the `id` custom prop. */
  meshId?: string;
  isPhysObj?: boolean;
  keepMesh?: boolean;
  name?: string;
  index?: number;
};

/** A node's Blender custom properties (glTF `extras`), normalized with the importer's defaults. */
export type ParsedCustomProps = {
  /** The node's raw custom props (glTF extras + GLTFLoader's `name`), for re-parsing with an
   * {@link ImportPhysicsParams} override. */
  raw: Record<string, unknown>;
  isPhysObj: boolean;
  /** Only set for physics nodes: whether the node is also rendered (false = collider only). */
  keepMesh?: boolean;
  /** Set on the node that carries the rigid body of its `index` group. Unknown values → 'FIXED'. */
  rigidType?: RigidBodyParams['rigidType'];
  /** Only set for physics nodes with a known `colliderType`. TRIMESH/CONVEXHULL/HEIGHTFIELD shape
   * data is derived from the geometry when spawning. */
  colliderParams?: ColliderParams;
  /** `userData_<key>` custom props, forwarded as the rigid body's `userData`. */
  rigidBodyUserData?: Record<string, unknown>;
  /** Compound group: all physics nodes with the same index share one rigid body. */
  index?: number;
  id?: string;
  name?: string;
  /** Problems found while parsing (eg. an unknown `colliderType`), logged by the importer. */
  warnings: string[];
};

export type ImportedGeometryInfo = {
  /** Registry id (`${importId}/${nodeName}`, plus `#n` for multi-primitive meshes). */
  geometryId: string;
  importId: string;
  /** The node's name as GLTFLoader names it (sanitized and unique within the file). */
  nodeName: string;
  /** Node names from the glTF root down to (not including) this node, for debugging/filtering. */
  parentPath: string[];
  /** Relative to the glTF root (after the empty-wrapper unwrap). */
  transform: { position: Vector3Like; quaternion: QuatLike; scale: Vector3Like };
  customProps: ParsedCustomProps;
  /** The primitive came from KHR_draco_mesh_compression (vertex order is not preserved). */
  isDracoCompressed: boolean;
  /** Only with importTextures: which registered texture filled which slot of this primitive's glTF
   * material, so an engine material can be given the same maps. */
  textureSlots?: Partial<Record<TextureMapKeys, string>>;
};

export type ImportedAssetManifest = {
  id: string;
  fileName: string;
  geometries: ImportedGeometryInfo[];
  textureIds: string[];
};

export type SpawnImportedParams = {
  /** Root transform: every node's glTF-root-relative transform is composed under it. `rotation`
   * (Euler, radians) is only used when `quaternion` isn't given. */
  transform?: { position?: Vector3Like; quaternion?: QuatLike; rotation?: Vector3Like };
  /** Engine material (or a registered material id) for every visible piece; glTF materials are
   * never imported. A `meshProps` entry's `mat` wins for its piece. */
  material?: THREE.Material | string;
  /** Shadow flags for every visible piece (a `meshProps` entry's own flags win). */
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Per-piece mesh overrides, by node order in the manifest (array) or by geometryId (record).
   * `position`/`rotation`/`quaternion`/`scale` replace the composed transform instead of adding
   * to it. */
  meshProps?: Partial<MeshProps>[] | Record<string, Partial<MeshProps>>;
  /** Physics overrides by node order in the manifest (a single object = the first node). The
   * fields custom props also have win field-by-field over the node's custom props (or add physics
   * to a node without any); the other `rigidBody` fields (angvel, ccdEnabled, ...) and `collider`
   * fields (isSensor, event callbacks, explicit vertices, ...) are applied as-is.
   * `rigidBody.translation`/`rotation` are ignored (placement comes from the node and
   * `transform`). */
  physicsParams?: ImportPhysicsParams | ImportPhysicsParams[];
  /** Only spawn the nodes this returns true for (the rest of the import is ignored entirely). */
  filter?: (info: ImportedGeometryInfo) => boolean;
  /** Core entity options for every created entity. `appId` is the prefix of the entities'
   * appIds (default: the import id): `${appId}/${node}` for meshes, `${appId}/${node}-phys` for
   * headless physics entities. Spawning one import twice needs a different appId for stable
   * ids. */
  entityOpts?: CoreEntityOpts;
};

export type SpawnImportedResult = {
  /** Mesh entities, in manifest order (collider-only nodes get none). */
  meshEntityIds: number[];
  /** Entities carrying rigid bodies: a mesh entity (anchor) or a headless physics entity. */
  physicsEntityIds: number[];
};
