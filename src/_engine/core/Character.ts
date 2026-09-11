import * as THREE from 'three/webgpu';
import { createPhysicsObjectWithMesh, deletePhysicsObject, PhysicsParams } from './PhysicsRapier';
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
import { getMeshByAppId } from './MeshManager';
import { getECSWorld, getEntityIdByAppId } from './ECS';
import { existsOrThrow } from '../utils/assert';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';

export type CharacterObject = {
  id: string;
  name?: string;
  physObjectId: string;
  meshId: string | string[];
  keyControlIds: string[];
  mouseControlIds: string[];
  data?: { [key: string]: unknown };
};

let characters: { [id: string]: CharacterObject } = {};
let onDeleteCharacter: { [characterId: string]: () => void } = {};

/**
 * Creates a character with controls. The character can be either a player controllable
 * character or controlled by an agent (AI).
 * @param physicsParams (PhysicsParams | PhysicsParams[]) ({@link PhysicsParams}) if array then the physics object is a multi object
 * @param meshOrMeshId ((THREE.Mesh | string) | (THREE.Mesh | string)[]) mesh or mesh id (or array of either of them) of the representation of the physics object
 * @param controls (array of KeyInputParams and/or MouseInputParams) the input control params for this character
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional value to suppress logger warning for uninitialized scene (true = no warning, default = false)
 * @returns CharacterObject ({@link CharacterObject})
 */
export const createCharacter = ({
  id,
  name,
  physicsParams,
  meshOrMeshId,
  controls,
  sceneId,
  noWarnForUnitializedScene,
  data = {},
}: {
  id: string;
  name?: string;
  physicsParams: PhysicsParams | PhysicsParams[];
  meshOrMeshId: (THREE.Mesh | string) | (THREE.Mesh | string)[];
  controls?: (
    | (KeyInputParams & { id: string; type: KeyInputControlType })
    | (MouseInputParams & { id: string; type: MouseInputControlType })
  )[];
  sceneId?: string;
  noWarnForUnitializedScene?: boolean;
  data?: { [key: string]: unknown };
}) => {
  const physObj = existsOrThrow(
    createPhysicsObjectWithMesh({
      physicsParams,
      meshOrMeshId,
      id,
      sceneId,
      noWarnForUnitializedScene,
    }),
    `Could not create character with id "${id}" in CharacterController createCharacter. Physics params: ${JSON.stringify(physicsParams)} -- Scene id: ${sceneId}`
  );
  if (!physObj.id) physObj.id = id;

  let meshIds: string | string[] = '';
  let mesh: THREE.Mesh | null = null;
  if (typeof meshOrMeshId === 'string') {
    meshIds = meshOrMeshId;
    mesh = existsOrThrow(
      getMeshByAppId(meshIds),
      `Mesh not found with id '${meshIds}' in createCharacter.`
    );
    mesh.userData.isCharacter = true;
  } else if (Array.isArray(meshOrMeshId)) {
    meshIds = [];
    for (let i = 0; i < meshOrMeshId.length; i++) {
      const m = meshOrMeshId[i];
      if (typeof m === 'string') {
        (meshIds as string[]).push(m);
        mesh = existsOrThrow(
          getMeshByAppId(m),
          `Mesh not found with id '${m}' in createCharacter.`
        );
        mesh.userData.isCharacter = true;
      } else {
        meshIds.push(m.userData.id);
        mesh = m;
        existsOrThrow(mesh, 'Mesh not found in createCharacter.');
        mesh.userData.isCharacter = true;
      }
    }
  } else {
    meshIds = meshOrMeshId.userData.id;
    mesh = meshOrMeshId;
    existsOrThrow(mesh, 'Mesh not found in createCharacter.');
    mesh.userData.isCharacter = true;
  }

  const char: CharacterObject = {
    id,
    name,
    physObjectId: physObj.id,
    meshId: meshIds,
    keyControlIds: [],
    mouseControlIds: [],
    data,
  };

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

  updateCharactersDebuggerGUI();

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

  // Delete physics objects
  for (let i = 0; i < charObj.physObjectId.length; i++) {
    deletePhysicsObject(charObj.physObjectId[i]);
  }

  // Remove mesh / delete ECS entity
  const ecsWorld = getECSWorld();
  const deleteCharacterMeshEntity = (mId: string) => {
    const mesh = getMeshByAppId(mId, ecsWorld);
    if (mesh) {
      const entityId =
        mesh.userData.entityId ?? (mId ? getEntityIdByAppId(mId, ecsWorld) : undefined);
      if (entityId !== undefined) {
        ecsWorld.deleteEntity(entityId);
      } else {
        mesh.removeFromParent();
      }
    }
  };

  if (Array.isArray(charObj.meshId)) {
    for (let i = 0; i < charObj.meshId.length; i++) {
      deleteCharacterMeshEntity(charObj.meshId[i]);
    }
  } else if (charObj.meshId) {
    deleteCharacterMeshEntity(charObj.meshId);
  }

  // Delete character
  delete characters[id];

  if (onDeleteCharacter[id]) onDeleteCharacter[id]();

  updateCharactersDebuggerGUI();
};

/** Deletes all characters */
export const deleteAllCharacters = () => {
  const keys = Object.keys(characters);
  for (let i = 0; i < keys.length; i++) {
    deleteCharacter(keys[i]);
  }

  characters = {};
  onDeleteCharacter = {};
};

export const registerOnDeleteCharacter = (id: string, fn: () => void) =>
  (onDeleteCharacter[id] = fn);

export const getCharacters = () => characters;

export const getCharacterById = (id: string) => characters[id];

// Debugger stuff for characters
// *****************************

type CharacterDebugModule = typeof import('../core/Debug/_dbg__Character');
let debugGUI: DebugModuleRef<CharacterDebugModule> | null = null;

export const registerCharacterTools = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__Character'), true);
};

export const createCharactersDebuggerGUI = () => {
  useDebug(debugGUI, true)?._createCharactersDebuggerGUI();
};

export const updateCharactersDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  useDebug(debugGUI, true)?._updateCharactersDebuggerGUI(only);
};

export const updateDebuggerCharactersListSelectedClass = () => {
  useDebug(debugGUI, true)?._updateDebuggerCharactersListSelectedClass();
};
