import * as THREE from 'three/webgpu';
import { getRenderer, isWebGPURenderer } from './Renderer';
import { getRootScene } from './Scene';

const geometries: {
  [id: string]: {
    resource: THREE.BufferGeometry;
    count: number;
    persistent?: boolean;
    preWarm?: boolean;
  };
} = {};

type GeoBaseProps = { id?: string; isPersistent?: boolean; preWarm?: boolean };

export type GeoProps = GeoBaseProps &
  (
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

export const incGeometryRef = (id: string) => {
  if (geometries[id]) geometries[id].count++;
};

export const decGeometryRef = (id: string) => {
  const entry = geometries[id];
  if (!entry) return;
  entry.count--;
  if (entry.count <= 0 && !entry.persistent) {
    // Free VRAM from GPU
    entry.resource.dispose();
    delete geometries[id];
  }
};

export const setGeometryPersistence = (id: string, state: boolean) => {
  const geo = geometries[id];
  if (!geo) return;
  geo.persistent = state;
  if (!state && geo.count === 0) {
    // If the state changes from persistent to non-persistent (false),
    // then delete and dispose the geometry if the count is 0.
    geo.resource.dispose();
    delete geometries[id];
  }
};

/**
 * Force-uploads a geometry to the GPU.
 */
export const prewarmGeometry = async (id: string) => {
  const entry = geometries[id];
  const rootScene = getRootScene();
  if (entry && isWebGPURenderer() && rootScene) {
    // This triggers the creation of GPU buffers without rendering a single pixel.
    const tempMat = new THREE.MeshBasicNodeMaterial();
    const stagingMesh = new THREE.Mesh(entry.resource, tempMat);
    // @TODO: Ask about if this is okay
    const camera = new THREE.PerspectiveCamera();
    await getRenderer()?.compileAsync(stagingMesh, camera, rootScene);
    stagingMesh.geometry = null as unknown as THREE.BufferGeometry;
    stagingMesh.material = null as unknown as THREE.MeshBasicNodeMaterial;
  }
};

/**
 * Creates a Three.js geometry.
 * @param props geometry props: {@link GeoProps}
 * @returns geometry ({@link GeoTypes})
 */
export const createGeometry = <T extends GeoTypes>(props: GeoProps): T => {
  let geo;
  if (props?.id && geometries[props.id]) return geometries[props.id].resource as T;

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
    // @TODO: add all geometry types
  }

  if (!geo) {
    throw new Error(
      `Could not create geometry (unknown type: ${props.type}). Geometry id "${props?.id}".`
    );
  }

  const id = props?.id || geo.uuid;
  geo.userData.id = id;
  geo.userData.props = props;
  geometries[id] = {
    resource: geo,
    count: 0,
    ...(props?.isPersistent ? { persistent: true } : {}),
    ...(props?.preWarm ? { preWarm: true } : {}),
  };

  if (props?.preWarm) prewarmGeometry(id);

  return geo as T;
};

/**
 * Returns one or many geometries.
 * @param id geometry id or array of ids
 * @returns one or many geometries (THREE.BufferGeometry)
 */
export const getGeometry = (id: string | string[]) => {
  if (typeof id === 'string') return geometries[id].resource;
  return id.map((geoId) => geometries[geoId].resource);
};

/**
 * Forcefully deletes one or many geometries from CPU and GPU memory.
 * @param id geometry id or array of ids
 */
export const deleteGeometry = (id: string | string[]) => {
  if (typeof id === 'string') {
    const geo = geometries[id];
    if (!geo) return;
    geo.resource.dispose();
    delete geometries[id];
    return;
  }
  for (let i = 0; i < id.length; i++) {
    const geoId = id[i];
    const geo = geometries[geoId];
    if (!geo) continue;
    geo.resource.dispose();
    delete geometries[geoId];
  }
};

export const freeGeometryGPUMemory = (id: string | string[]) => {
  if (typeof id === 'string') {
    const geo = geometries[id];
    geo?.resource.dispose();
    return;
  }
  for (let i = 0; i < id.length; i++) {
    const geoId = id[i];
    const geo = geometries[geoId];
    geo?.resource.dispose();
  }
};

/**
 * Returns all geometries.
 * @returns object: { [id: string]: THREE.BufferGeometry }
 */
export const getAllGeometries = () => {
  const keys = Object.keys(geometries);
  return keys.map((key) => ({ [key]: geometries[key].resource }));
};

export const getGeometryRegistry = () => geometries;

/**
 * Saves a buffer geometry to CPU memory and if preWarm prop is set saves it to GPU as well.
 */
export const saveBufferGeometry = (
  geometry: THREE.BufferGeometry,
  props?: GeoBaseProps & { isImported?: boolean }
) => {
  const id = props?.id || geometry.uuid;
  if (geometries[id]) return geometries[id];
  geometry.userData.id = id;
  if (props?.isImported) geometry.userData.isImported = true;
  geometries[id] = {
    resource: geometry,
    count: 0,
    ...(props?.isPersistent ? { persistent: true } : {}),
    ...(props?.preWarm ? { preWarm: true } : {}),
  };

  if (props?.preWarm) prewarmGeometry(id);

  return geometry;
};

/**
 * Checks, with a geometry id, whether a geometry exists or not
 * @param id (string) geometry id
 * @returns boolean
 */
export const doesGeoExist = (id: string) => Boolean(geometries[id]);
