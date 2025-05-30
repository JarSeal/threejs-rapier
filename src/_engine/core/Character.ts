import * as THREE from 'three/webgpu';
import { createPhysicsObjectWithMesh, PhysicsParams } from './PhysicsRapier';
import { lerror } from '../utils/Logger';

type CharacterObject = {
  id: string;
  physObjectId: string;
  meshId: string;
};

const characters: { [id: string]: CharacterObject } = {};

/**
 * Creates a character with controls. The character can be either a player controllable
 * character or controlled by an agent (AI).
 * @param physicsParamas (PhysicsParams) ({@link PhysicsParams})
 * @param meshOrMeshId (THREE.Mesh | string) mesh or mesh id of the representation of the physics object
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional value to suppress logger warning for unitialized scene (true = no warning, default = false)
 * @returns CharacterObject ({@link CharacterObject})
 */
export const createCharacter = (
  id: string,
  physicsParams: PhysicsParams,
  meshOrMeshId: THREE.Mesh | string,
  // controls: ???
  sceneId?: string,
  noWarnForUnitializedScene?: boolean
) => {
  if (characters[id]) {
    return characters[id];
  }

  const physObj = createPhysicsObjectWithMesh(
    physicsParams,
    meshOrMeshId,
    sceneId,
    noWarnForUnitializedScene
  );
  if (!physObj) {
    const msg = `Could not create character with id "${id}" in CharacterController createCharacter. Physics params: ${JSON.stringify(physicsParams)} -- Mesh id: ${typeof meshOrMeshId === 'string' ? meshOrMeshId : meshOrMeshId.userData.id} -- Scene id: ${sceneId}`;
    lerror(msg);
    throw new Error(msg);
  }
  if (!physObj.id) physObj.id = id;

  const char = {
    id,
    physObjectId: physObj.id,
    meshId: typeof meshOrMeshId === 'string' ? meshOrMeshId : meshOrMeshId.userData.id,
  };
  characters[id] = char;

  return char;
};
