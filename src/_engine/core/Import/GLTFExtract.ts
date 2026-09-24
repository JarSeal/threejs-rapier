import * as THREE from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { isOnlyObject3D } from '../../utils/helpers';
import { parseCustomProps } from './CustomProps';
import type { ImportedGeometryInfo } from './ImportTypes';

type Association = { nodes?: number; meshes?: number; primitives?: number };

type GLTFJson = {
  meshes?: { primitives: { extensions?: Record<string, unknown> }[] }[];
};

/** One extracted primitive: its (not yet registered) geometry, glTF material and metadata. */
export type ExtractedPrimitive = {
  geometry: THREE.BufferGeometry;
  /** Only read for texture registration, then disposed with the rest of the glTF. */
  material: THREE.Material | THREE.Material[];
  /** `geometryId` is the preferred id; the registry step may still add a collision suffix. */
  info: ImportedGeometryInfo;
};

export type ExtractResult =
  | { primitives: ExtractedPrimitive[]; error?: undefined }
  | { primitives?: undefined; error: string };

/** A Blender export often has a single empty Object3D as its only root: its children are then
 * the real pieces, and transforms are relative to it. */
const getImportRoot = (gltf: GLTF): THREE.Object3D => {
  const children = gltf.scene.children;
  if (children.length === 1 && isOnlyObject3D(children[0])) return children[0];
  return gltf.scene;
};

const getIndexedNode = (root: THREE.Object3D, meshIndex: number | number[]) => {
  const path = Array.isArray(meshIndex) ? (meshIndex.length ? meshIndex : [0]) : [meshIndex];
  let node: THREE.Object3D | undefined = root;
  for (let i = 0; i < path.length && node; i++) node = node.children[path[i]];
  return node || null;
};

/**
 * Walks a parsed glTF and describes every mesh primitive in it (or only in the node picked with
 * `meshIndex`): its geometry, glTF-root-relative transform, parsed custom props and whether it
 * was DRACO-compressed. Pure: nothing is registered, disposed or logged.
 */
export const extractPrimitives = (
  gltf: GLTF,
  opts: { importId: string; meshIndex?: number | number[] }
): ExtractResult => {
  const { importId, meshIndex } = opts;
  const root = getImportRoot(gltf);
  let subtreeRoot = root;
  if (meshIndex !== undefined) {
    const node = getIndexedNode(root, meshIndex);
    if (!node)
      return { error: `Could not find a node with meshIndex ${JSON.stringify(meshIndex)}.` };
    subtreeRoot = node;
  }

  const associations = gltf.parser.associations as Map<THREE.Object3D, Association>;
  const json = gltf.parser.json as GLTFJson;
  root.updateWorldMatrix(true, true);
  const rootInverse = root.matrixWorld.clone().invert();

  const primitives: ExtractedPrimitive[] = [];
  const idsInUse = new Set<string>();
  subtreeRoot.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const assoc = associations.get(mesh) || {};
    // A multi-primitive glTF mesh becomes a Group (the node, holding the node's extras) with
    // one child Mesh per primitive; a single-primitive mesh is the node itself.
    const isNode = assoc.nodes !== undefined;
    const node = isNode ? mesh : (mesh.parent as THREE.Object3D);
    const primitiveCount =
      assoc.meshes !== undefined ? json.meshes?.[assoc.meshes]?.primitives.length || 1 : 1;
    const primitiveDef =
      assoc.meshes !== undefined && assoc.primitives !== undefined
        ? json.meshes?.[assoc.meshes]?.primitives[assoc.primitives]
        : undefined;

    const nodeName = node.name || `node_${associations.get(node)?.nodes ?? primitives.length}`;
    let geometryId = `${importId}/${nodeName}`;
    if (primitiveCount > 1) geometryId += `#${assoc.primitives ?? 0}`;
    // GLTFLoader already makes node names unique; this only guards unexpected duplicates
    for (let n = 2; idsInUse.has(geometryId); n++) geometryId = `${importId}/${nodeName}_${n}`;
    idsInUse.add(geometryId);

    const parentPath: string[] = [];
    for (let p = node.parent; p && p !== gltf.scene; p = p.parent) parentPath.unshift(p.name);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    new THREE.Matrix4()
      .multiplyMatrices(rootInverse, mesh.matrixWorld)
      .decompose(position, quaternion, scale);

    // Node extras win over mesh extras, as they do on a single-primitive mesh
    const userData = { ...(node === mesh ? {} : mesh.userData), ...node.userData };
    delete userData.gltfExtensions;
    const customProps = parseCustomProps(userData);

    primitives.push({
      geometry: mesh.geometry,
      material: mesh.material,
      info: {
        geometryId,
        importId,
        nodeName,
        parentPath,
        transform: {
          position: { x: position.x, y: position.y, z: position.z },
          quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
          scale: { x: scale.x, y: scale.y, z: scale.z },
        },
        customProps,
        isDracoCompressed: Boolean(primitiveDef?.extensions?.KHR_draco_mesh_compression),
      },
    });
  });

  return { primitives };
};

/** Disposes every material, texture and geometry of a parsed glTF except the kept (registered)
 * geometries and textures. GLTFLoader decodes images into ImageBitmaps: those are closed too,
 * unless a kept texture shares the image (a clone for another UV channel does). */
export const disposeGLTFLeftovers = (
  gltf: GLTF,
  keep: { geometries?: Set<THREE.BufferGeometry>; textures?: Set<THREE.Texture> }
) => {
  const keptSources = new Set<unknown>();
  keep.textures?.forEach((texture) => keptSources.add(texture.source));
  const disposed = new Set<unknown>();
  const disposeTexture = (texture: THREE.Texture) => {
    if (disposed.has(texture) || keep.textures?.has(texture)) return;
    disposed.add(texture);
    const image = texture.source?.data as { close?: () => void } | undefined;
    if (!keptSources.has(texture.source) && typeof image?.close === 'function') image.close();
    texture.dispose();
  };

  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!keep.geometries?.has(mesh.geometry) && !disposed.has(mesh.geometry)) {
      disposed.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || disposed.has(material)) continue;
      disposed.add(material);
      for (const value of Object.values(material)) {
        if ((value as THREE.Texture | null)?.isTexture) disposeTexture(value as THREE.Texture);
      }
      material.dispose();
    }
  });
};
