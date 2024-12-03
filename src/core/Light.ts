import * as THREE from 'three';
import { lwarn } from '../utils/Logger';

export type Lights = THREE.AmbientLight | THREE.HemisphereLight | THREE.PointLight;

export type LightProps = { id?: string } & (
  | { type: 'AMBIENT'; params?: { color?: THREE.ColorRepresentation; intensity?: number } }
  | {
      type: 'HEMISPHERE';
      params?: {
        skyColor?: THREE.ColorRepresentation;
        groundColor?: THREE.ColorRepresentation;
        intensity?: number;
      };
    }
  | {
      type: 'POINT';
      params?: {
        color?: THREE.ColorRepresentation;
        intensity?: number;
        distance?: number;
        decay?: number;
      };
    }
);

const lights: { [id: string]: Lights } = {};

export const createLight = ({ id, type, params }: LightProps) => {
  let light: Lights | null = null;

  if (id && lights[id]) {
    throw new Error(
      `Light with id "${id}" already exists. Pick another id or delete the light first before recreating it.`
    );
  }

  switch (type) {
    case 'AMBIENT':
      light = new THREE.AmbientLight(params?.color, params?.intensity);
      light.userData.type = 'AMBIENT';
      break;
    case 'HEMISPHERE':
      light = new THREE.HemisphereLight(params?.skyColor, params?.groundColor, params?.intensity);
      light.userData.type = 'HEMISPHERE';
      break;
    case 'POINT':
      light = new THREE.PointLight(
        params?.color,
        params?.intensity,
        params?.distance,
        params?.decay
      );
      light.userData.type = 'POINT';
      break;
    // @TODO: add all light types
  }

  if (!light) {
    throw new Error(`Could not create light (unknown type: '${type}').`);
  }

  light.userData.id = id || light.uuid;
  lights[id || light.uuid] = light;

  return light;
};

export const getLight = (id: string) => lights[id];

export const getLights = (id: string[]) => id.map((lightId) => lights[lightId]);

export const deleteLight = (id: string) => {
  const light = lights[id];
  if (!light) {
    lwarn(`Could not find light with id "${id}" in deleteLight(id).`);
    return;
  }

  light.dispose();
  delete lights[id];
};

export const getAllLights = () => lights;
