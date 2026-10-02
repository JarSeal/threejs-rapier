import * as THREE from 'three/webgpu';
import {
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
} from '../../debug/DebuggerGUI';
import { CMP, type TCMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  getDraggableWindowsStartingWith,
  openDraggableWindow,
  registerDraggableWindowCmp,
  updateDraggableWindow,
} from '../UI/DraggableWindow';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { Pane } from 'tweakpane';
import { llog, lwarn } from '../../utils/Logger';
import { deleteCharacter, getCharacterById, getCharacters } from '../Character';
import { getECSWorld } from '../ECS';
import { createClearListLSButton } from './_dbg__ClearLSButtons';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';
import {
  _openCharacterStateWindow,
  _registerCharacterStateWindowCmp,
  CHAR_STATE_WIN_ID,
  getCharacterStateWindowId,
} from './Character/_dbg__CharacterStateWindow';
import {
  isCharacterGizmosPinned,
  onCharacterGizmoPinsChange,
  setCharacterGizmosPinned,
  syncCharacterGizmoPins,
} from './Character/_dbg__CharacterGizmos';

const CHARACTERS_TAB_ID = 'charactersControls';
const debuggerWindowCmp: { [id: string]: TCMP } = {};
const debuggerWindowPane: { [id: string]: Pane } = {};
const CHAR_EDIT_WIN_ID = 'characterEditorWindow';

const getEditWindowId = (charId: string) => `${CHAR_EDIT_WIN_ID}_${charId}`;
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
  const d = data as { id: string; winId: string };
  const character = getCharacterById(d.id);
  if (debuggerWindowPane[d.id]) {
    debuggerWindowPane[d.id].dispose();
    delete debuggerWindowPane[d.id];
  }
  if (debuggerWindowCmp[d.id]) {
    debuggerWindowCmp[d.id].remove();
    delete debuggerWindowCmp[d.id];
  }
  if (!character) {
    // We want to close the window when no character is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => {
      closeDraggableWindow(getEditWindowId(d.id));
    }, 0);
    return CMP();
  }

  addOnCloseToWindow(getEditWindowId(d.id), refreshCharactersList);
  // The content is built before the window state is open: refresh the list selection after it
  queueMicrotask(refreshCharactersList);

  debuggerWindowCmp[d.id] = CMP({
    onRemoveCmp: () => delete debuggerWindowPane[d.id],
  });

  debuggerWindowPane[d.id] = new Pane({ container: debuggerWindowCmp[d.id].elem });

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

  debuggerWindowCmp[d.id].add({
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
  if (!physRigidBody) return debuggerWindowCmp[d.id];

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
    const positionInput = debuggerWindowPane[d.id].addBinding(rigidBody, 'position', {
      label: 'Position',
    });
    debuggerWindowPane[d.id].addButton({ title: 'Set position' }).on('click', () => {
      const { x, y, z } = physRigidBody.pos;
      const next = { x: rigidBody.position.x, y: rigidBody.position.y, z: rigidBody.position.z };
      physRigidBody.setTranslation(new THREE.Vector3(next.x, next.y, next.z), true);
      recordCharacterPose(character.id, 'position', { x, y, z }, next);
    });
    debuggerWindowPane[d.id].addButton({ title: 'Update position input' }).on('click', () => {
      rigidBody.position = physRigidBody.pos;
      positionInput.refresh();
    });
    debuggerWindowPane[d.id].addBlade({ view: 'separator' });
    // Rotation
    const rotationInput = debuggerWindowPane[d.id].addBinding(rigidBody, 'rotation', {
      label: 'Rotation',
      step: Math.PI / 8,
    });
    debuggerWindowPane[d.id].addButton({ title: 'Set rotation' }).on('click', () => {
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
    debuggerWindowPane[d.id].addButton({ title: 'Update rotation input' }).on('click', () => {
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

  return debuggerWindowCmp[d.id];
};

const getCharactersListData = (): DebuggerListItem[] =>
  getCharacters().map((character) => ({
    itemId: character.id,
    title: character.name || `[${character.id}]`,
    subTitle: `[${character.id}]`,
    toggleValues: [isCharacterGizmosPinned(character.id)],
  }));

const toggleEditCharacterWindow = (charId: string) => {
  const character = getCharacterById(charId);
  if (!character) return;
  const winId = getEditWindowId(character.id);
  const winState = getDraggableWindow(winId);
  if (winState?.isOpen && winState?.data?.id === charId) {
    closeDraggableWindow(winId);
    return;
  }
  openDraggableWindow({
    id: winId,
    position: { x: 110, y: 60 },
    size: { w: 400, h: 400 },
    saveToLS: true,
    title: `Edit character: ${character.name || `[${character.id}]`}`,
    isDebugWindow: true,
    content: createEditCharacterContent,
    data: { id: character.id, CHAR_EDIT_WIN_ID: winId },
    removeOnSceneChange: true, // @TODO: This is the only way to get the character window to work properly after scene change (and coming back), fix this
    onClose: refreshCharactersList,
  });
};

export const _createCharactersDebuggerGUI = () => {
  if (!IS_DEBUG_ENV) return;
  createDebuggerTab({
    id: CHARACTERS_TAB_ID,
    title: 'Character controls',
    icon: 'personArmsUp',
    // No LS key exists for character data today (see §2.1/§3.1 of the clear-LS-buttons
    // plan) - both buttons exist for consistency with every other list tab, but stay
    // permanently disabled until character data persistence is ever added.
    clearLSButton: true,
    headerButtons: () => [createClearListLSButton({ hasData: () => false, onClear: () => {} })],
    content: () => [
      debuggerListCMP({
        id: 'characters',
        emptyText: 'No characters registered to this scene..',
        data: getCharactersListData,
        selectedItemId: () =>
          getCharacters()
            .map((character) => character.id)
            .filter((charId) => getDraggableWindow(getEditWindowId(charId))?.isOpen),
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
  const winStates = [
    ...getDraggableWindowsStartingWith(CHAR_EDIT_WIN_ID),
    ...getDraggableWindowsStartingWith(CHAR_STATE_WIN_ID),
  ];
  for (let i = 0; i < winStates.length; i++) {
    const winState = winStates[i];
    if (winState) {
      if (!winState.content) {
        if (winState.id?.startsWith(CHAR_EDIT_WIN_ID)) {
          registerDraggableWindowCmp(winState.id, {
            content: createEditCharacterContent,
            onClose: refreshCharactersList,
          });
        } else if (winState.id?.startsWith(CHAR_STATE_WIN_ID)) {
          _registerCharacterStateWindowCmp(winState.id);
        }
      }
      updateDraggableWindow(winState.id);
    }
  }
};
