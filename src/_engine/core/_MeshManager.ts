import * as THREE from 'three/webgpu';
import { createGeometry, incGeometryRef, decGeometryRef, GeoProps } from './_Geometry';
import { createMaterial, incMaterialRef, decMaterialRef, MatProps } from './Material';
import { CoreEntityOpts, ECSWorld, getECSWorld } from './ECS';
import { getRootScene } from './Scene';
import { existsOrThrow } from '../utils/helpers';
import { getRenderer } from './Renderer';
import { getCurrentCamera } from './Camera';
import { ComponentType, OBJECT3D_TAGS } from './ECS/ECSCoreEntities';
import { ECSSystemStage } from '../../AppECSRegistry';

// Register the meshSyncSystem
ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.APP_RENDER_SYNC, 'meshSyncSystem', meshSyncSystem);
});

// Register onDeleteEntity hook for TAG_IS_MESH
ECSWorld.registerComponentHooks(ComponentType.TAG_IS_MESH, {
  onDeleteEntity: (entityId, world) => disposeMesh(entityId, world),
});

// Register onAddComponent hook for OBJECT3D
// @CHORE: Move this to ECSCoreSystems and refactor the word mesh to obj3D
ECSWorld.registerComponentHooks(ComponentType.OBJECT3D, {
  onAddComponent: (entityId, world) => {
    const meshComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!meshComp) return;
    const obj = meshComp.value;
    if (obj) {
      for (const detector of OBJECT3D_TAGS) {
        if (detector.prop in obj) {
          world.addComponent(entityId, detector.tag, true);
        }
      }
      if (obj.userData.isPhysicsObject) {
        world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);
      }
    }
  },
});

export type MeshProps = {
  geo: THREE.BufferGeometry | GeoProps;
  mat: THREE.Material | MatProps;
  castShadow?: boolean;
  receiveShadow?: boolean;
  preWarm?: boolean;
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
  mesh.castShadow = props.castShadow ?? false;
  mesh.receiveShadow = props.receiveShadow ?? false;

  if (geo.userData.id) incGeometryRef(geo.userData.id);
  if (mat.userData.id) incMaterialRef(mat.userData.id);

  const rootScene = existsOrThrow(getRootScene(), 'Could not find root scene in createMeshEntity.');

  if (props.preWarm) {
    // @IMPROVEMENT: Create a queue system for these and preWarm large batches
    // with throttled amounts (like 3-5 preWarms per frame). Otherwise the
    // framerate could drop and/or jank could appear.
    const renderer = getRenderer();
    const camera = getCurrentCamera();

    if (renderer && camera && rootScene) {
      // This is done without await in the background
      renderer.compileAsync(mesh, camera, rootScene);
    }
  }

  const entityId = world.createEntity(entityOpts);

  world.addComponent(entityId, ComponentType.OBJECT3D, {
    value: mesh,
    _lastVersion: -1,
  });

  rootScene.add(mesh);

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

export const meshSyncSystem = (world: ECSWorld) => {
  const meshStorage = world.getStorage(ComponentType.OBJECT3D);

  for (const [entityId, meshComp] of meshStorage) {
    if (world.isDisabled(entityId)) continue;

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) continue;

    // Only update Three.js if the ECS Transform has changed
    if (meshComp._lastVersion !== transform.version) {
      meshComp.value.position.copy(transform.position);
      meshComp.value.quaternion.copy(transform.quaternion);
      meshComp.value.scale.copy(transform.scale);

      meshComp._lastVersion = transform.version;
    }
  }
};
