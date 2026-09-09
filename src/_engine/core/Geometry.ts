import * as THREE from 'three/webgpu';
import { lerror } from '../utils/Logger';

const geometries: {
  [id: string]: {
    resource: THREE.BufferGeometry;
    count: number;
    persistent?: boolean;
  };
} = {};

export type GeoProps = {
  id?: string;
  isPersistent?: boolean;
  debugData?: { name?: string; description?: string };
} & (
  | {
      type: 'BOX';
      params?: {
        width?: number;
        height?: number;
        depth?: number;
        widthSegments?: number;
        heightSegments?: number;
        depthSegments?: number;
      };
    }
  | {
      type: 'SPHERE';
      params?: {
        radius?: number;
        widthSegments?: number;
        heightSegments?: number;
        phiStart?: number;
        phiLength?: number;
        thetaStart?: number;
        thetaLength?: number;
      };
    }
  | {
      type: 'CYLINDER';
      params?: {
        radiusTop?: number;
        radiusBottom?: number;
        height?: number;
        radialSegments?: number;
        heightSegments?: number;
        openEnded?: boolean;
        thetaStart?: number;
        thetaLength?: number;
      };
    }
  | {
      type: 'CAPSULE';
      params?: {
        radius?: number;
        height?: number;
        capSegments?: number;
        radialSegments?: number;
        heightSegments?: number;
      };
    }
  | {
      type: 'CONE';
      params?: {
        radius?: number;
        height?: number;
        radialSegments?: number;
        heightSegments?: number;
        openEnded?: boolean;
        thetaStart?: number;
        thetaLength?: number;
      };
    }
);

export type GeoTypes =
  | THREE.BoxGeometry
  | THREE.SphereGeometry
  | THREE.CylinderGeometry
  | THREE.CapsuleGeometry
  | THREE.ConeGeometry;

export const incGeoRef = (id: string) => {
  if (geometries[id]) {
    geometries[id].count++;
  }
};

export const decGeoRef = (id: string) => {
  const entry = geometries[id];
  if (!entry) return;

  entry.count--;

  if (entry.count <= 0 && !entry.persistent) {
    entry.resource.dispose();
    delete geometries[id];
  }
};

export const setGeoPersistence = (id: string, state: boolean) => {
  const entry = geometries[id];
  if (!entry) return;
  entry.persistent = state;

  if (!state && entry.count === 0) {
    entry.resource.dispose();
    delete geometries[id];
  }
};

/**
 * Creates a Three.js geometry supporting cache retrieval and reference tracking.
 * @param props - Geometry configuration settings.
 * @returns An instantiated, indexed Three.js geometry.
 */
export const createGeometry = <T extends GeoTypes = GeoTypes>(props: GeoProps): T => {
  const id = props.id;

  if (id && geometries[id]) return geometries[id].resource as T;

  let geo: THREE.BufferGeometry | null = null;

  switch (props.type) {
    case 'BOX':
      geo = new THREE.BoxGeometry(
        props.params?.width,
        props.params?.height,
        props.params?.depth,
        props.params?.widthSegments,
        props.params?.heightSegments,
        props.params?.depthSegments
      );
      break;
    case 'SPHERE':
      geo = new THREE.SphereGeometry(
        props.params?.radius,
        props.params?.widthSegments,
        props.params?.heightSegments,
        props.params?.phiStart,
        props.params?.phiLength,
        props.params?.thetaStart,
        props.params?.thetaLength
      );
      break;
    case 'CYLINDER':
      geo = new THREE.CylinderGeometry(
        props.params?.radiusTop,
        props.params?.radiusBottom,
        props.params?.height,
        props.params?.radialSegments,
        props.params?.heightSegments,
        props.params?.openEnded,
        props.params?.thetaStart,
        props.params?.thetaLength
      );
      break;
    case 'CAPSULE':
      geo = new THREE.CapsuleGeometry(
        props.params?.radius,
        props.params?.height,
        props.params?.capSegments,
        props.params?.radialSegments,
        props.params?.heightSegments
      );
      break;
    case 'CONE':
      geo = new THREE.ConeGeometry(
        props.params?.radius,
        props.params?.height,
        props.params?.radialSegments,
        props.params?.heightSegments,
        props.params?.openEnded,
        props.params?.thetaStart,
        props.params?.thetaLength
      );
      break;
  }

  if (!geo) {
    const msg = `[Geometry Manager] Could not create geometry (unknown or incomplete type: ${props.type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  const assignedId = id || geo.uuid;
  geo.userData.id = assignedId;
  geo.userData.props = props;

  if (props.debugData?.name) {
    geo.name = props.debugData.name;
  }

  saveGeometry(geo, assignedId, props.isPersistent);

  return geo as T;
};

/**
 * Returns a geometry instance or undefined based on the id.
 * @param id - Geometry id
 */
export const getGeometry = (id: string) => geometries[id]?.resource;

/**
 * Returns multiple geometries based on an array of ids.
 * @param ids - Array of geometry ids
 */
export const getGeometries = (ids: string[]) =>
  ids.map((geoId) => geometries[geoId]?.resource).filter(Boolean) as THREE.BufferGeometry[];

/**
 * Returns a flat map object of all existing geometry resources.
 */
export const getAllGeometries = () => {
  const flatMap: { [id: string]: THREE.BufferGeometry } = {};
  Object.keys(geometries).forEach((key) => {
    flatMap[key] = geometries[key].resource;
  });
  return flatMap;
};

export const getGeometryRegistry = () => geometries;

/**
 * Forcefully disposes and removes one or multiple geometries from memory cache.
 * @param id - Geometry id or array of ids
 */
export const deleteGeometry = (id: string | string[]) => {
  const targetIds = Array.isArray(id) ? id : [id];

  for (const geoId of targetIds) {
    const entry = geometries[geoId];
    if (!entry) continue;

    entry.resource.dispose();
    delete geometries[geoId];
  }
};

/**
 * Saves a geometry instance inside the engine tracking registry.
 * @param geometry - Target THREE.BufferGeometry instance
 * @param givenId - Optional string identifier
 * @param isPersistent - Bypasses standard cleanup loops when true
 */
export const saveGeometry = (
  geometry: THREE.BufferGeometry,
  givenId?: string,
  isPersistent?: boolean
) => {
  if (!geometry.isBufferGeometry) return;
  const id = givenId || geometry.uuid;
  if (geometries[id]) return geometries[id].resource;

  geometry.userData.id = id;
  geometries[id] = {
    resource: geometry,
    count: 0,
    ...(isPersistent ? { persistent: true } : {}),
  };
  return geometry;
};

/**
 * Checks whether a geometry with a specific id exists in memory cache.
 * @param id - Geometry id
 */
export const doesGeoExist = (id: string) => Boolean(geometries[id]);
