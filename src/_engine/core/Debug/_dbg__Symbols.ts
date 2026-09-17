// ./src/_engine/core/Debug/_dbg__Symbols.ts
import * as THREE from 'three/webgpu';
import { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { getRootScene } from '../Scene';
import { existsOrThrow } from '../../utils/assert';
import { getActiveCameraId } from '../CameraManager'; // ADD THIS IMPORT
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
    if (symbol) {
      const indicator = symbol.getObjectByName('mainCameraIndicator');
      if (indicator) symbol.userData.mainCameraIndicator = indicator;
    }
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

type SymbolTintState = 'normal' | 'culled' | 'disabled';

/**
 * Tints a light symbol instead of hiding it, so a light's gizmo stays visible and
 * inspectable while flying around with the debug camera (docs/plans/light-culling.md §10).
 * Disabled (red, full opacity) wins over culled (orange, half opacity) when both are true.
 */
const applySymbolTint = (symbol: THREE.Object3D, state: SymbolTintState) => {
  if (symbol.userData.tintState === state) return; // skip redundant writes — runs every frame
  symbol.userData.tintState = state;

  const outlineColor = state === 'culled' ? 0xff9900 : state === 'disabled' ? 0xff3333 : 0x333333;
  const opacity = state === 'culled' ? 0.5 : 1.0;

  symbol.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshBasicMaterial;
    if (child.userData.isOutline) mat.color.setHex(outlineColor);
    mat.opacity = opacity; // applies to icon and outline alike
  });
};

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
      const isLight = w.hasComponent(entityId, ComponentType.TAG_IS_LIGHT);

      if (isLight) {
        // Light symbols stay visible and are tinted instead of hidden, so every light
        // can still be found while flying around with the debug camera (§10).
        symbol.visible = symbolComp.userVisible;
        const state: SymbolTintState = w.isDisabled(entityId)
          ? 'disabled'
          : w.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)
            ? 'culled'
            : 'normal';
        applySymbolTint(symbol, state);
      } else {
        // Cameras: unchanged — still hidden when disabled or when it's the active camera.
        const isEnabled = parent.visible && !w.isDisabled(entityId);
        symbol.visible = isEnabled && !isCurrentActiveCam && symbolComp.userVisible;

        // Main-camera indicator: visible only on whichever camera currently holds TAG_IS_MAIN_CAMERA.
        const indicator = symbol.userData.mainCameraIndicator as THREE.Object3D | undefined;
        if (indicator)
          indicator.visible = w.hasComponent(entityId, ComponentType.TAG_IS_MAIN_CAMERA);
      }

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
