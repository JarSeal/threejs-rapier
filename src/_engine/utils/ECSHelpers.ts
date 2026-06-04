import * as THREE from 'three/webgpu';

import { ECSWorld, getECSWorld } from '../core/ECS';
import {
  ComponentData,
  ComponentType,
  ECSTransformProp,
  Transform,
} from '../core/ECS/ECSCoreComponents';
import { llog } from './Logger';
import { IS_DEBUG_ENV } from '../core/Config';
import { EntityDebugData } from '../core/ECS/ECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';

// Reuse scratch objects to prevent GC pressure
const _v1 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();

export const createRawEntity = (ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.createRawEntity();
};

export const createEntity = (opts?: CoreEntityOpts, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.createEntity(opts);
};

export const deleteEntity = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  world.deleteEntity(entityId);
};

export const addComponent = <K extends ComponentType>(
  entityId: number,
  type: K,
  data: ComponentData[K],
  ecsWorld?: ECSWorld
) => {
  const world = ecsWorld || getECSWorld();
  world.addComponent(entityId, type, data);
};

export const removeComponent = (entityId: number, type: ComponentType, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  world.removeComponent(entityId, type);
};

export const getComponent = <K extends ComponentType>(
  entityId: number,
  type: K,
  ecsWorld?: ECSWorld
) => {
  const world = ecsWorld || getECSWorld();
  return world.getComponent(entityId, type);
};

export const hasComponent = (entityId: number, type: ComponentType, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.hasComponent(entityId, type);
};

export const getStorage = <K extends ComponentType>(type: K, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.getStorage(type);
};

export const getTransform = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.getTransform(entityId);
};

export const setTransform = (entityId: number, tra: ECSTransformProp, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  world.setTransform(entityId, tra);
};

export const teleport = (entityId: number, tra: ECSTransformProp, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  world.teleport(entityId, tra);
};

export const getPosition = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.getPosition(entityId);
};

export const getRotation = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.getRotation(entityId);
};

export const getScale = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.getScale(entityId);
};

/**
 * Performs a one-time rotation update to make any entity face a specific point.
 * This updates the ECS Transform component, which then syncs to the visual object.
 */
export const lookAtPoint = (
  entityId: number,
  point: { x: number; y: number; z: number },
  ecsWorld?: ECSWorld
) => {
  const world = ecsWorld || getECSWorld();
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (!transform) return;

  _v1.set(point.x, point.y, point.z);
  _m1.lookAt(transform.position, _v1, THREE.Object3D.DEFAULT_UP);

  transform.quaternion.setFromRotationMatrix(_m1);
  transform.setDirty();
};

export interface EntityDiagnosticData {
  id: number;
  appId?: string;
  isDisabled: boolean;
  isPersistent: boolean;
  transform?: Transform;
  obj3D?: {
    type: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    scale: { x: number; y: number; z: number };
    obj: THREE.Object3D;
  };
  activeTags: string[];
  physics?: {
    isDynamic: boolean;
    linvel: { x: number; y: number; z: number };
  };
  targetId?: number;
  debugData?: EntityDebugData;
}

/**
 * Gathers all raw ECS and engine data for an entity into a structured object.
 * Returns null if the entity is dead/recycled.
 */
export const getEntityDiagnosticData = (id: number): EntityDiagnosticData | null => {
  const world = getECSWorld();
  if (!world.isAlive(id)) return null;

  const data: EntityDiagnosticData = {
    id,
    appId: world.getComponent(id, ComponentType.APP_ID)?.id,
    isDisabled: world.isDisabled(id),
    isPersistent: world.hasComponent(id, ComponentType.PERSISTENT),
    activeTags: [],
  };

  // Transform (ECS Source of Truth)
  const transform = world.getComponent(id, ComponentType.TRANSFORM);
  if (transform) data.transform = transform;

  // Visuals (Three.js Sync State)
  const obj3D = world.getComponent(id, ComponentType.OBJECT3D);
  if (obj3D) {
    data.obj3D = {
      type: obj3D.value.type,
      position: { ...obj3D.value.position },
      rotation: { ...obj3D.value.rotation },
      quaternion: { ...obj3D.value.quaternion },
      scale: { ...obj3D.value.scale },
      obj: obj3D.value,
    };
  }

  // Component Inventory (Iteration through registry)
  for (const key in ComponentType) {
    const type = ComponentType[key as keyof typeof ComponentType];
    if (world.hasComponent(id, type)) {
      data.activeTags.push(key);
    }
  }

  // Physics
  const rb = world.getRigidBody(id);
  if (rb) {
    data.physics = {
      isDynamic: world.isEntityDynamic(id),
      linvel: rb.linvel(),
      // @TODO: add more info when needed
    };
  }

  // Links
  const link = world.getComponent(id, ComponentType.TARGET_LINK);
  if (link) data.targetId = link.targetId;

  // Debug data
  if (IS_DEBUG_ENV) {
    const debugData = world.getComponent(id, ComponentType.DEBUG_DATA);
    if (debugData) data.debugData = debugData;
  }

  return data;
};

/**
 * Performs a deep diagnostic log of an entity's current state across ECS and visuals.
 */
export const inspectEntity = (
  id: number,
  opts?: { compact?: boolean; dataOnly?: boolean; includeAllData?: boolean }
) => {
  const data = getEntityDiagnosticData(id);

  if (opts?.dataOnly) {
    llog(data);
    return;
  }

  if (!data) {
    llog(`%c--- INSPECTING ENTITY [ID: ${id}] ---`, 'color: #ff4444; font-weight: bold;');
    llog('Status: DEAD / RECYCLED');
    return;
  }

  const title = `--- INSPECTING ENTITY [ID: ${data.id} | Name: ${data.appId || 'Unnamed'}] ---`;
  llog(`%c${title}`, 'color: #00d4ff; font-weight: bold;');
  if (!opts?.compact) {
    llog(`Disabled: ${data.isDisabled} | Persistent: ${Boolean(data.isPersistent)}`);
    llog(`Tags and components: ${data.activeTags.join(' | ')}`);
    if (data.transform) {
      llog('ECS Transform:', {
        position: data.transform.position,
        quaternion: data.transform.quaternion,
        version: data.transform.version,
      });
    }
    if (data.obj3D) {
      llog('Three.js Object:', {
        type: data.obj3D.type,
        position: data.obj3D.position,
        rotation: data.obj3D.rotation,
        quaternion: data.obj3D.quaternion,
        scale: data.obj3D.scale,
        obj: data.obj3D,
      });
    }
    if (data.physics) {
      llog('Physics Body:', {
        type: data.physics.isDynamic ? 'DYNAMIC' : 'STATIC',
        linvel: data.physics.linvel,
      });
    }
    if (data.targetId) llog(`Target link ID: ${data.targetId}`);
  }
  if (opts?.includeAllData || opts?.compact) llog('All data:', data);
  llog(`%c--- [END INSPECTING ENTITY] ---`, 'color: #136f82; font-weight: bold;');
};
