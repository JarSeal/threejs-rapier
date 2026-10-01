import * as THREE from 'three/webgpu';
import { createPhysicsEntity } from './PhysicsManager';
import { ColliderParams, RigidBodyParams } from './Physics/PhysicsAPITypes';
import { createKeyBinding, deleteKeyBinding, type KeyBinding } from './Input/KeyboardInput';
import { createMouseBinding, deleteMouseBinding, type MouseBinding } from './Input/MouseInput';
import { getMeshByAppId } from './MeshManager';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import type { CharacterObject } from './Character/CharacterTypes';
import { ECSSystemStage } from '../../AppECSRegistry';
import { existsOrThrow } from '../utils/assert';
import { lwarn } from '../utils/Logger';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';

export type { CharacterController, CharacterObject } from './Character/CharacterTypes';

/** Character id → entity id, in the default ECS world (where createCharacter puts every
 * character). The characters themselves live in the CHARACTER component storage. */
const characterEntityIds = new Map<string, number>();
let onDeleteCharacter: { [characterId: string]: () => void } = {};

/** After the other APP_PHYSICS_STEP systems (default order 0), so what those request from a
 * character (eg. an AI's moves) applies in the same sub-step. */
const CHARACTER_SYSTEM_ORDER = -10;

/** Ticks every character's controller once per fixed physics sub-step. */
const characterControllerSystem = (world: ECSWorld, dt: number) => {
  const storage = world.getStorage(ComponentType.CHARACTER);
  // keys() + get(): the storage's own iterator allocates a [key, value] pair per entry
  for (const entityId of storage.keys()) storage.get(entityId)!.controller?.tick(dt);
};

ECSWorld.registerPlugin((world) => {
  world.addSystem(
    ECSSystemStage.APP_PHYSICS_STEP,
    'characterControllerSystem',
    characterControllerSystem,
    CHARACTER_SYSTEM_ORDER
  );
});

// Every way a character's entity goes (deleteCharacter, a scene change, the debugger, a direct
// world.deleteEntity) cleans up the same way.
ECSWorld.registerComponentHooks(ComponentType.CHARACTER, {
  onDeleteEntity: (entityId, world) => {
    const char = world.getComponent(entityId, ComponentType.CHARACTER);
    if (!char) return;
    char.controller?.dispose?.();
    for (let i = 0; i < char.keyBindingIds.length; i++) deleteKeyBinding(char.keyBindingIds[i]);
    for (let i = 0; i < char.mouseBindingIds.length; i++) {
      deleteMouseBinding(char.mouseBindingIds[i]);
    }
    if (characterEntityIds.get(char.id) === entityId) characterEntityIds.delete(char.id);
    const onDelete = onDeleteCharacter[char.id];
    delete onDeleteCharacter[char.id];
    onDelete?.();
    // The entity still exists while its hooks run
    queueCharactersDebuggerUpdate();
  },
});

/**
 * Creates a character with controls. The character can be either a player controllable
 * character or controlled by an agent (AI). The mesh's entity gets the physics components, a
 * `CHARACTER` component ({@link CharacterObject}) and `TAG_IS_CHARACTER`. Deleting that entity
 * any way deletes the character and its bindings. An existing character with the same id is
 * replaced.
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
  // Before the new bindings exist: the old character's delete hook removes its bindings by id
  if (deleteCharacter(id)) {
    lwarn(`createCharacter: replaced the existing character with id '${id}'.`);
  }

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
    visualId: meshId,
    keyBindingIds: [],
    mouseBindingIds: [],
    data,
  };
  ecsWorld.addComponent(entityId, ComponentType.CHARACTER, char);
  ecsWorld.addComponent(entityId, ComponentType.TAG_IS_CHARACTER, true);
  characterEntityIds.set(id, entityId);

  if (controls) {
    for (let i = 0; i < controls.length; i++) {
      const ctrl = controls[i];
      if (ctrl.type.startsWith('MOUSE')) {
        createMouseBinding(ctrl as MouseBinding);
        char.mouseBindingIds.push(ctrl.id);
        continue;
      }
      createKeyBinding(ctrl as KeyBinding);
      char.keyBindingIds.push(ctrl.id);
    }
  }

  updateCharactersDebuggerGUI();

  return char;
};

/** Deletes a character's entity: its physics body, mesh and bindings go with it (the CHARACTER
 * delete hook). Returns false when no character has this id. */
export const deleteCharacter = (id: string) => {
  const entityId = characterEntityIds.get(id);
  if (entityId === undefined) return false;
  getECSWorld().deleteEntity(entityId);
  return true;
};

/** Deletes all characters of the world (default: the default ECS world). */
export const deleteAllCharacters = (world: ECSWorld = getECSWorld()) => {
  const entityIds = [...world.getEntitiesWith(ComponentType.CHARACTER)];
  for (let i = 0; i < entityIds.length; i++) world.deleteEntity(entityIds[i]);
  onDeleteCharacter = {};
};

export const registerOnDeleteCharacter = (id: string, fn: () => void) =>
  (onDeleteCharacter[id] = fn);

/** Every character of the world (default: the default ECS world), as a new array. */
export const getCharacters = (world: ECSWorld = getECSWorld()): CharacterObject[] => {
  const storage = world.getStorage(ComponentType.CHARACTER);
  const characters: CharacterObject[] = [];
  for (const entityId of storage.keys()) characters.push(storage.get(entityId)!);
  return characters;
};

export const getCharacterById = (id: string): CharacterObject | undefined => {
  const entityId = characterEntityIds.get(id);
  if (entityId === undefined) return undefined;
  return getECSWorld().getComponent(entityId, ComponentType.CHARACTER);
};

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

let isCharactersDebuggerUpdateQueued = false;
/** One debugger update after the current task's deletions (eg. a whole scene's characters). */
const queueCharactersDebuggerUpdate = () => {
  if (!debugGUI || isCharactersDebuggerUpdateQueued) return;
  isCharactersDebuggerUpdateQueued = true;
  queueMicrotask(() => {
    isCharactersDebuggerUpdateQueued = false;
    updateCharactersDebuggerGUI();
  });
};
