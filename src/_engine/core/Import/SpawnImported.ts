import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../../utils/Logger';
import { getEntityIdByAppId } from '../ECS';
import { getGeometryRegistry } from '../Geometry';
import { getMaterial } from '../Material';
import { createMeshEntity, type MeshProps } from '../MeshManager';
import type { ColliderParams, RigidBodyParams } from '../Physics/PhysicsAPITypes';
import { createPhysicsEntity } from '../PhysicsManager';
import { parseCustomProps } from './CustomProps';
import { getImportedAsset, retagImportedAsset } from './ImportRegistry';
import { deriveColliderFromGeometry } from './MeshColliderGeometry';
import type {
  ImportedAssetManifest,
  ImportedGeometryInfo,
  ImportPhysicsParams,
  ParsedCustomProps,
  SpawnImportedParams,
  SpawnImportedResult,
} from './ImportTypes';

/** Used for visible pieces when no `material` is given (glTF materials are never imported). */
const DEFAULT_MATERIAL = { id: 'importedAssetDefault', type: 'STANDARD' } as const;

type SpawnNode = {
  info: ImportedGeometryInfo;
  geometry: THREE.BufferGeometry;
  props: ParsedCustomProps;
  /** The node's physicsParams override, for the fields custom props can't express. */
  override?: ImportPhysicsParams;
  /** appId part, unique within the import: the node name (+ `#n` for repeated names, ie. the
   * primitives of a multi-primitive mesh). */
  localName: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  entityId?: number;
};

const getRootMatrix = (transform: SpawnImportedParams['transform']) => {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  if (transform?.position)
    position.set(transform.position.x, transform.position.y, transform.position.z);
  if (transform?.quaternion) {
    const q = transform.quaternion;
    quaternion.set(q.x, q.y, q.z, q.w);
  } else if (transform?.rotation) {
    const r = transform.rotation;
    quaternion.setFromEuler(new THREE.Euler(r.x, r.y, r.z));
  }
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
};

const toSpawnNodes = (
  manifest: ImportedAssetManifest,
  params: SpawnImportedParams
): SpawnNode[] => {
  const rootMatrix = getRootMatrix(params.transform);
  const overrides = Array.isArray(params.physicsParams)
    ? params.physicsParams
    : params.physicsParams
      ? [params.physicsParams]
      : [];
  const registry = getGeometryRegistry();
  const nameCounts = new Map<string, number>();
  const nodes: SpawnNode[] = [];

  manifest.geometries.forEach((info, i) => {
    const count = (nameCounts.get(info.nodeName) || 0) + 1;
    nameCounts.set(info.nodeName, count);
    if (params.filter && !params.filter(info)) return;

    const geometry = registry[info.geometryId]?.resource;
    if (!geometry) {
      lerror(
        `spawnImportedAsset: geometry "${info.geometryId}" of import "${manifest.id}" is not registered (released?), node "${info.nodeName}" skipped.`
      );
      return;
    }

    const { position: p, quaternion: q, scale: s } = info.transform;
    const matrix = new THREE.Matrix4()
      .compose(
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Quaternion(q.x, q.y, q.z, q.w),
        new THREE.Vector3(s.x, s.y, s.z)
      )
      .premultiply(rootMatrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);

    nodes.push({
      info,
      geometry,
      props: overrides[i] ? parseCustomProps(info.customProps.raw, overrides[i]) : info.customProps,
      override: overrides[i],
      localName: count > 1 ? `${info.nodeName}#${count - 1}` : info.nodeName,
      position,
      quaternion,
      scale,
    });
  });
  return nodes;
};

const getMeshProps = (
  params: SpawnImportedParams,
  info: ImportedGeometryInfo,
  index: number
): Partial<MeshProps> | undefined =>
  Array.isArray(params.meshProps) ? params.meshProps[index] : params.meshProps?.[info.geometryId];

/** Physics of the spawned nodes: one rigid body per custom prop `index` group (nodes without an index form one group together),
 * carried by the group's node with a `rigidType`, plus one collider per physics node of the group.
 *
 * The rigid body attaches to an existing mesh entity (the anchor): the rigid body node itself when
 * it's visible, otherwise the group's first visible node. Every other collider is offset by its
 * node's transform relative to the anchor's position + rotation. A group with no visible node
 * becomes a headless physics entity at the rigid body node's transform. */
const spawnPhysics = async (
  nodes: SpawnNode[],
  params: SpawnImportedParams,
  appIdPrefix: string | undefined
) => {
  const groups: SpawnNode[][] = [];
  const withoutIndex = nodes.filter((n) => typeof n.props.index !== 'number');
  if (withoutIndex.length) groups.push(withoutIndex);
  const indexes = [
    ...new Set(nodes.map((n) => n.props.index).filter((i) => typeof i === 'number')),
  ];
  for (const index of indexes) groups.push(nodes.filter((n) => n.props.index === index));

  const physicsEntityIds: number[] = [];
  for (const group of groups) {
    const rigid = group.find((n) => n.props.rigidType);
    if (!rigid?.props.isPhysObj || !rigid.props.colliderParams) continue;
    const members = [
      rigid,
      ...group.filter(
        (n) => n !== rigid && !n.props.rigidType && n.props.isPhysObj && n.props.colliderParams
      ),
    ];
    // Same anchor search order as before: rigid node, then colliders, then non-collider nodes
    const searchOrder = [
      rigid,
      ...group.filter((n) => n !== rigid && !n.props.rigidType && n.props.colliderParams),
      ...group.filter((n) => n !== rigid && !n.props.rigidType && !n.props.colliderParams),
    ];
    const anchor = searchOrder.find((n) => n.entityId !== undefined) || rigid;
    const anchorInverse = new THREE.Matrix4()
      .compose(anchor.position, anchor.quaternion, new THREE.Vector3(1, 1, 1))
      .invert();

    const colliders: ColliderParams[] = [];
    for (const member of members) {
      // Override fields custom props can't express (isSensor, event callbacks, explicit
      // vertices, ...) pass through; the parsed fields already include the override's values
      const colliderParams = {
        ...member.override?.collider,
        ...member.props.colliderParams,
      } as ColliderParams;
      let collider = deriveColliderFromGeometry(colliderParams, {
        geometry: member.geometry,
        info: member.info,
      });
      if (!collider) continue;
      if (member !== anchor && !collider.translation && !collider.rotation) {
        const offset = new THREE.Matrix4()
          .compose(member.position, member.quaternion, new THREE.Vector3(1, 1, 1))
          .premultiply(anchorInverse);
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();
        offset.decompose(pos, rot, new THREE.Vector3());
        // Identity rotation is left out so it can't override a shape's own `orientation`
        const isRotated = Math.abs(rot.w) < 1 - 1e-6;
        collider = {
          ...collider,
          translation: { x: pos.x, y: pos.y, z: pos.z },
          ...(isRotated ? { rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w } } : {}),
        };
      }
      colliders.push(collider);
    }
    if (!colliders.length) continue;

    // The override's other rigid body fields (angvel, ccdEnabled, ...) pass through; placement
    // is the spawner's (translation/rotation come from the node and the root transform)
    const overrideRigidBody: Partial<RigidBodyParams> = { ...rigid.override?.rigidBody };
    delete overrideRigidBody.translation;
    delete overrideRigidBody.rotation;
    const userData = { ...rigid.props.rigidBodyUserData, ...overrideRigidBody.userData };
    const rigidBody: RigidBodyParams = {
      ...overrideRigidBody,
      rigidType: rigid.props.rigidType as RigidBodyParams['rigidType'],
      ...(Object.keys(userData).length ? { userData } : {}),
    };
    const isHeadless = anchor.entityId === undefined;
    const entityId = await createPhysicsEntity(
      colliders,
      isHeadless
        ? {
            ...rigidBody,
            translation: { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z },
            rotation: {
              x: anchor.quaternion.x,
              y: anchor.quaternion.y,
              z: anchor.quaternion.z,
              w: anchor.quaternion.w,
            },
          }
        : rigidBody,
      anchor.entityId,
      isHeadless
        ? {
            ...params.entityOpts,
            appId: appIdPrefix ? `${appIdPrefix}/${rigid.localName}-phys` : undefined,
          }
        : undefined
    );
    physicsEntityIds.push(entityId);
  }
  return physicsEntityIds;
};

/**
 * Spawns an import's mesh and physics entities from its manifest: one mesh entity per visible
 * node (non-physics nodes and `keepMesh` physics nodes), using the registered geometry by id and
 * an engine material, at root transform ∘ node transform (node scale included), and the physics
 * the nodes' Blender custom props (or `physicsParams` overrides) describe, via the Physics API.
 * @param manifestOrId an {@link ImportedAssetManifest} or the id of an imported asset
 * @param params {@link SpawnImportedParams}
 * @returns Promise<{@link SpawnImportedResult}>
 */
export const spawnImportedAsset = async (
  manifestOrId: ImportedAssetManifest | string,
  params: SpawnImportedParams = {}
): Promise<SpawnImportedResult> => {
  const manifest = typeof manifestOrId === 'string' ? getImportedAsset(manifestOrId) : manifestOrId;
  if (!manifest) {
    lerror(`spawnImportedAsset: no imported asset with id "${manifestOrId}" (import it first).`);
    return { meshEntityIds: [], physicsEntityIds: [] };
  }
  // Claimed for the scene spawning it (its collider-only geometries take no refs), see AssetOwners
  retagImportedAsset(manifest.id);

  const nodes = toSpawnNodes(manifest, params);
  let appIdPrefix: string | undefined = params.entityOpts?.appId ?? manifest.id;
  if (nodes.length && getEntityIdByAppId(`${appIdPrefix}/${nodes[0].localName}`) !== undefined) {
    lwarn(
      `spawnImportedAsset: entities with the appId prefix "${appIdPrefix}" already exist, so this spawn of "${manifest.id}" gets generated appIds. Pass a distinct entityOpts.appId for stable ones.`
    );
    appIdPrefix = undefined;
  }

  let material: MeshProps['mat'] = DEFAULT_MATERIAL;
  if (typeof params.material === 'string') {
    const registered = getMaterial(params.material);
    if (registered) material = registered;
    else lerror(`spawnImportedAsset: material "${params.material}" not found, using the default.`);
  } else if (params.material) {
    material = params.material;
  }

  const meshEntityIds: number[] = [];
  nodes.forEach((node) => {
    if (node.props.isPhysObj && !node.props.keepMesh) return;
    const index = manifest.geometries.indexOf(node.info);
    const meshProps = getMeshProps(params, node.info, index);
    const appId =
      meshProps?.appId ?? (appIdPrefix ? `${appIdPrefix}/${node.localName}` : undefined);
    const hasTransformOverride = Boolean(meshProps?.rotation || meshProps?.quaternion);
    node.entityId = createMeshEntity(
      {
        ...meshProps,
        geo: meshProps?.geo ?? node.info.geometryId,
        mat: meshProps?.mat ?? material,
        castShadow: meshProps?.castShadow ?? params.castShadow,
        receiveShadow: meshProps?.receiveShadow ?? params.receiveShadow,
        position: meshProps?.position ?? node.position,
        quaternion: hasTransformOverride ? meshProps?.quaternion : node.quaternion,
        scale: meshProps?.scale ?? node.scale,
        appId,
      },
      { ...params.entityOpts, appId }
    );
    meshEntityIds.push(node.entityId);
  });

  const physicsEntityIds = await spawnPhysics(nodes, params, appIdPrefix);
  return { meshEntityIds, physicsEntityIds };
};
