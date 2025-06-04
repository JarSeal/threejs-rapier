import * as THREE from 'three/webgpu';
import { createPhysicsObjectWithMesh, deletePhysicsObject, PhysicsParams } from './PhysicsRapier';
import { lerror } from '../utils/Logger';
import {
  createKeyInputControl,
  createMouseInputControl,
  deleteKeyInputControl,
  deleteMouseInputControl,
  KeyInputControlType,
  KeyInputParams,
  MouseInputControlType,
  MouseInputParams,
} from './InputControls';
import { getMesh } from './Mesh';
import { existsOrThrow } from '../utils/helpers';

export type CharacterObject = {
  id: string;
  physObjectId: string;
  meshId: string;
  keyControlIds: string[];
  mouseControlIds: string[];
  data?: { [key: string]: unknown };
};

const characters: { [id: string]: CharacterObject } = {};

/**
 * Creates a character with controls. The character can be either a player controllable
 * character or controlled by an agent (AI).
 * @param physicsParamas (PhysicsParams) ({@link PhysicsParams})
 * @param meshOrMeshId (THREE.Mesh | string) mesh or mesh id of the representation of the physics object
 * @param controls (array of KeyInputParams and/or MouseInputParams) the input control params for this character
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional value to suppress logger warning for unitialized scene (true = no warning, default = false)
 * @returns CharacterObject ({@link CharacterObject})
 */
export const createCharacter = ({
  id,
  physicsParams,
  meshOrMeshId,
  controls,
  sceneId,
  noWarnForUnitializedScene,
  data = {},
}: {
  id: string;
  physicsParams: PhysicsParams;
  meshOrMeshId: THREE.Mesh | string;
  controls?: (
    | (KeyInputParams & { id: string; type: KeyInputControlType })
    | (MouseInputParams & { id: string; type: MouseInputControlType })
  )[];
  sceneId?: string;
  noWarnForUnitializedScene?: boolean;
  data?: { [key: string]: unknown };
}) => {
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

  const char: CharacterObject = {
    id,
    physObjectId: physObj.id,
    meshId: typeof meshOrMeshId === 'string' ? meshOrMeshId : meshOrMeshId.userData.id,
    keyControlIds: [],
    mouseControlIds: [],
    data,
  };

  const mesh = typeof meshOrMeshId === 'string' ? getMesh(meshOrMeshId) : meshOrMeshId;
  existsOrThrow(
    mesh,
    `Mesh not found with id '${typeof meshOrMeshId === 'string' ? meshOrMeshId : undefined}' in createCharacter.`
  );
  mesh.userData.isCharacter = true;

  const keyControlIds: string[] = [];
  const mouseControlIds: string[] = [];
  if (controls) {
    for (let i = 0; i < controls.length; i++) {
      const ctrl = controls[i];
      const ctrlId = ctrl.id;
      if (ctrl.type?.startsWith('MOUSE')) {
        // Mouse control
        createMouseInputControl({
          ...(ctrl as MouseInputParams),
          data: { physObj, mesh, charObject: char },
        });
        mouseControlIds.push(ctrlId);
        continue;
      }
      if (ctrl.type?.startsWith('KEY')) {
        // Key control
        createKeyInputControl({
          ...(ctrl as KeyInputParams),
          data: { physObj, mesh, charObject: char },
        });
        keyControlIds.push(ctrlId);
        continue;
      }
    }
  }

  char.keyControlIds = keyControlIds;
  char.mouseControlIds = mouseControlIds;
  characters[id] = char;

  return char;
};

/** Delete a character by id */
export const deleteCharacter = (id: string) => {
  const charObj = existsOrThrow(
    characters[id],
    `Could not find character with id '${id}' in deleteCharacter`
  );

  // Delete controls
  for (let i = 0; i < charObj.keyControlIds.length; i++) {
    deleteKeyInputControl({ id: charObj.keyControlIds[i] });
  }
  for (let i = 0; i < charObj.mouseControlIds.length; i++) {
    deleteMouseInputControl({ id: charObj.mouseControlIds[i] });
  }

  // Delete physic objects
  for (let i = 0; i < charObj.physObjectId.length; i++) {
    deletePhysicsObject(charObj.physObjectId[i]);
  }

  // Delete character
  delete characters[id];
};

/** Deletes all characters */
export const deleteAllCharacters = () => {
  const keys = Object.keys(characters);
  for (let i = 0; i < keys.length; i++) {
    deleteCharacter(keys[i]);
  }
};
