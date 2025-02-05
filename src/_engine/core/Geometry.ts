import * as THREE from 'three/webgpu';

const geometries: { [id: string]: THREE.BufferGeometry } = {};

export type GeoProps = { id?: string } & (
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
);

export type GeoTypes = THREE.BoxGeometry | THREE.SphereGeometry;

/**
 * Creates a Three.js geometry.
 * @param props geometry props: {@link GeoProps}
 * @returns geometry ({@link GeoTypes})
 */
export const createGeometry = <T extends GeoTypes>(props: GeoProps): T => {
  let geo;
  if (props?.id && geometries[props?.id]) {
    throw new Error(
      `Geometry with id "${props.id}" already exists. Pick another id or delete the geometry first before recreating it.`
    );
  }

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
    // @TODO: add all geometry types
  }

  if (!geo) {
    throw new Error(`Could not create geometry (unknown type: ${props.type}).`);
  }

  geo.userData.id = props?.id || geo.uuid;
  geometries[props?.id || geo.uuid] = geo;

  return geo as T;
};

/**
 * Returns one or many geometries.
 * @param id geometry id or array of ids
 * @returns one or many geometries (THREE.BufferGeometry)
 */
export const getGeometry = (id: string | string[]) => {
  if (typeof id === 'string') return geometries[id];
  return id.map((geoId) => geometries[geoId]);
};

/**
 * Deletes one or many geometries.
 * @param id geometry id or array of ids
 */
export const deleteGeometry = (id: string | string[]) => {
  if (typeof id === 'string') {
    const geo = geometries[id];
    if (!geo) return;
    geo.dispose();
    delete geometries[id];
    return;
  }

  for (let i = 0; i < id.length; i++) {
    const geoId = id[i];
    const geo = geometries[geoId];
    if (!geo) continue;
    geo.dispose();
    delete geometries[geoId];
  }
};

/**
 * Returns all geometries.
 * @returns object: { [id: string]: THREE.BufferGeometry }
 */
export const getAllGeometries = () => geometries;

/**
 * Saves a geometry to memory;
 * @param geometry THREE.BufferGeometry
 * @param givenId optional string for geometry id, if not provided, the geometry's UUID will be used as id
 * @returns THREE.BufferGeometry or undefined
 */
export const saveGeometry = (geometry: THREE.BufferGeometry, givenId?: string) => {
  if (!geometry.isBufferGeometry) return;
  const id = givenId || geometry.uuid;
  if (geometries[id]) return geometries[id];
  geometry.userData.id = id;
  geometries[id] = geometry;
  return geometry;
};

/**
 * Checks, with a geometry id, whether a geometry exists or not
 * @param id (string) geometry id
 * @returns boolean
 */
export const doesGeoExist = (id: string) => Boolean(geometries[id]);
