import * as THREE from 'three/webgpu';
import type { Materials } from '../core/Material';
import { lerror } from './Logger';
import { IS_DEBUG_ENV } from '../core/Config';
import { textureMapKeys } from './constants';

/**
 * Returns the file name extension from a string
 * @param fileName (string) optional file name, if not provided then this will return null
 * @returns (string | null)
 */
export const getFileNameExt = (fileName?: unknown) => {
  if (typeof fileName !== 'string') return null;
  const splitFileName = (fileName || '').split('.');
  return splitFileName[splitFileName.length - 1];
};

/**
 * Determines whether the file name provided has an 'hdr' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isHDR = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'hdr';

/**
 * Determines whether the file name provided has an 'jpg' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isJPG = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'jpg';

/**
 * Determines whether the file name provided has an 'png' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isPNG = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'png';

type RemovalTypes =
  | THREE.Mesh
  | THREE.PerspectiveCamera
  | THREE.OrthographicCamera
  | THREE.CameraHelper
  | THREE.AmbientLight
  | THREE.HemisphereLight
  | THREE.DirectionalLight
  | THREE.DirectionalLightHelper
  | THREE.PointLight
  | THREE.PointLightHelper
  | THREE.SpotLight
  | THREE.SpotLightHelper;

/**
 * Removes a texture from memory
 * @param texture (THREE.Texture) Texture to remove
 */
export const removeTextureFromMemory = (texture: THREE.Texture) => {
  if ('dispose' in texture) texture.dispose();
};

/**
 * Removes a material or materials from memory
 * @param material (THREE.Material | THREE.Material[]) Material or materials to remove
 */
export const removeMaterialFromMemory = (material: Materials | Materials[]) => {
  if (Array.isArray(material)) {
    // Multiple materials
    for (let i = 0; i < material.length; i++) {
      const mat = material[i];
      for (let k = 0; k < textureMapKeys.length; k++) {
        const key = textureMapKeys[k] as keyof Materials;
        if (key in mat && mat[key]) {
          removeTextureFromMemory(mat[key] as THREE.Texture);
        }
      }
    }
    return;
  }
  // Single material
  for (let k = 0; k < textureMapKeys.length; k++) {
    const key = textureMapKeys[k] as keyof Materials;
    if (key in material && material[key]) {
      removeTextureFromMemory(material[key] as THREE.Texture);
    }
  }
};

/**
 * Removes a geometry from memory
 * @param geometry (THREE.BufferGeometry) Geometry to remove
 */
export const removeGeometryFromMemory = (geometry: THREE.BufferGeometry) => {
  if ('dispose' in geometry) geometry.dispose();
};

/**
 * Removes an object from memory and from the scene if present
 * @param obj ({@link RemovalTypes}) object to remove
 */
export const removeObjectFromMemory = (obj: RemovalTypes) => {
  obj.removeFromParent();

  if ('isMesh' in obj && obj.isMesh) {
    const mat = obj.material;
    if (mat) removeMaterialFromMemory(mat);
    const geo = obj.geometry;
    if (geo) removeGeometryFromMemory(geo);
  } else if ('dispose' in obj) {
    obj.dispose();
  }
};

/**
 * Removes the children of an object from memory and from the scene if present
 * @param obj ({@link RemovalTypes}) object with children to remove
 */
export const removeObjectChildrenFromMemory = (obj: RemovalTypes) => {
  const children = obj.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as RemovalTypes;
    removeObjectChildrenFromMemory(child);
    removeObjectFromMemory(child);
  }
};

/**
 * Removes the object and its children from memory and from the scene if present
 * @param obj ({@link RemovalTypes}) object to remove
 */
export const removeObjectAndChildrenFromMemory = (obj: RemovalTypes) => {
  removeObjectChildrenFromMemory(obj);
  removeObjectFromMemory(obj);
};

export const ThreeVector3 = new THREE.Vector3();
export const ThreeQuoternion = new THREE.Quaternion();
export const ThreeEuler = new THREE.Euler();

export const getQuatFromAngle = (deg: number) => {
  ThreeQuoternion.setFromAxisAngle(ThreeVector3.set(0, 1, 0), THREE.MathUtils.degToRad(deg));
  return { x: ThreeQuoternion.x, y: ThreeQuoternion.y, z: ThreeQuoternion.z, w: ThreeQuoternion.w };
};

// @TODO: rename this (slerp to slerpQuat)
export const slerp = (a: THREE.Quaternion, b: THREE.Quaternion, t: number) => a.clone().slerp(b, t);

/** Rounds the value to a specific scalingFactor such as 10, 100, or 1000,
 * where 10 would be 1 decimal, 100 would be 2 decimals etc. */
export const roundToDecimal = (value: number, scalingFactor: number) =>
  Math.round(value * scalingFactor) / scalingFactor;

/**
 * Smoothly dampens a vector towards a target.
 * @param current Current position (Modified in place!)
 * @param target Target position
 * @param currentVelocity Current velocity (Modified in place! Must persist across frames)
 * @param smoothTime Approximately the time it takes to reach the target
 * @param maxSpeed Maximum speed
 * @param deltaTime Time since last frame
 */
export const smoothDampVec3 = (
  current: THREE.Vector3,
  target: THREE.Vector3,
  currentVelocity: THREE.Vector3,
  smoothTime: number,
  maxSpeed: number = Infinity,
  deltaTime: number
) => {
  // 1. Friction / Smoothness constant
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;

  const x = omega * deltaTime;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  // 2. Calculate difference
  let changeX = current.x - target.x;
  let changeY = current.y - target.y;
  let changeZ = current.z - target.z;

  const originalTo = target.clone();

  // 3. Clamp maximum speed
  const maxChange = maxSpeed * smoothTime;
  const maxChangeSq = maxChange * maxChange;
  const distSq = changeX * changeX + changeY * changeY + changeZ * changeZ;

  if (distSq > maxChangeSq) {
    const mag = Math.sqrt(distSq);
    changeX = (changeX / mag) * maxChange;
    changeY = (changeY / mag) * maxChange;
    changeZ = (changeZ / mag) * maxChange;
  }

  target.x = current.x - changeX;
  target.y = current.y - changeY;
  target.z = current.z - changeZ;

  // 4. Calculate new velocity
  const tempX = (currentVelocity.x + omega * changeX) * deltaTime;
  const tempY = (currentVelocity.y + omega * changeY) * deltaTime;
  const tempZ = (currentVelocity.z + omega * changeZ) * deltaTime;

  currentVelocity.x = (currentVelocity.x - omega * tempX) * exp;
  currentVelocity.y = (currentVelocity.y - omega * tempY) * exp;
  currentVelocity.z = (currentVelocity.z - omega * tempZ) * exp;

  // 5. Calculate new position
  let outputX = target.x + (changeX + tempX) * exp;
  let outputY = target.y + (changeY + tempY) * exp;
  let outputZ = target.z + (changeZ + tempZ) * exp;

  // 6. Prevent overshooting
  const origMinusCurrentX = originalTo.x - current.x;
  const origMinusCurrentY = originalTo.y - current.y;
  const origMinusCurrentZ = originalTo.z - current.z;
  const outMinusOrigX = outputX - originalTo.x;
  const outMinusOrigY = outputY - originalTo.y;
  const outMinusOrigZ = outputZ - originalTo.z;

  if (
    origMinusCurrentX * outMinusOrigX +
      origMinusCurrentY * outMinusOrigY +
      origMinusCurrentZ * outMinusOrigZ >
    0
  ) {
    outputX = originalTo.x;
    outputY = originalTo.y;
    outputZ = originalTo.z;

    currentVelocity.x = (outputX - originalTo.x) / deltaTime;
    currentVelocity.y = (outputY - originalTo.y) / deltaTime;
    currentVelocity.z = (outputZ - originalTo.z) / deltaTime;
  }

  // Apply result
  current.x = outputX;
  current.y = outputY;
  current.z = outputZ;
};

export const isOnlyObject3D = (
  obj: THREE.Object3D | THREE.Mesh | THREE.Group | THREE.Light | THREE.Camera | THREE.Texture
) =>
  'isObject3D' in obj &&
  obj.isObject3D &&
  !('isMesh' in obj) &&
  !('isGroup' in obj) &&
  !('isLight' in obj) &&
  !('isCamera' in obj) &&
  !('isTexture' in obj);

export const setMeshCreatePropsToUserData = (shape: string, mesh: THREE.Mesh) => {
  if (!mesh) return;
  let scale;
  let size;
  let radius;
  let halfHeight;
  let spine;
  let sX;
  let sY;
  let sZ;
  let totalHeight;
  switch (shape) {
    case 'CUBOID':
    case 'BOX':
      mesh.geometry.computeBoundingBox();
      mesh.geometry.boundingBox?.getSize(ThreeVector3);
      ThreeVector3.multiply(mesh.scale);
      if (!mesh.geometry.userData.props) {
        mesh.geometry.userData.props = { params: {} };
      } else if (!mesh.geometry.userData.props.params) {
        mesh.geometry.userData.props.params = {};
      }
      mesh.geometry.userData.props.params.width = ThreeVector3.x;
      mesh.geometry.userData.props.params.height = ThreeVector3.y;
      mesh.geometry.userData.props.params.depth = ThreeVector3.z;
      break;
    case 'SPHERE':
    case 'BALL':
      mesh.geometry.computeBoundingSphere();
      const baseRadius = mesh.geometry.boundingSphere?.radius;
      if (!baseRadius) return;
      scale = mesh.scale;
      const maxScale = Math.max(scale.x, scale.y, scale.z);
      const finalRadius = baseRadius * maxScale;
      if (!mesh.geometry.userData.props) {
        mesh.geometry.userData.props = { params: {} };
      } else if (!mesh.geometry.userData.props.params) {
        mesh.geometry.userData.props.params = {};
      }
      mesh.geometry.userData.props.params.radius = finalRadius;
      break;
    case 'CAPSULE':
      mesh.geometry.computeBoundingBox();
      size = new THREE.Vector3();
      mesh.geometry.boundingBox!.getSize(size);
      scale = mesh.scale;
      sX = size.x * scale.x;
      sY = size.y * scale.y;
      sZ = size.z * scale.z;
      spine = (mesh.userData.spineAxis || 'y').toLowerCase();
      if (spine === 'x') {
        // Radius is the larger of the cross-section axes
        radius = Math.max(sY, sZ) / 2;
        totalHeight = sX;
      } else if (spine === 'z') {
        radius = Math.max(sX, sY) / 2;
        totalHeight = sZ;
      } else {
        // Default: Y is height
        radius = Math.max(sX, sZ) / 2;
        totalHeight = sY;
      }
      // Calculate Rapier's 'halfHeight'
      // Rapier defines halfHeight as the distance from the center to the start of the cap.
      // Formula: (Total Height - Diameter) / 2
      const cylinderSectionHeight = totalHeight - radius * 2;
      halfHeight = Math.max(0, cylinderSectionHeight / 2);
      if (!mesh.geometry.userData.props) {
        mesh.geometry.userData.props = { params: {} };
      }
      if (!mesh.geometry.userData.props.params) {
        mesh.geometry.userData.props.params = {};
      }
      mesh.geometry.userData.props.params.radius = radius;
      mesh.geometry.userData.props.params.halfHeight = halfHeight;
      mesh.geometry.userData.props.params.orientation = spine;
    case 'CONE':
      mesh.geometry.computeBoundingBox();
      size = ThreeVector3;
      mesh.geometry.boundingBox!.getSize(size);
      scale = mesh.scale;
      sX = size.x * scale.x;
      sY = size.y * scale.y;
      sZ = size.z * scale.z;
      spine = (mesh.userData.spineAxis || 'y').toLowerCase();
      if (spine === 'x') {
        radius = Math.max(sY, sZ) / 2;
        totalHeight = sX;
      } else if (spine === 'z') {
        radius = Math.max(sX, sY) / 2;
        totalHeight = sZ;
      } else {
        // Default: Y is height (upright)
        radius = Math.max(sX, sZ) / 2;
        totalHeight = sY;
      }
      if (!mesh.geometry.userData.props) {
        mesh.geometry.userData.props = { params: {} };
      } else if (!mesh.geometry.userData.props.params) {
        mesh.geometry.userData.props.params = {};
      }
      mesh.geometry.userData.props.params.radius = radius;
      mesh.geometry.userData.props.params.halfHeight = totalHeight / 2;
      mesh.geometry.userData.props.params.orientation = spine;
    case 'CYLINDER':
      mesh.geometry.computeBoundingBox();
      size = ThreeVector3; // Or use your 'ThreeVector3' scratch vector
      mesh.geometry.boundingBox!.getSize(size);
      scale = mesh.scale;
      spine = (mesh.userData.spineAxis || 'y').toLowerCase();
      if (spine === 'x') {
        radius = Math.max(size.y * scale.y, size.z * scale.z) / 2;
        halfHeight = (size.x * scale.x) / 2;
      } else if (spine === 'z') {
        radius = Math.max(size.x * scale.x, size.y * scale.y) / 2;
        halfHeight = (size.z * scale.z) / 2;
      } else {
        // Default: Y is the spine (upright)
        radius = Math.max(size.x * scale.x, size.z * scale.z) / 2;
        halfHeight = (size.y * scale.y) / 2;
      }
      if (!mesh.geometry.userData.props) {
        mesh.geometry.userData.props = { params: {} };
      }
      if (!mesh.geometry.userData.props.params) {
        mesh.geometry.userData.props.params = {};
      }
      mesh.geometry.userData.props.params.radius = radius;
      mesh.geometry.userData.props.params.halfHeight = halfHeight;
      mesh.geometry.userData.props.params.orientation = spine;
      break;
  }
};

/**
 * Initializes and returns a new worker with a validated handshake. The handshake
 * is expecting a top-level message from the worker on script initialization:
 *
 * `self.postMessage({ status: 'INIT_READY' });` or `self.postMessage('INIT_READY');`
 *
 * The default status message is 'INIT_READY', but it can be overwritten with
 * `statusReadyString` in the initWorker call. Make sure the worker top-level message
 * then matches the `statusReadyString`.
 */
export const initWorker = async <T>(
  WorkerClass: new (options?: { name?: string }) => Worker,
  name: string,
  onMessage: (event: MessageEvent<T>) => void,
  onError: (err: ErrorEvent) => void,
  statusReadyString: string = 'INIT_READY'
): Promise<Worker> => {
  const worker = new WorkerClass({ name });
  return new Promise((resolve, reject) => {
    // Setup temporary error handler for boot-up failures
    worker.onerror = (err) => {
      reject(new Error(`[${name}] Setup Error: ${err.message}`));
    };
    // Setup temporary message handler for the handshake
    worker.onmessage = (event: MessageEvent<string | { status: string }>) => {
      // Check for both object-style and string-style messages for flexibility
      const status = typeof event.data === 'string' ? event.data : event.data.status;
      if (status === statusReadyString) {
        // Setup long-term message and error handlers
        worker.onmessage = onMessage;
        worker.onerror = onError;
        resolve(worker);
      }
    };
  });
};

/**
 * Checks whether the current function is running in the main thread or in a worker.
 * There is also a faster (simpler) version for this check: {@link isMainThreadSimple}().
 * @returns boolean
 */
export const isMainThread = () =>
  typeof window === 'object' && typeof document === 'object' && window.document === document;

/**
 * Checks whether the current function is running in the main thread or in a worker.
 * This is the faster (simpler version for this check). There is also a more
 * comprehensive version for this check: {@link isMainThread}().
 * @returns boolean
 */
export const isMainThreadSimple = () => typeof window !== 'undefined';

/** * A container for a module that will be loaded asynchronously.
 */
export interface DebugModuleRef<T> {
  current: T | null;
}

/**
 * Loads a lazy debug module.
 * TypeScript infers the module shape 'T' directly from the importer.
 */
export function loadDebugModule<T>(
  importer: () => Promise<T>,
  debugId?: string
): DebugModuleRef<T> | null {
  if (!IS_DEBUG_ENV) return null;
  const ref: DebugModuleRef<T> = { current: null };
  importer()
    .then((module) => {
      ref.current = module;
    })
    .catch((err) => {
      const msg = `Debug module loading failed${debugId ? `: ${debugId}` : ''}.`;
      lerror(msg);
      throw new Error(`${msg} ${err.message}`);
    });
  return ref;
}

/**
 * Type Guard: Checks if we are in Debug mode AND the module is loaded.
 *
 * Usage: if (isDebugReady(debugHelpers)) {
 *   const { current } = debugHelpers;
 * }
 */
export const isDebugReady = <T>(ref: DebugModuleRef<T>): ref is { current: T } =>
  !!(IS_DEBUG_ENV && ref?.current);

/**
 * Accessor: Returns the module if debug is active and loaded, otherwise undefined.
 * Usage: useDebug(debugHelpers)?.attach(...)
 */
export const useDebug = <T>(ref: DebugModuleRef<T> | null): T | undefined =>
  IS_DEBUG_ENV && ref?.current ? ref.current : undefined;

/** Determines and returns the light types */
export const getLightCharacteristics = (light: THREE.Light) => {
  const c = {
    isAmbientLight: false,
    isHemisphereLight: false,
    isPointLight: false,
    isSpotLight: false,
    isDirectionalLight: false,
    canCastShadows: false,
    hasPosition: false,
    hasDistance: false,
    hasDecay: false,
    hasHelper: false,
    hasSymbol: false,
    hasTarget: false,
  };

  // Type
  c.isAmbientLight = light.type === 'AmbientLight';
  c.isHemisphereLight = light.type === 'HemisphereLight';
  c.isPointLight = light.type === 'PointLight';
  c.isSpotLight = light.type === 'SpotLight';
  c.isDirectionalLight = light.type === 'DirectionalLight';

  // Shadow
  if (!c.isAmbientLight && !c.isHemisphereLight) c.canCastShadows = true;

  // Position
  if (c.isPointLight || c.isSpotLight || c.isDirectionalLight) {
    c.hasPosition = true;
  }

  // Distance and decay
  if (c.isPointLight || c.isSpotLight) {
    c.hasDistance = true;
    c.hasDecay = true;
  }

  // Helper
  if (c.isPointLight || c.isSpotLight || c.isDirectionalLight) {
    c.hasHelper = true;
  }

  // Symbol
  if (c.isPointLight || c.isSpotLight || c.isDirectionalLight) {
    c.hasSymbol = true;
  }

  // Target
  if ('target' in light) c.hasTarget = true;

  return c;
};
