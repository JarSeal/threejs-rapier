import * as THREE from 'three/webgpu';
import { createGeometry, incGeometryRef, decGeometryRef, GeoProps } from './_Geometry';
import { createMaterial, incMaterialRef, decMaterialRef, MatProps } from './Material';
import { ECSWorld, getECSWorld } from './ECS';
import { getRootScene } from './Scene';
import { ThreeEuler, ThreeQuoternion } from '../utils/helpers';
import { getRenderer } from './Renderer';
import { ComponentType } from './ECS/ECSCoreComponents';
import { setTransform } from '../utils/ECSHelpers';
import { lwarn } from '../utils/Logger';
import { type CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';

// Register onDeleteEntity hook for TAG_IS_MESH
ECSWorld.registerComponentHooks(ComponentType.TAG_IS_MESH, {
  onDeleteEntity: (entityId, world) => disposeMesh(entityId, world),
});

export type MeshProps = {
  // @CONSIDER: We could also allow passing an id for geo and mat (as strings), and then look them up in the asset manager.
  geo: THREE.BufferGeometry | GeoProps;
  mat: THREE.Material | MatProps;
  castShadow?: boolean;
  receiveShadow?: boolean;
  preWarm?: boolean;
  position?: { x?: number; y?: number; z?: number };
  rotation?: { x?: number; y?: number; z?: number };
  quaternion?: THREE.Quaternion;
  appId?: string;
};

export const createMeshEntity = (
  props: MeshProps,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createMeshEntity.');

  const geo = props.geo instanceof THREE.BufferGeometry ? props.geo : createGeometry(props.geo);
  const mat = props.mat instanceof THREE.Material ? props.mat : createMaterial(props.mat);

  const mesh = new THREE.Mesh(geo, mat);
  const appId = props.appId || entityOpts?.appId || mesh.uuid;
  mesh.castShadow = props.castShadow ?? false;
  mesh.receiveShadow = props.receiveShadow ?? false;
  mesh.userData.id = appId;

  if (geo.userData.id) incGeometryRef(geo.userData.id);
  if (mat.userData.id) incMaterialRef(mat.userData.id);

  const rootScene = existsOrThrow(getRootScene(), 'Could not find root scene in createMeshEntity.');

  if (props.preWarm) {
    const renderer = getRenderer();
    const camera = new THREE.PerspectiveCamera(); // Consider using the actual active camera if available

    if (renderer && camera && rootScene) {
      // Check if this mesh is a "Shadow Receiver"
      const isShadowReceiver = props.receiveShadow === true;

      // Check if we have any valid shadow maps in the scene
      // WebGPU TSL needs a valid texture instance to compile a shadow-receiving shader.
      const hasInitializedShadows = rootScene.children.some(
        (child) =>
          child instanceof THREE.Light &&
          child.castShadow &&
          'shadow' in child &&
          (child as { shadow: { map?: unknown } }).shadow?.map
      );

      // Only compile if it's "safe"
      if (!isShadowReceiver || hasInitializedShadows) {
        renderer.compileAsync(mesh, camera, rootScene);
      } else {
        // If we can't pre-warm now, the renderer will just compile it
        // on the first actual draw call (standard behavior).
        lwarn(
          `[Engine] Skipping preWarm for ${entityOpts?.appId || 'mesh'} - ShadowMap not ready.`
        );
      }
    }
  }

  const entityId = world.createEntity(entityOpts);

  world.addComponent(entityId, ComponentType.OBJECT3D, {
    value: mesh,
    _lastVersion: -1,
  });

  if (!entityOpts?.doNotAddToScene) rootScene.add(mesh);

  const tra = {
    pos: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    rot: { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
  };
  if (props.position) {
    if (props.position.x !== undefined) tra.pos.x = props.position.x;
    if (props.position.y !== undefined) tra.pos.y = props.position.y;
    if (props.position.z !== undefined) tra.pos.z = props.position.z;
  }
  if (props.quaternion) {
    tra.rot.x = props.quaternion.x;
    tra.rot.y = props.quaternion.y;
    tra.rot.z = props.quaternion.z;
    tra.rot.w = props.quaternion.w;
  } else if (props.rotation) {
    const rot = ThreeEuler.set(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z);
    if (props.rotation.x !== undefined) rot.x = props.rotation.x;
    if (props.rotation.y !== undefined) rot.y = props.rotation.y;
    if (props.rotation.z !== undefined) rot.z = props.rotation.z;
    const quat = ThreeQuoternion.setFromEuler(rot);
    tra.rot.x = quat.x;
    tra.rot.y = quat.y;
    tra.rot.z = quat.z;
    tra.rot.w = quat.w;
  }
  setTransform(entityId, tra);

  return entityId;
};

export const disposeMesh = (entityId: number, world: ECSWorld) => {
  const meshComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (!meshComp) return;

  const mesh = meshComp.value as THREE.Mesh;

  mesh.removeFromParent();

  const geoId = mesh.geometry?.userData.id;
  if (geoId) decGeometryRef(geoId);

  if (Array.isArray(mesh.material)) {
    mesh.material.forEach((m) => {
      if (m.userData.id) decMaterialRef(m.userData.id);
    });
  } else if (mesh.material.userData.id) {
    decMaterialRef(mesh.material.userData.id);
  }
};
