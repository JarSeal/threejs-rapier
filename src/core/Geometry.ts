import * as THREE from 'three';

const geometries: { [id: string]: THREE.BufferGeometry } = {};

export type GeoProps2 = {
  id?: string;
  box?: {
    width?: number;
    height?: number;
    depth?: number;
    widthSegments?: number;
    heightSegments?: number;
    depthSegments?: number;
  };
};

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

// @TODO: add JSDoc comment
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

// @TODO: add JSDoc comment
export const getGeometry = (id: string | string[]) => {
  if (typeof id === 'string') return geometries[id];
  return id.map((geoId) => geometries[geoId]);
};

// @TODO: add JSDoc comment
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

// @TODO: add JSDoc comment
export const getAllGeometries = () => geometries;

// @TODO: add JSDoc comment
export const saveGeometry = (geometry: THREE.BufferGeometry, givenId?: string) => {
  if (!geometry.isBufferGeometry) return;
  const id = givenId || geometry.uuid;
  geometry.userData.id = id;
  geometries[id] = geometry;
  return geometry;
};
