import * as THREE from 'three/webgpu';
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

/**
 * Creates a Three.js light
 * @param id (string) optional id for the light, if id is not provided the uuid of the light is used as id.
 * @param type ({@link LightProps.type}) required enum string that defines the type of light.
 * @param params ({@link LightProps.params}) optional light params, the params props depends on the type of the light.
 * @returns Three.js light
 */
export const createLight = ({ id, type, params }: LightProps) => {
  let light: Lights | null = null;

  if (id && lights[id]) return lights[id];

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

/**
 * Returns a light or undefined based on the id
 * @param id (string) light id
 * @returns Three.js light | undefined
 */
export const getLight = (id: string) => lights[id];

/**
 * Returns one or multiple lights based on the ids
 * @param id (array of strings) one or multiple light ids
 * @returns Array of Three.js lights
 */
export const getLights = (id: string[]) => id.map((lightId) => lights[lightId]);

/**
 * Deletes a light based on an id
 * @param id (string) light id
 */
export const deleteLight = (id: string) => {
  const light = lights[id];
  if (!light) {
    lwarn(`Could not find light with id "${id}" in deleteLight(id).`);
    return;
  }

  light.removeFromParent();
  light.dispose();
  delete lights[id];
};

/**
 * Returns all created lights that exist
 * @returns array of Three.js lights
 */
export const getAllLights = () => lights;

/**
 * Checks, with a light id, whether a light exists or not
 * @param id (string) light id
 * @returns boolean
 */
export const doesLightExist = (id: string) => Boolean(lights[id]);
