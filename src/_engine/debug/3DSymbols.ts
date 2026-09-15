import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { IS_DEBUG_ENV } from '../core/Config';
import { lerror } from '../utils/Logger';
import symbolsModelUrl from '../core/UI/3DSymbols/3DSymbols.glb?url';
import symbolsTextureUrl from '../core/UI/3DSymbols/3DSymbolsTextures.png?url';
import { DebugModuleRef, loadDebugModule, useDebug } from '../utils/helpers';
import { getECSWorld } from '../core/ECS';

const symbols: {
  camera?: THREE.Group;
  point?: THREE.Group;
  spot?: THREE.Group;
  directional?: THREE.Group;
} = {};

type SymbolsModule = DebugModuleRef<typeof import('../core/Debug/_dbg__Symbols')> | null;

export const load3DSymbols = async () => {
  if (!IS_DEBUG_ENV) return;

  const symbolsModule: SymbolsModule = loadDebugModule(() => import('../core/Debug/_dbg__Symbols'));

  const modelLoader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();

  try {
    const symbolsTexture = await textureLoader.loadAsync(symbolsTextureUrl);
    symbolsTexture.colorSpace = THREE.SRGBColorSpace;
    symbolsTexture.flipY = false;

    const symbolMaterial = new THREE.MeshBasicMaterial({
      map: symbolsTexture,
      // alphaTest: 0.5,
    });

    const outlineMaterial = new THREE.MeshBasicMaterial({
      color: 0x333333,
      side: THREE.BackSide,
    });

    const gltf = await modelLoader.loadAsync(symbolsModelUrl);

    // Create a helper to process a mesh into a double-mesh group
    const processMeshIntoGroup = (mesh: THREE.Mesh, key: string): THREE.Group => {
      const root = new THREE.Group();
      root.name = `SymbolRoot_${key}`;

      const inner = new THREE.Group();
      inner.name = `SymbolInner_${key}`;
      inner.userData.isLookAtHolder = true;
      root.add(inner);

      const icon = mesh.clone();
      icon.material = symbolMaterial;
      icon.position.set(0, 0, 0);
      icon.userData.isIcon = true;
      inner.add(icon);

      const outline = mesh.clone();
      outline.position.set(0, 0, 0);
      outline.material = outlineMaterial;
      outline.userData.isOutline = true;
      inner.add(outline);

      if (key === 'camera') {
        outline.position.set(0.01, -0.02, -0.07);
        outline.scale.set(1.1, 1.05, 1.1);
        root.userData.isCameraSymbol = true;

        // Main-camera indicator: a sphere through the icon's thinnest local axis, sized
        // and placed near the base of the icon so it clearly pokes out on both sides
        // from any viewing angle without swallowing the whole icon. Computed from the
        // icon's actual geometry so it stays correct if the GLB is ever re-exported
        // with different proportions.
        icon.updateMatrix();
        if (!icon.geometry.boundingBox) icon.geometry.computeBoundingBox();
        const box = icon.geometry.boundingBox!.clone().applyMatrix4(icon.matrix);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.min(size.x, size.y, size.z) * 0.8;

        const indicator = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0x009900 })
        );
        indicator.name = 'mainCameraIndicator';
        // Position so the sphere's *bottom edge* sits just above the icon's base
        // (not its center) — a small gap so it doesn't touch/clip past the base.
        indicator.position.set(center.x, box.min.y + radius - size.y * 0.025, center.z * 0.88);
        indicator.visible = false; // toggled per-instance in debugSymbolSyncSystem
        inner.add(indicator); // same parent as icon/outline — sphere is rotation-invariant, no lookAt needed
      } else if (key === 'point') {
        outline.position.set(0, 0.01, 0);
        outline.scale.set(1.19, 1.12, 1.19);
        root.userData.isPointLightSymbol = true;
      } else if (key === 'directional' || key === 'spot') {
        outline.scale.set(1.1, 1.1, 1.1);
        if (key === 'directional') root.userData.isDirectionLightSymbol = true;
        if (key === 'spot') root.userData.isSpotLightSymbol = true;
      }

      return root;
    };

    gltf.scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData.isCamera) {
        symbols.camera = processMeshIntoGroup(child, 'camera');
      } else if (child.userData.isPointLight) {
        symbols.point = processMeshIntoGroup(child, 'point');
      } else if (child.userData.isSpotLight) {
        symbols.spot = processMeshIntoGroup(child, 'spot');
      } else if (child.userData.isDirectionalLight) {
        symbols.directional = processMeshIntoGroup(child, 'directional');
      }
    });

    // This is just to auto attach the symbols in case there were some without them.
    useDebug(symbolsModule)?.autoAttachSymbols(getECSWorld());
  } catch (err) {
    lerror('Failed to load engine 3D Symbol Icons GLB', err);
  }
};

// Generic internal helper for cloning symbols
const createSymbolClone = (template?: THREE.Group): THREE.Group | null => {
  if (!template) return null;
  const clone = template.clone();
  clone.userData.isHelperSymbol = true;

  // Per-instance materials so tinting one light's gizmo (docs/plans/light-culling.md §10)
  // never affects any other — Object3D.clone() copies material references, not values,
  // so without this every symbol would share the same two template materials.
  // `transparent = true` is required for the culled-state opacity fade to have any effect.
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = (child.material as THREE.Material).clone();
    mat.transparent = true;
    child.material = mat;
  });

  return clone;
};

export const createNewCameraSymbol = () => createSymbolClone(symbols.camera);
export const createNewPointLightSymbol = () => createSymbolClone(symbols.point);
export const createNewSpotLightSymbol = () => createSymbolClone(symbols.spot);
export const createNewDirectionalLightSymbol = () => createSymbolClone(symbols.directional);
