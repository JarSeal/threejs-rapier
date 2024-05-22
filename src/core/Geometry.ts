import * as THREE from 'three';

const geometries: { [id: string]: THREE.BufferGeometry } = {};

export type GeoProps = {
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

export const createGeometry = (props?: GeoProps) => {
  let geo;
  if (props?.id && geometries[props?.id]) {
    throw new Error(
      `Geometry with id "${props.id}" already exists. Pick another id or delete the geometry first before recreating it.`
    );
  }

  if (props?.box) {
    const width = props.box.width || 1;
    const height = props.box.height || 1;
    const depth = props.box.depth || 1;
    const widthSegments = props.box.widthSegments || 1;
    const heightSegments = props.box.heightSegments || 1;
    const depthSegments = props.box.depthSegments || 1;
    geo = new THREE.BoxGeometry(width, height, depth, widthSegments, heightSegments, depthSegments);
    geometries[props?.id || geo.uuid] = geo;
  }

  if (!geo) {
    throw new Error('Could not create geometry (propably unknown props).');
  }

  return geo;
};

export const getGeometry = (id: string | string[]) => {
  if (typeof id === 'string') return geometries[id];
  return id.map((geoId) => geometries[geoId]);
};

export const deleteGeometry = (id: string | string[]) => {
  if (typeof id === 'string') {
    const geo = geometries[id];
    geo.dispose();
    delete geometries[id];
    return;
  }

  for (let i = 0; i < id.length; i++) {
    const geoId = id[i];
    const geo = geometries[geoId];
    geo.dispose();
    delete geometries[geoId];
  }
};

export const getAllGeometries = () => geometries;
