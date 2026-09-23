import * as THREE from 'three/webgpu';
import { createPhysicsEntity } from './PhysicsManager';
import { ColliderParams, RigidBodyParams } from './Physics/PhysicsAPITypes';
import { createKeyBinding, deleteKeyBinding, type KeyBinding } from './Input/KeyboardInput';
import { createMouseBinding, deleteMouseBinding, type MouseBinding } from './Input/MouseInput';
import { getMeshByAppId } from './MeshManager';
import { getECSWorld, getEntityIdByAppId } from './ECS';
import { existsOrThrow } from '../utils/assert';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';

export type CharacterObject = {
  id: string;
  name?: string;
  entityId: number;
  meshId: string;
  keyControlIds: string[];
  mouseControlIds: string[];
  data?: { [key: string]: unknown };
};

let characters: { [id: string]: CharacterObject } = {};
let onDeleteCharacter: { [characterId: string]: () => void } = {};

/**
 * Creates a character with controls. The character can be either a player controllable
 * character or controlled by an agent (AI).
 * @param physicsParams (colliders + optional shared rigidBody) ({@link ColliderParams}, {@link RigidBodyParams}) describes the (possibly compound) physics body for this character
 * @param meshOrMeshId (THREE.Mesh | string) mesh or mesh id of the representation of the physics object
 * @param controls (array of {@link KeyBinding} and/or {@link MouseBinding}) the input bindings for this character
 * @returns CharacterObject ({@link CharacterObject})
 */
export const createCharacter = async ({
  id,
  name,
  physicsParams,
  meshOrMeshId,
  controls,
  data = {},
}: {
  id: string;
  name?: string;
  physicsParams: { colliders: ColliderParams | ColliderParams[]; rigidBody?: RigidBodyParams };
  meshOrMeshId: THREE.Mesh | string;
  controls?: (KeyBinding | MouseBinding)[];
  data?: { [key: string]: unknown };
}) => {
  let mesh: THREE.Mesh;
  let meshId: string;
  if (typeof meshOrMeshId === 'string') {
    meshId = meshOrMeshId;
    mesh = existsOrThrow(
      getMeshByAppId(meshId),
      `Mesh not found with id '${meshId}' in createCharacter.`
    );
  } else {
    mesh = meshOrMeshId;
    meshId = mesh.userData.id;
    existsOrThrow(mesh, 'Mesh not found in createCharacter.');
  }
  mesh.userData.isCharacter = true;

  const ecsWorld = getECSWorld();
  const entityId: number = existsOrThrow(
    mesh.userData.entityId ?? getEntityIdByAppId(meshId, ecsWorld),
    `Could not find entity id for mesh '${meshId}' in createCharacter.`
  );

  await createPhysicsEntity(
    physicsParams.colliders,
    physicsParams.rigidBody,
    entityId,
    undefined,
    ecsWorld
  );

  const char: CharacterObject = {
    id,
    name,
    entityId,
    meshId,
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
      if (ctrl.type.startsWith('MOUSE')) {
        createMouseBinding(ctrl as MouseBinding);
        mouseControlIds.push(ctrlId);
        continue;
      }
      createKeyBinding(ctrl as KeyBinding);
      keyControlIds.push(ctrlId);
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
    deleteKeyBinding(charObj.keyControlIds[i]);
  }
  for (let i = 0; i < charObj.mouseControlIds.length; i++) {
    deleteMouseBinding(charObj.mouseControlIds[i]);
  }

  // Delete ECS entity (also disposes the physics rigid body/colliders and the mesh)
  getECSWorld().deleteEntity(charObj.entityId);

  // Remove character
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
