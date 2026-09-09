import * as THREE from 'three/webgpu';
import { createDebuggerTab, createNewDebuggerContainer } from '../../debug/DebuggerGUI';
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
import { createSceneAppLooper, deleteSceneAppLooper } from '../Scene';
import { llog } from '../../utils/Logger';
import { deleteCharacter, getCharacterById, getCharacters } from '../Character';
import { getPhysicsObject } from '../PhysicsRapier';

let debuggerListCmp: TCMP | null = null;
const debuggerWindowCmp: { [id: string]: TCMP } = {};
const debuggerWindowPane: { [id: string]: Pane } = {};
let debuggerTrackerWindowCmp: TCMP | null = null;
let trackCharLoopIndex = -1;
const CHAR_EDIT_WIN_ID = 'characterEditorWindow';
const CHAR_TRACKER_WIN_ID = 'characterDataTrackerWindow';

const getEditWindowId = (charId: string) => `${CHAR_EDIT_WIN_ID}_${charId}`;
const getTrackerWindowId = (charId: string) => `${CHAR_TRACKER_WIN_ID}_${charId}`;

const createTrackCharacterContent = (winData?: { [key: string]: unknown }) => {
  const characters = getCharacters();
  const TRACKER_UPDATE_INTERVAL = 0.0000001;
  const d = winData as { id: string; winId: string };
  debuggerTrackerWindowCmp = CMP();
  debuggerTrackerWindowCmp.add({ text: `Update interval: ${TRACKER_UPDATE_INTERVAL}` }); // @TODO: add Pane and input to set TRACKER_UPDATE_INTERVAL
  const trackerContainer = debuggerTrackerWindowCmp.add({
    html: () => {
      const character = characters[d.id];
      if (!character?.data) return '';
      const data = character.data;
      const keys = data ? Object.keys(data) : [];
      let htmlString = '<ul>';
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = data[key];
        if (Array.isArray(value)) {
          htmlString += `<li>${key}: ${value.join(', ')}</li>`;
        } else if (typeof value === 'object' && value !== null) {
          const objKeys = Object.keys(value);
          let objString = '';
          for (let j = 0; j < objKeys.length; j++) {
            objString += `<li>${objKeys[j]}: ${(value as { [key: string]: unknown })[objKeys[j]]}</li>`;
          }
          htmlString += `<li>${key}:<ul>${objString}</ul></li>`;
        } else {
          htmlString += `<li>${key}: ${value}</li>`;
        }
      }
      htmlString += '</ul>';
      return htmlString;
    },
  });

  let trackerUpdateAccTime = 0;
  trackCharLoopIndex = createSceneAppLooper((delta) => {
    trackerUpdateAccTime += delta;
    if (trackerUpdateAccTime > TRACKER_UPDATE_INTERVAL && characters[d.id]) {
      trackerContainer.update();
      trackerUpdateAccTime = 0;
    }
  });

  // @TODO: at some point fix the onClose registering (this is a hack to get it working)
  setTimeout(() => {
    addOnCloseToWindow(getTrackerWindowId(d.id), () => {
      deleteSceneAppLooper(trackCharLoopIndex);
    });
  }, 200);

  return debuggerTrackerWindowCmp;
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

  addOnCloseToWindow(getEditWindowId(d.id), () => {
    _updateDebuggerCharactersListSelectedClass();
  });
  _updateDebuggerCharactersListSelectedClass();

  debuggerWindowCmp[d.id] = CMP({
    onRemoveCmp: () => delete debuggerWindowPane[d.id],
  });

  debuggerWindowPane[d.id] = new Pane({ container: debuggerWindowCmp[d.id].elem });

  // @NOTE: The copy code button is not that easy to implement here
  // because the character object only has references to the mesh and phys objects,
  // and also controls (especially these would be hard to print).
  const openCharacterDataButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Open character data tracker">${getSvgIcon('personArmsUp')}</button>`,
    onClick: () => {
      openDraggableWindow({
        id: getTrackerWindowId(d.id),
        position: { x: 130, y: 80 },
        size: { w: 400, h: 400 },
        saveToLS: true,
        title: `Character data: ${character.name || `[${character.id}]`}`,
        isDebugWindow: true,
        content: createTrackCharacterContent,
        data: { id: character.id, winId: getTrackerWindowId(d.id) },
        closeOnSceneChange: true,
        removeOnClose: true, // @TODO: Without this the tracker won't work on the second time opening it. Fix this at some point in the DraggableWindow.
      });
    },
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
      closeDraggableWindow(getTrackerWindowId(d.id));
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
  <div><span class="winSmallLabel">Physics object id:</span> ${character.physObjectId}</div>
  ${
    Array.isArray(character.meshId)
      ? `<div><span class="winSmallLabel">Mesh ids:</span> ${character.meshId.join(', ')}</div>`
      : `<div><span class="winSmallLabel">Mesh id:</span> ${character.meshId}</div>`
  }
  <div><span class="winSmallLabel">Key control ids:</span> ${character.keyControlIds.length ? character.keyControlIds.join(', ') : ''}</div>
  <div><span class="winSmallLabel">Mouse control ids:</span> ${character.mouseControlIds.length ? character.mouseControlIds.join(', ') : ''}</div>
</div>
<div style="text-align:right">${openCharacterDataButton}${logButton}${deleteButton}</div>
</div>`,
  });

  const physObject = getPhysicsObject(character.physObjectId);
  if (!physObject) return debuggerWindowCmp[d.id];

  if (physObject.rigidBody) {
    const rigidBody = {
      position: physObject.rigidBody.translation(),
      rotation: new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          physObject.rigidBody.rotation().x,
          physObject.rigidBody.rotation().y,
          physObject.rigidBody.rotation().z,
          physObject.rigidBody.rotation().w
        )
      ),
    };
    // Position
    const positionInput = debuggerWindowPane[d.id].addBinding(rigidBody, 'position', {
      label: 'Position',
    });
    debuggerWindowPane[d.id].addButton({ title: 'Set position' }).on('click', () => {
      physObject.rigidBody?.setTranslation(
        new THREE.Vector3(rigidBody.position.x, rigidBody.position.y, rigidBody.position.z),
        true
      );
    });
    debuggerWindowPane[d.id].addButton({ title: 'Update position input' }).on('click', () => {
      rigidBody.position = physObject.rigidBody?.translation() || rigidBody.position;
      positionInput.refresh();
    });
    debuggerWindowPane[d.id].addBlade({ view: 'separator' });
    // Rotation
    const rotationInput = debuggerWindowPane[d.id].addBinding(rigidBody, 'rotation', {
      label: 'Rotation',
      step: Math.PI / 8,
    });
    debuggerWindowPane[d.id].addButton({ title: 'Set rotation' }).on('click', () => {
      physObject.rigidBody?.setRotation(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rigidBody.rotation.x, rigidBody.rotation.y, rigidBody.rotation.z)
        ),
        true
      );
    });
    debuggerWindowPane[d.id].addButton({ title: 'Update rotation input' }).on('click', () => {
      rigidBody.rotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          physObject.rigidBody?.rotation().x,
          physObject.rigidBody?.rotation().y,
          physObject.rigidBody?.rotation().z,
          physObject.rigidBody?.rotation().w
        )
      );
      rotationInput.refresh();
    });
  }

  return debuggerWindowCmp[d.id];
};

const createCharactersDebuggerList = () => {
  const characters = getCharacters();
  const keys = Object.keys(characters);
  let html = '<ul class="ulList">';

  for (let i = 0; i < keys.length; i++) {
    const character = characters[keys[i]];
    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(getEditWindowId(character.id));
        if (winState?.isOpen && winState?.data?.id === keys[i]) {
          closeDraggableWindow(getEditWindowId(character.id));
          return;
        }
        openDraggableWindow({
          id: getEditWindowId(character.id),
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit character: ${character.name || `[${character.id}]`}`,
          isDebugWindow: true,
          content: createEditCharacterContent,
          data: { id: character.id, CHAR_EDIT_WIN_ID: getEditWindowId(character.id) },
          removeOnSceneChange: true, // @TODO: This is the only way to get the character window to work properly after scene change (and coming back), fix this
          onClose: _updateDebuggerCharactersListSelectedClass,
        });
        _updateDebuggerCharactersListSelectedClass();
      },
      html: `<button class="listItemWithId">
  <span class="itemId">[${character.id}]</span>
  <h4>${character.name || `[${character.id}]`}</h4>
</button>`,
    });

    html += `<li data-id="${keys[i]}">${button}</li>`;
  }

  if (!keys.length) html += `<li class="emptyState">No characters registered to this scene..</li>`;

  html += '</ul>';
  return html;
};

export const _createCharactersDebuggerGUI = () => {
  if (!IS_DEBUG_ENV) return;
  const icon = getSvgIcon('personArmsUp');
  createDebuggerTab({
    id: 'charactersControls',
    buttonText: icon,
    title: 'Character controls',
    orderNr: 14,
    container: () => {
      const container = createNewDebuggerContainer(
        'debuggerCharacters',
        `${icon} Character Controls`
      );
      debuggerListCmp = CMP({ id: 'debuggerCharactersList', html: createCharactersDebuggerList });
      container.add(debuggerListCmp);
      const winStates = getDraggableWindowsStartingWith(CHAR_EDIT_WIN_ID);
      for (let i = 0; i < winStates.length; i++) {
        const winState = winStates[i];
        if (winState?.isOpen) {
          _updateDebuggerCharactersListSelectedClass();
        }
      }
      return container;
    },
  });

  setTimeout(() => {
    _updateCharactersDebuggerGUI();
  }, 0);
};

export const _updateCharactersDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!IS_DEBUG_ENV) return;
  if (only !== 'WINDOW') debuggerListCmp?.update({ html: createCharactersDebuggerList });
  if (only === 'LIST') return;
  const winStates = [
    ...getDraggableWindowsStartingWith(CHAR_EDIT_WIN_ID),
    ...getDraggableWindowsStartingWith(CHAR_TRACKER_WIN_ID),
  ];
  for (let i = 0; i < winStates.length; i++) {
    const winState = winStates[i];
    if (winState) {
      if (!winState.content) {
        if (winState.id?.startsWith(CHAR_EDIT_WIN_ID)) {
          registerDraggableWindowCmp(winState.id, {
            content: createEditCharacterContent,
            onClose: _updateDebuggerCharactersListSelectedClass,
          });
        } else if (winState.id?.startsWith(CHAR_TRACKER_WIN_ID)) {
          registerDraggableWindowCmp(winState.id, {
            content: createTrackCharacterContent,
            onClose: _updateDebuggerCharactersListSelectedClass,
          });
        }
      }
      updateDraggableWindow(winState.id);
    }
  }
};

export const _updateDebuggerCharactersListSelectedClass = () => {
  if (!IS_DEBUG_ENV) return;
  const ulElem = debuggerListCmp?.elem;
  if (!ulElem) return;

  for (const child of ulElem.children) {
    child.classList.remove('selected');
  }

  for (const child of ulElem.children) {
    const elemId = child.getAttribute('data-id');
    if (!elemId) continue;
    const winState = getDraggableWindow(getEditWindowId(elemId));
    if (winState?.isOpen) child.classList.add('selected');
  }
};
