import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../core/ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { XYZObject } from '../commontTypes';
import { smoothDampVec3 } from '../helpers';

const DEFAULT_OFFSET = { x: 0, y: 5, z: 10 };
const DEFAULT_LERP_SMOOTH_TIME = 0.1;
const DEFAULT_DAMP_SMOOTH_TIME = 0.2;

type FollowObjectCameraParams = {
  id: string;
  camera: THREE.Camera;
  targetMesh: THREE.Mesh;
  /** What is the offset of the camera from the target */
  offset?: XYZObject;
  /** Smoothing function type (default is 'SMOOTH_DAMP') */
  smoothingType?: 'SMOOTH_DAMP' | 'LERP';
  /** Smoothing time used for SMOOTH_DAMP or LERP */
  smoothingTime?: number;
  /** The target height of the camera to point at (for example character head) */
  targetHeight?: number;
  /** Function to run after the camera.lookAt (at the very end) */
  afterLookAtFn?: (params: {
    id: string;
    targetPos: THREE.Vector3;
    camera: THREE.Camera;
    targetMesh: THREE.Mesh;
    offset: THREE.Vector3;
    smoothingType: 'SMOOTH_DAMP' | 'LERP';
    smoothingTime: number;
    spherical: THREE.Spherical;
  }) => void;
  getMouseMoveInput?: () => { x: number; y: number };
};

type FollowRigState = {
  tick: (dt: number) => void;
};

// --- Shared ECS system (design decision: camera-follow smoothing is one system, registered
// once, not one addScenePhysicsLooper registration per rig instance) --------------------------
const activeRigs = new Map<string, FollowRigState>();

const followObjectCameraRigSystemFn = (_world: ECSWorld, dt: number) => {
  for (const rig of activeRigs.values()) rig.tick(dt);
};

/** Registers the single shared camera-follow system on `world`, driving every active
 * createFollowObjectCameraRig() instance's smoothing at APP_LOGIC — after physics has synced
 * into ECS transforms and Three.js Object3D positions (APP_POST_PHYSICS / APP_RENDER_SYNC, both
 * earlier in the same frame), matching design decision 3's "APP_POST_PHYSICS-or-later" and the
 * original addScenePhysicsLooper afterStepLooper's own "run after physics to avoid jitter"
 * intent. Call this once per world before creating any camera rigs on it — mirrors
 * toolkit/ecs/effects/FollowTool.ts's registerFollowToolEffect(world) convention. */
export const registerFollowObjectCameraRigSystem = (world: ECSWorld) => {
  world.addSystem(
    ECSSystemStage.APP_LOGIC,
    'followObjectCameraRigSystem',
    followObjectCameraRigSystemFn
  );
  return world;
};

export const createFollowObjectCameraRig = (params: FollowObjectCameraParams) => {
  const {
    id,
    camera,
    targetMesh,
    offset: offsetParam,
    smoothingType,
    smoothingTime,
    targetHeight,
    afterLookAtFn,
    getMouseMoveInput,
  } = params;

  const targetPos = new THREE.Vector3();
  const idealPos = new THREE.Vector3();
  const velocity = new THREE.Vector3(0, 0, 0); // For dampening (if using smoothDamp)
  const targetHeightVector = new THREE.Vector3(0, targetHeight, 0);

  const offsetObj = offsetParam || DEFAULT_OFFSET;
  const offset = new THREE.Vector3(offsetObj.x, offsetObj.y, offsetObj.z);
  const smoothType = smoothingType || 'SMOOTH_DAMP';
  const smoothTime =
    smoothingTime !== undefined
      ? smoothingTime
      : smoothType === 'LERP'
        ? DEFAULT_LERP_SMOOTH_TIME
        : DEFAULT_DAMP_SMOOTH_TIME;
  const dist = new THREE.Vector3(0, 0, 0).distanceTo(offset);

  // Spherical coordinate system for orbiting
  // Phi: Vertical angle (0 = top, PI = bottom). Start at roughly 45-60 deg.
  // Theta: Horizontal angle.
  const spherical = new THREE.Spherical(dist, Math.PI / 3, 0);

  // Limits for looking up/down (Don't clip through floor or flip over)
  const minPolarAngle = 0.1; // Look almost straight up
  const maxPolarAngle = Math.PI / 2 - 0.1; // Don't go below ground level

  const sensitivity = 0.002; // Mouse sensitivity

  const afterLookParams = {
    id,
    targetPos,
    idealPos,
    camera,
    targetMesh,
    offset,
    smoothingType: smoothType,
    smoothingTime: smoothTime,
    spherical,
  };

  const tick =
    smoothType === 'LERP'
      ? (dt: number) => {
          // Safety check for NaN DT (on first frame or pause)
          if (dt <= 0.0001) return;

          if (getMouseMoveInput) {
            // Handle possible mouse move input
            // -------------------

            const mouseDelta = getMouseMoveInput();

            // Horizontal (Theta) - Rotate around Y
            // Subtract to rotate "intuitively" (drag background) or add for inverted
            spherical.theta -= mouseDelta.x * sensitivity;

            // Vertical (Phi) - Rotate up/down
            spherical.phi -= mouseDelta.y * sensitivity;

            // Clamp Vertical angle
            spherical.phi = Math.max(minPolarAngle, Math.min(maxPolarAngle, spherical.phi));

            // Calculate Offset Vector from Spherical Coords
            // This converts the Angles back into a Vector3 offset (x, y, z)
            const offsetVector = new THREE.Vector3().setFromSpherical(spherical);

            // Get Look Target (e.g., Player Head position)
            targetPos.copy(targetMesh.position).add(targetHeightVector);

            // Calculate Ideal Camera Position
            idealPos.copy(targetPos).add(offsetVector);
          } else {
            // No mouse move input
            // -------------------

            // Get Target Position (Mesh or RigidBody)
            // Using mesh is usually safer for visual smoothness if you interpolate visuals
            targetPos.copy(targetMesh.position);

            // Calculate Ideal Camera Position
            idealPos.copy(targetPos).add(offset);
          }

          // Smoothly move camera there (Lerp)
          // 0.1 is the smoothing factor (adjust for feel)
          camera.position.lerp(idealPos, smoothTime);

          // Look at the target
          camera.lookAt(targetPos);

          // After lookAt fn
          if (afterLookAtFn) {
            afterLookParams.targetPos = targetPos;
            afterLookAtFn(afterLookParams);
          }
        }
      : (dt: number) => {
          // Safety check for NaN DT (on first frame or pause)
          if (dt <= 0.0001) return;

          if (getMouseMoveInput) {
            // Handle possible mouse move input
            // -------------------

            const mouseDelta = getMouseMoveInput();

            // Horizontal (Theta) - Rotate around Y
            // Subtract to rotate "intuitively" (drag background) or add for inverted
            spherical.theta -= mouseDelta.x * sensitivity;

            // Vertical (Phi) - Rotate up/down
            spherical.phi -= mouseDelta.y * sensitivity;

            // Clamp Vertical angle
            spherical.phi = Math.max(minPolarAngle, Math.min(maxPolarAngle, spherical.phi));

            // Calculate Offset Vector from Spherical Coords
            // This converts the Angles back into a Vector3 offset (x, y, z)
            const offsetVector = new THREE.Vector3().setFromSpherical(spherical);

            // Get Look Target (e.g., Player Head position)
            targetPos.copy(targetMesh.position).add(targetHeightVector);

            // Calculate Ideal Camera Position
            idealPos.copy(targetPos).add(offsetVector);

            // Smooth Damp
            smoothDampVec3(
              camera.position,
              idealPos,
              velocity,
              smoothTime, // Faster smooth time for mouse look feels snappier
              Infinity,
              dt
            );
          } else {
            // No mouse move input
            // -------------------

            // Get Target Position (Mesh or RigidBody)
            // Using mesh is usually safer for visual smoothness if you interpolate visuals
            targetPos.copy(targetMesh.position);

            // Calculate Ideal Camera Position
            idealPos.copy(targetPos).add(offset);

            // Smoothly move Camera -> Ideal
            // This modifies camera.position AND velocity in place.
            smoothDampVec3(
              camera.position, // Current
              idealPos, // Target
              velocity, // Velocity State (Stores momentum)
              smoothTime, // Smooth time
              100, // Max Speed (Optional cap)
              dt // Time since last frame
            );
          }

          // Look at the target
          camera.lookAt(targetPos);

          // After lookAt fn
          if (afterLookAtFn) {
            afterLookParams.targetPos = targetPos;
            afterLookAtFn(afterLookParams);
          }
        };

  activeRigs.set(id, { tick });
};

export const deleteFollowObjectCameraRig = (id: string) => {
  activeRigs.delete(id);
};
