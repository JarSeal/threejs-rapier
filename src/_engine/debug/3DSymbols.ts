import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { IS_DEBUG_ENV } from '../core/Config';
import { lerror } from '../utils/Logger';
import symbolsModelUrl from '../core/UI/3DSymbols/3DSymbols.glb?url';
import symbolsTextureUrl from '../core/UI/3DSymbols/3DSymbolsTextures.jpg?url';

const symbols: {
  camera?: THREE.Mesh;
  point?: THREE.Mesh;
  spot?: THREE.Mesh;
  directional?: THREE.Mesh;
} = {};

export const load3DSymbols = async () => {
  if (!IS_DEBUG_ENV) return;

  const modelLoader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();

  try {
    const symbolsTexture = await textureLoader.loadAsync(symbolsTextureUrl);
    symbolsTexture.colorSpace = THREE.SRGBColorSpace;
    symbolsTexture.flipY = false;

    // Symbol material
    const symbolMaterial = new THREE.MeshBasicMaterial({
      map: symbolsTexture,
      color: 0xffffff,
      toneMapped: false,
      transparent: true,
      alphaTest: 0.5,
    });
    // Black outline material
    const outlineMaterial = new THREE.MeshBasicMaterial({
      color: 0x333333,
      side: THREE.BackSide,
      toneMapped: false,
    });

    const gltf = await modelLoader.loadAsync(symbolsModelUrl);

    const setup = (key: keyof typeof symbols) => {
      const mesh = symbols[key];
      if (!mesh) return;
      mesh.position.set(0, 0, 0);
      mesh.material = symbolMaterial;

      const outline = mesh.clone();
      outline.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
      outline.quaternion.set(
        mesh.quaternion.x,
        mesh.quaternion.y,
        mesh.quaternion.z,
        mesh.quaternion.w
      );
      outline.material = outlineMaterial;
      mesh.add(outline);

      if (key === 'camera') {
        outline.rotateZ(-Math.PI / 2);
        outline.position.set(-0.01, 0, -0.08);
        outline.scale.set(1.1, 1.05, 1.1);
      } else if (key === 'point') {
        outline.scale.set(1.19, 1.12, 1.19);
      } else if (key === 'directional') {
        outline.rotateX(Math.PI / 2);
        outline.scale.set(1.1, 1.1, 1.1);
      } else if (key === 'spot') {
        outline.rotateX(Math.PI / 2);
        outline.scale.set(1.1, 1.1, 1.1);
      }
    };

    gltf.scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      if (child.userData.isCamera) {
        symbols.camera = child;
      } else if (child.userData.isPointLight && !symbols.point) {
        symbols.point = child;
      } else if (child.userData.isSpotLight) {
        symbols.spot = child;
      } else if (child.userData.isDirectionalLight) {
        symbols.directional = child;
      }
    });

    const keys = Object.keys(symbols) as (keyof typeof symbols)[];
    for (let i = 0; i < keys.length; i++) {
      setup(keys[i]);
    }
  } catch (err) {
    lerror('Failed to load engine 3D Symbol Icons GLB', err);
  }
};

// Generic internal helper for cloning symbols
const createSymbolClone = (template?: THREE.Mesh): THREE.Mesh | null => {
  if (!template) return null;
  const clone = template.clone();
  clone.userData.isHelperSymbol = true;
  return clone;
};

export const createNewCameraSymbol = () => createSymbolClone(symbols.camera);
export const createNewPointLightSymbol = () => createSymbolClone(symbols.point);
export const createNewSpotLightSymbol = () => createSymbolClone(symbols.spot);
export const createNewDirectionalLightSymbol = () => createSymbolClone(symbols.directional);
