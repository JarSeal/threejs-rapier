import * as THREE from 'three/webgpu';
import { createPhysicsObjectWithMesh, PhysicsParams } from './PhysicsRapier';
import { lerror } from '../utils/Logger';
import {
  createKeyInputControl,
  createMouseInputControl,
  KeyInputControlType,
  KeyInputParams,
  MouseInputControlType,
  MouseInputParams,
} from './InputControls';

type CharacterObject = {
  id: string;
  physObjectId: string;
  meshId: string;
  keyControlIds: string[];
  mouseControlIds: string[];
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
export const createCharacter = (
  id: string,
  physicsParams: PhysicsParams,
  meshOrMeshId: THREE.Mesh | string,
  controls?: (
    | (KeyInputParams & { id: string; type: KeyInputControlType })
    | (MouseInputParams & { id: string; type: MouseInputControlType })
  )[],
  sceneId?: string,
  noWarnForUnitializedScene?: boolean
) => {
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

  const keyControlIds: string[] = [];
  const mouseControlIds: string[] = [];
  if (controls) {
    for (let i = 0; i < controls.length; i++) {
      const ctrl = controls[i];
      const ctrlId = ctrl.id;
      if (ctrl.type?.startsWith('MOUSE')) {
        // Mouse control
        createMouseInputControl(ctrl as MouseInputParams);
        mouseControlIds.push(ctrlId);
        continue;
      }
      if (ctrl.type?.startsWith('KEY')) {
        // Key control
        createKeyInputControl(ctrl as KeyInputParams);
        keyControlIds.push(ctrlId);
        continue;
      }
    }
  }

  const char = {
    id,
    physObjectId: physObj.id,
    meshId: typeof meshOrMeshId === 'string' ? meshOrMeshId : meshOrMeshId.userData.id,
    keyControlIds,
    mouseControlIds,
  };
  characters[id] = char;

  return char;
};
