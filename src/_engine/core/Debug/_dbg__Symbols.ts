// ./src/_engine/core/Debug/_dbg__Symbols.ts
import * as THREE from 'three/webgpu';
import { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { getRootScene } from '../Scene';
import { existsOrThrow } from '../../utils/assert';
import { getActiveCameraId } from '../_CameraManager'; // ADD THIS IMPORT
import {
  createNewCameraSymbol,
  createNewDirectionalLightSymbol,
  createNewPointLightSymbol,
  createNewSpotLightSymbol,
} from '../../debug/3DSymbols';

const attachToEntity = (id: number, w: ECSWorld, scene: THREE.Scene) => {
  if (w.hasComponent(id, ComponentType.DEBUG_SYMBOL)) return;

  const appId = w.getComponent(id, ComponentType.APP_ID)?.id;
  const isDebugCam =
    w.hasComponent(id, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA) || appId === '_debugCamera';

  let symbol: THREE.Group | THREE.Mesh | null = null;

  const objComp = w.getComponent(id, ComponentType.OBJECT3D);
  if (!objComp) return;

  const obj = objComp.value;
  if (obj.type === 'PointLight') symbol = createNewPointLightSymbol();
  else if (obj.type === 'DirectionalLight') symbol = createNewDirectionalLightSymbol();
  else if (obj.type === 'SpotLight') symbol = createNewSpotLightSymbol();
  else if (w.hasComponent(id, ComponentType.TAG_IS_CAMERA) && !isDebugCam) {
    symbol = createNewCameraSymbol();
  }

  if (symbol) {
    if (obj instanceof THREE.Light || obj instanceof THREE.Camera) {
      symbol.matrix = obj.matrixWorld; // SHARED REFERENCE — this is the whole trick
      symbol.matrixAutoUpdate = false; // never recompute matrix from pos/quat/scale
      // matrixWorldAutoUpdate stays true (default) — scene traversal will compute matrixWorld
    }
    scene.add(symbol);
    w.addComponent(id, ComponentType.DEBUG_SYMBOL, { value: symbol, userVisible: true });
  }
};

export const autoAttachSymbols = (world: ECSWorld) => {
  const scene = getRootScene();
  if (!scene) return;

  // Scan all existing lights and cameras
  for (const id of world.getEntitiesWith(ComponentType.TAG_IS_LIGHT))
    attachToEntity(id, world, scene);
  for (const id of world.getEntitiesWith(ComponentType.TAG_IS_CAMERA))
    attachToEntity(id, world, scene);
};

const _m1 = new THREE.Matrix4();
const _zero = new THREE.Vector3(0, 0, 0);
const _localTargetDir = new THREE.Vector3();
const _invQ = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

ECSWorld.registerPlugin((world) => {
  const rootScene = existsOrThrow(getRootScene(), 'No root scene for symbols');

  world.addSystem(ECSSystemStage.LATE_MAIN, 'debugSymbolSyncSystem', (w) => {
    const storage = w.getStorage(ComponentType.DEBUG_SYMBOL);
    const activeCamId = getActiveCameraId();

    for (const [entityId, symbolComp] of storage) {
      const objComp = w.getComponent(entityId, ComponentType.OBJECT3D);
      const symbol = symbolComp.value;
      if (!objComp || !symbol) continue;
      const parent = objComp.value;

      // Visibility (only thing we set on the root)
      const isCurrentActiveCam = entityId === activeCamId;
      const isEnabled = parent.visible && !w.isDisabled(entityId);
      symbol.visible = isEnabled && !isCurrentActiveCam && symbolComp.userVisible;

      // Find the lookAt holder (first child)
      const inner = symbol.children.find((c) => c.userData.isLookAtHolder);
      if (!inner) continue;

      const targetLink = w.getComponent(entityId, ComponentType.TARGET_LINK);
      if (targetLink) {
        // Read the target's *Object3D* position (tweakpane writes to .position, not Transform)
        const tObj = w.getComponent(targetLink.targetId, ComponentType.OBJECT3D);
        if (tObj) {
          // Direction from light to target, in world space
          _localTargetDir.copy(tObj.value.position).sub(parent.position);
          // Rotate into the light's local frame, since `inner.matrix` is computed
          // relative to `symbol.matrix === light.matrixWorld`
          _invQ.copy(parent.quaternion).invert();
          _localTargetDir.applyQuaternion(_invQ);
          // Build a rotation whose +Z faces that direction (non-camera lookAt convention)
          _m1.lookAt(_localTargetDir, _zero, _up);
          inner.quaternion.setFromRotationMatrix(_m1);
        }
      } else {
        inner.quaternion.identity(); // point lights / cameras
      }
    }
  });

  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_LIGHT, {
    onAddComponent: (id, w) => attachToEntity(id, w, rootScene),
  });
  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_CAMERA, {
    onAddComponent: (id, w) => attachToEntity(id, w, rootScene),
  });
});

ECSWorld.registerComponentHooks(ComponentType.DEBUG_SYMBOL, {
  onDeleteEntity: (id, w) => {
    const symbolComp = w.getComponent(id, ComponentType.DEBUG_SYMBOL);
    if (symbolComp) {
      symbolComp.value.removeFromParent();
    }
  },
});
