import * as THREE from 'three/webgpu';
import {
  addDebugToast,
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
} from '../../debug/DebuggerGUI';
import { CMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import {
  closeDraggableWindow,
  getDraggableWindowsOfKind,
  getKindWindowId,
  registerDraggableWindowKind,
  toggleDraggableWindow,
  updateDraggableWindowsOfKind,
} from '../UI/DraggableWindow';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { Pane } from 'tweakpane';
import { llog, lwarn } from '../../utils/Logger';
import { deleteCharacter, getCharacterById, getCharacters } from '../Character';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { registerEntityWindowOpener } from '../../debug/Profiler';
import { confirmClearScope, createClearListLSButton } from './_dbg__ClearLSButtons';
import {
  CHAR_CONFIG_LS_KEY,
  clearSavedConfigScenes,
  getSceneIdsWithSavedConfig,
} from './Character/_dbg__CharacterConfigOverrides';
import { getCurrentSceneId } from '../Scene';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';
import {
  _openCharacterStateWindow,
  CHAR_STATE_WIN_ID,
  getCharacterStateWindowId,
} from './Character/_dbg__CharacterStateWindow';
import {
  isCharacterGizmosPinned,
  onCharacterGizmoPinsChange,
  setCharacterGizmosPinned,
  syncCharacterGizmoPins,
} from './Character/_dbg__CharacterGizmos';

export { _applySavedCharacterConfig } from './Character/_dbg__CharacterConfigOverrides';

const CHARACTERS_TAB_ID = 'charactersControls';
/** The edit windows' kind: one window per character, keyed by its id */
const CHAR_EDIT_WIN_ID = 'characterEditorWindow';

const getEditWindowId = (charId: string) => getKindWindowId(CHAR_EDIT_WIN_ID, charId);
/** The list's selection follows the edit windows' open states. */
const refreshCharactersList = () => updateDebuggerTab(CHARACTERS_TAB_ID);
// The rows' pin toggles follow the state windows' pin buttons
onCharacterGizmoPinsChange(refreshCharactersList);

// Undo/redo

/** Character poses set from the edit window, recorded to the scene's history. Character ids
 * are always app-supplied, so they're stable across reloads. */
type CharVec3 = { x: number; y: number; z: number };
type CharQuat = { x: number; y: number; z: number; w: number };
type CharacterUndoPayload<T> = { characterId: string; prev: T; next: T };

/** Finds the character's rigid body by character id at undo/redo time (never a captured
 * reference). */
const resolveCharacterRigidBody = (characterId: string) => {
  const character = getCharacterById(characterId);
  const rigidBody = character ? getECSWorld().getRigidBody(character.entityId) : undefined;
  if (!rigidBody) lwarn(`Undo/redo: character "${characterId}" no longer exists, skipping.`);
  return rigidBody;
};

// Only the pose is restored: the body keeps simulating (and its controls keep driving it),
// so its velocity isn't rolled back.
_registerUndoRedoActionHandler<CharacterUndoPayload<CharVec3>>('character.position', {
  undo: ({ characterId, prev }) =>
    resolveCharacterRigidBody(characterId)?.setTranslation(prev, true),
  redo: ({ characterId, next }) =>
    resolveCharacterRigidBody(characterId)?.setTranslation(next, true),
});
_registerUndoRedoActionHandler<CharacterUndoPayload<CharQuat>>('character.rotation', {
  undo: ({ characterId, prev }) => resolveCharacterRigidBody(characterId)?.setRotation(prev, true),
  redo: ({ characterId, next }) => resolveCharacterRigidBody(characterId)?.setRotation(next, true),
});

const recordCharacterPose = <T extends CharVec3 | CharQuat>(
  characterId: string,
  field: 'position' | 'rotation',
  prev: T,
  next: T
) => {
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  _recordUndoRedoAction<CharacterUndoPayload<T>>(
    `character.${field}`,
    `Character ${characterId}: ${field}`,
    { characterId, prev, next }
  );
};

const createEditCharacterContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string };
  const character = getCharacterById(d.id);
  if (!character) {
    // We want to close the window when no character is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => {
      closeDraggableWindow(getEditWindowId(d.id));
    }, 0);
    return CMP();
  }

  // The content is built before the window state is open: refresh the list selection after it
  queueMicrotask(refreshCharactersList);

  const windowCmp = CMP({ onRemoveCmp: () => pane.dispose() });
  const pane = new Pane({ container: windowCmp.elem });

  // @NOTE: The copy code button is not that easy to implement here
  // because the character object only has references to the mesh and phys objects,
  // and also controls (especially these would be hard to print).
  const openCharacterStateButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Open character state window">${getSvgIcon('personArmsUp')}</button>`,
    onClick: () => _openCharacterStateWindow(character),
  });
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this camera to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('CHARACTER:***************', character, '**********************');
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Remove character (only for this browser load, does not delete character permanently)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      closeDraggableWindow(getEditWindowId(d.id));
      closeDraggableWindow(getCharacterStateWindowId(d.id));
      deleteCharacter(character.id);
    },
  });

  windowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Name:</span> ${character.name || ''}</div>
  <div><span class="winSmallLabel">Id:</span> ${character.id}</div>
  <div><span class="winSmallLabel">Kind:</span> ${character.kind}</div>
  <div><span class="winSmallLabel">Control mode:</span> ${character.controlMode}</div>
  <div><span class="winSmallLabel">Entity id:</span> ${character.entityId}</div>
  <div><span class="winSmallLabel">Visual id:</span> ${character.visualId}</div>
  <div><span class="winSmallLabel">Key binding ids:</span> ${character.keyBindingIds.join(', ')}</div>
  <div><span class="winSmallLabel">Mouse binding ids:</span> ${character.mouseBindingIds.join(', ')}</div>
</div>
<div style="text-align:right">${openCharacterStateButton}${logButton}${deleteButton}</div>
</div>`,
  });

  const physRigidBody = getECSWorld().getRigidBody(character.entityId);
  if (!physRigidBody) return windowCmp;

  {
    const rigidBody = {
      position: physRigidBody.pos,
      rotation: new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          physRigidBody.rot.x,
          physRigidBody.rot.y,
          physRigidBody.rot.z,
          physRigidBody.rot.w
        )
      ),
    };
    // Position
    const positionInput = pane.addBinding(rigidBody, 'position', {
      label: 'Position',
    });
    pane.addButton({ title: 'Set position' }).on('click', () => {
      const { x, y, z } = physRigidBody.pos;
      const next = { x: rigidBody.position.x, y: rigidBody.position.y, z: rigidBody.position.z };
      physRigidBody.setTranslation(new THREE.Vector3(next.x, next.y, next.z), true);
      recordCharacterPose(character.id, 'position', { x, y, z }, next);
    });
    pane.addButton({ title: 'Update position input' }).on('click', () => {
      rigidBody.position = physRigidBody.pos;
      positionInput.refresh();
    });
    pane.addBlade({ view: 'separator' });
    // Rotation
    const rotationInput = pane.addBinding(rigidBody, 'rotation', {
      label: 'Rotation',
      step: Math.PI / 8,
    });
    pane.addButton({ title: 'Set rotation' }).on('click', () => {
      const { x, y, z, w } = physRigidBody.rot;
      const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rigidBody.rotation.x, rigidBody.rotation.y, rigidBody.rotation.z)
      );
      physRigidBody.setRotation(quat, true);
      recordCharacterPose(
        character.id,
        'rotation',
        { x, y, z, w },
        { x: quat.x, y: quat.y, z: quat.z, w: quat.w }
      );
    });
    pane.addButton({ title: 'Update rotation input' }).on('click', () => {
      rigidBody.rotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          physRigidBody.rot.x,
          physRigidBody.rot.y,
          physRigidBody.rot.z,
          physRigidBody.rot.w
        )
      );
      rotationInput.refresh();
    });
  }

  return windowCmp;
};

const getCharactersListData = (): DebuggerListItem[] =>
  getCharacters().map((character) => ({
    itemId: character.id,
    title: character.name || `[${character.id}]`,
    subTitle: `[${character.id}]`,
    toggleValues: [isCharacterGizmosPinned(character.id)],
  }));

registerDraggableWindowKind(CHAR_EDIT_WIN_ID, {
  content: createEditCharacterContent,
  onClose: refreshCharactersList,
  // Kept open on a scene change when the next scene has a character with the same id
  sceneTargetResolver: (data) => Boolean(getCharacterById(String(data?.id))),
});

/** List row click: opens the character's window, brings it to the front, or closes it when on
 * top. */
const toggleEditCharacterWindow = (charId: string) => {
  const character = getCharacterById(charId);
  if (!character) return;
  toggleDraggableWindow({
    id: getEditWindowId(character.id),
    kind: CHAR_EDIT_WIN_ID,
    position: { x: 110, y: 60 },
    size: { w: 400, h: 400 },
    saveToLS: true,
    title: `Edit character: ${character.name || `[${character.id}]`}`,
    isDebugWindow: true,
    data: { id: character.id },
    closeOnSceneChange: true,
  });
};

// The profiler's heaviest objects open a character's window (before the physics entity one)
registerEntityWindowOpener({
  id: 'character',
  label: 'Edit character',
  priority: 10,
  canOpen: (world, entityId) => Boolean(world.getComponent(entityId, ComponentType.CHARACTER)),
  toggle: (world, entityId) => {
    const character = world.getComponent(entityId, ComponentType.CHARACTER);
    if (character) toggleEditCharacterWindow(character.id);
  },
});

// Clear LS

const CLEARED_NOTE =
  'The live values stay as they are: the code values return the next time each character is created.';

/** Clears the characters' saved config values (the state windows' edits). With more than one
 * scene's, asks which. */
const createClearSavedConfigButton = () =>
  createClearListLSButton({
    hasData: () => getSceneIdsWithSavedConfig().length > 0,
    watchKey: CHAR_CONFIG_LS_KEY,
    onClear: () => {
      const sceneIds = getSceneIdsWithSavedConfig();
      const clear = (ids: string[]) => {
        clearSavedConfigScenes(ids);
        addDebugToast({ title: 'Saved character values cleared', message: CLEARED_NOTE });
      };
      if (sceneIds.length > 1) {
        confirmClearScope({
          onClearAllScenes: () => clear(sceneIds),
          onClearThisScene: () => {
            const sceneId = getCurrentSceneId();
            if (sceneId) clear([sceneId]);
          },
          note: CLEARED_NOTE,
        });
      } else {
        clear(sceneIds);
      }
    },
  });

export const _createCharactersDebuggerGUI = () => {
  if (!IS_DEBUG_ENV) return;
  createDebuggerTab({
    id: CHARACTERS_TAB_ID,
    title: 'Character controls',
    icon: 'personArmsUp',
    // The tab has no data of its own (its button stays disabled, kept for consistency); the
    // list's button clears the characters' saved config values (scene-scoped, module-owned)
    clearLSButton: true,
    headerButtons: () => [createClearSavedConfigButton()],
    content: () => [
      debuggerListCMP({
        id: 'characters',
        emptyText: 'No characters registered to this scene..',
        data: getCharactersListData,
        selectedItemId: () =>
          getDraggableWindowsOfKind(CHAR_EDIT_WIN_ID).map((win) => String(win.data?.id)),
        perItemConfig: {
          onClick: toggleEditCharacterWindow,
          toggles: [
            {
              icon: 'pin',
              title:
                "Pin the character's debug gizmos: they stay after its state window closes (session only)",
              fn: setCharacterGizmosPinned,
            },
          ],
        },
      }),
    ],
  });

  setTimeout(() => {
    _updateCharactersDebuggerGUI();
  }, 0);
};

export const _updateCharactersDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!IS_DEBUG_ENV) return;
  // A character created under a pinned id (eg. a respawn) gets its gizmos back
  syncCharacterGizmoPins();
  if (only !== 'WINDOW') refreshCharactersList();
  if (only === 'LIST') return;
  // An edit window whose character is gone closes itself; a state window stays (a character
  // created again under its id, eg. a respawn, shows up in it)
  updateDraggableWindowsOfKind(CHAR_EDIT_WIN_ID);
  updateDraggableWindowsOfKind(CHAR_STATE_WIN_ID);
};
