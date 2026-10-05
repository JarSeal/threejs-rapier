import {
  Accessor,
  Primitive,
  type Document,
  type Mesh,
  type Node,
  type TypedArray,
} from '@gltf-transform/core';
import type { TransferableAttribute } from '../../src/_engine/core/Import/GeometryTransfer';
import {
  GLTF_LOD_EXTRAS_KEY,
  GLTF_LOD_FORMAT_VERSION,
  type GLTFLodChainsExtras,
} from '../../src/_engine/core/Lod/LodChainGLTF';
import type {
  LodLevelVertices,
  ResolvedLodChainOptions,
} from '../../src/_engine/core/Lod/LodChainOptions';
import { simplifyLodChain } from '../../src/_engine/core/Lod/LodSimplify';

/**
 * The GLB step's LOD chains (p347 Phase 3, §2.4): every rendered triangle primitive is simplified
 * with the runtime's own simplifier (`simplifyLodChain`), and its levels are written as meshes
 * `<mesh>__lod<n>` that no node references, described by the root's extras
 * (`core/Lod/LodChainGLTF.ts` reads them, and says why not as a second glTF scene). Runs after the geometry's compression transforms:
 * meshopt's reorder splits primitives that share attributes but not indices, so the levels are
 * built from the attributes as they ship (reordered, quantized) and index the base's accessors.
 */

/** A chain as the lock and the generated data record it (`__lodChain`) */
export type BuiltLodChain = {
  /** The glTF mesh's name (or `mesh<index>`) and its primitive */
  mesh: string;
  primitive: number;
  /** The base's largest bounding box side, in its own (possibly quantized) units */
  extent: number;
  vertices: LodLevelVertices;
  /** levels[0] is the base (error 0) */
  levels: { triangles: number; error: number }[];
};

/** The three attribute names the simplifier reads; other semantics keep their glTF name */
const THREE_NAMES: Record<string, string> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TEXCOORD_0: 'uv',
};

const ACCESSOR_TYPES = {
  1: Accessor.Type.SCALAR,
  2: Accessor.Type.VEC2,
  3: Accessor.Type.VEC3,
  4: Accessor.Type.VEC4,
} as const;

const toTransferable = (accessor: Accessor, name: string): TransferableAttribute => ({
  array: accessor.getArray() as TransferableAttribute['array'],
  itemSize: accessor.getElementSize(),
  normalized: accessor.getNormalized(),
  name,
});

/** Node extras win over mesh extras, as in CustomProps.ts: a collider-only node isn't rendered */
const isRenderedNode = (node: Node, mesh: Mesh) => {
  const extras = { ...mesh.getExtras(), ...node.getExtras() } as Record<string, unknown>;
  return !extras.isPhysObj || !!extras.keepMesh;
};

/**
 * Builds the LOD chains of a document's rendered meshes, in place.
 * @param options The resolved `lodChain` options (Draco forces `compactVertices`: its primitives
 * share all of their accessors or none)
 * @returns The chains, also those without levels; empty when nothing qualifies
 */
export const buildLodChains = async (
  doc: Document,
  options: ResolvedLodChainOptions,
  warn: (message: string) => void
): Promise<BuiltLodChain[]> => {
  const root = doc.getRoot();
  const defaultScene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!defaultScene || !options.ratios.length) return [];

  // The meshes a rendered node of the default scene uses (the scene the import reads)
  const renderedMeshes = new Set<Mesh>();
  defaultScene.traverse((node) => {
    const mesh = node.getMesh();
    if (mesh && isRenderedNode(node, mesh)) renderedMeshes.add(mesh);
  });
  if (!renderedMeshes.size) return [];

  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const createAccessor = (name: string, attr: TransferableAttribute) =>
    doc
      .createAccessor(name)
      .setType(ACCESSOR_TYPES[attr.itemSize as keyof typeof ACCESSOR_TYPES])
      .setNormalized(attr.normalized)
      .setArray(attr.array as TypedArray)
      .setBuffer(buffer);

  const meshes = root.listMeshes();
  const extras: GLTFLodChainsExtras = { version: GLTF_LOD_FORMAT_VERSION, options, chains: [] };
  const built: BuiltLodChain[] = [];

  for (const [meshIndex, mesh] of meshes.entries()) {
    if (!renderedMeshes.has(mesh)) continue;
    const primitives = mesh.listPrimitives();
    for (const [primitiveIndex, prim] of primitives.entries()) {
      const meshName = `${mesh.getName() || `mesh${meshIndex}`}${primitives.length > 1 ? `#${primitiveIndex}` : ''}`;
      const position = prim.getAttribute('POSITION');
      if (prim.getMode() !== Primitive.Mode.TRIANGLES || !position) continue;
      if (prim.listTargets().length || prim.getAttribute('JOINTS_0')) {
        warn(`mesh "${meshName}": no LOD chain, skinned and morph-target geometry isn't supported`);
        continue;
      }

      // Only the arrays the simplifier reads, unless it writes new vertex arrays from them
      const semanticByName = new Map<string, string>();
      const attributes: Record<string, TransferableAttribute> = {};
      const indices = prim.getIndices();
      const needsAll = !indices || options.compactVertices;
      for (const semantic of prim.listSemantics()) {
        const name = THREE_NAMES[semantic] ?? semantic;
        if (!needsAll && !THREE_NAMES[semantic]) continue;
        semanticByName.set(name, semantic);
        attributes[name] = toTransferable(prim.getAttribute(semantic)!, name);
      }
      const result = await simplifyLodChain(
        {
          name: meshName,
          attributes,
          morphAttributes: {},
          morphTargetsRelative: false,
          index: indices ? toTransferable(indices, '') : null,
          groups: [],
          drawRange: { start: 0, count: Infinity },
          boundingBox: null,
          boundingSphere: null,
          userData: {},
        },
        options,
        new Set()
      );

      // The welded arrays (a non-indexed base) are shared by every level
      const toAccessors = (arrays: Record<string, TransferableAttribute>, prefix: string) =>
        new Map(
          Object.entries(arrays).map(([name, attr]) => [
            semanticByName.get(name) ?? name,
            createAccessor(`${prefix}_${semanticByName.get(name) ?? name}`, attr),
          ])
        );
      const welded = result.welded ? toAccessors(result.welded, `${meshName}__welded`) : null;
      const vertices: LodLevelVertices = options.compactVertices
        ? 'OWN'
        : welded
          ? 'WELDED'
          : 'BASE';

      const levels: GLTFLodChainsExtras['chains'][number]['levels'] = [];
      for (const [i, level] of result.levels.entries()) {
        const name = `${meshName}__lod${i + 1}`;
        const levelAttributes = level.attributes
          ? toAccessors(level.attributes, name)
          : welded ??
            new Map(
              prim.listSemantics().map((semantic) => [semantic, prim.getAttribute(semantic)!])
            );
        const levelPrim = doc
          .createPrimitive()
          .setMode(Primitive.Mode.TRIANGLES)
          .setMaterial(prim.getMaterial())
          .setIndices(
            createAccessor(`${name}_indices`, {
              array: level.index,
              itemSize: 1,
              normalized: false,
              name: '',
            })
          );
        for (const [semantic, accessor] of levelAttributes)
          levelPrim.setAttribute(semantic, accessor);
        // No node: viewers don't draw it, the import loads it by index (LodChainGLTF.ts)
        const levelMesh = doc.createMesh(name).addPrimitive(levelPrim);
        // Appended after every source mesh: the writer keeps this order
        levels.push({
          mesh: root.listMeshes().indexOf(levelMesh),
          triangles: level.triangles,
          error: level.error,
        });
      }

      if (!levels.length) {
        warn(
          `mesh "${meshName}": no LOD level simplified within maxError ${options.maxError}${
            options.permissive ? '' : ' (flat-shaded geometry needs "permissive: true")'
          }; a very low-poly mesh has nothing to remove`
        );
      }
      extras.chains.push({
        mesh: meshIndex,
        primitive: primitiveIndex,
        extent: result.extent,
        baseTriangles: result.baseTriangles,
        vertices: levels.length ? vertices : 'BASE',
        levels,
      });
      built.push({
        mesh: mesh.getName() || `mesh${meshIndex}`,
        primitive: primitiveIndex,
        extent: result.extent,
        vertices: levels.length ? vertices : 'BASE',
        levels: [
          { triangles: result.baseTriangles, error: 0 },
          ...levels.map(({ triangles, error }) => ({ triangles, error })),
        ],
      });
    }
  }

  // Chains without levels are recorded too, so the runtime doesn't simplify them again
  if (extras.chains.length) root.setExtras({ ...root.getExtras(), [GLTF_LOD_EXTRAS_KEY]: extras });
  return built;
};
