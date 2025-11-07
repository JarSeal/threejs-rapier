import * as THREE from 'three/webgpu';
import {
  createPhysicsObjectWithMesh,
  deletePhysicsObject,
  getPhysicsObject,
  PhysicsParams,
} from './PhysicsRapier';
import { llog } from '../utils/Logger';
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
import { CMP, TCMP } from '../utils/CMP';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerContainer } from '../debug/DebuggerGUI';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  updateDraggableWindow,
} from './UI/DraggableWindow';
import { isDebugEnvironment } from './Config';
import { Pane } from 'tweakpane';
import { createSceneAppLooper, deleteSceneAppLooper } from './Scene';

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
 * @param physicsParamas (PhysicsParams | PhysicsParams[]) ({@link PhysicsParams}) if array then the physics object is a multi object
 * @param meshOrMeshId ((THREE.Mesh | string) | (THREE.Mesh | string)[]) mesh or mesh id (or array of either of them) of the representation of the physics object
 * @param controls (array of KeyInputParams and/or MouseInputParams) the input control params for this character
 * @param sceneId (string) optional scene id where the physics object should be mapped to, if not provided the current scene id will be used
 * @param noWarnForUnitializedScene (boolean) optional value to suppress logger warning for unitialized scene (true = no warning, default = false)
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
    `Could not create character with id "${id}" in CharacterController createCharacter. Physics params: ${JSON.stringify(physicsParams)} -- Mesh params: ${JSON.stringify(physicsParams)} -- Scene id: ${sceneId}`
  );
  if (!physObj.id) physObj.id = id;

  let meshIds: string | string[] = '';
  let mesh: THREE.Mesh | null = null;
  if (typeof meshOrMeshId === 'string') {
    meshIds = meshOrMeshId;
    mesh = getMesh(meshIds);
    existsOrThrow(mesh, `Mesh not found with id '${meshIds}' in createCharacter.`);
    mesh.userData.isCharacter = true;
  } else if (Array.isArray(meshOrMeshId)) {
    meshIds = [];
    for (let i = 0; i < meshOrMeshId.length; i++) {
      const m = meshOrMeshId[i];
      if (typeof m === 'string') {
        (meshIds as string[]).push(m);
        mesh = getMesh(m);
        existsOrThrow(mesh, `Mesh not found with id '${m}' in createCharacter.`);
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

  // Delete physic objects
  for (let i = 0; i < charObj.physObjectId.length; i++) {
    deletePhysicsObject(charObj.physObjectId[i]);
  }

  // Remove mesh from the scene
  if (Array.isArray(charObj.meshId)) {
    for (let i = 0; i < charObj.meshId.length; i++) {
      const mesh = getMesh(charObj.meshId[i]);
      if (mesh) mesh.removeFromParent();
    }
  } else {
    const mesh = getMesh(charObj.meshId);
    if (mesh) mesh.removeFromParent();
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

// Debugger stuff for characters
// *****************************

let debuggerListCmp: TCMP | null = null;
let debuggerWindowCmp: TCMP | null = null;
let debuggerWindowPane: Pane | null = null;
let debuggerTrackerWindowCmp: TCMP | null = null;
let trackCharLoopIndex = -1;
export const CHAR_EDIT_WIN_ID = 'characterEditorWindow';
export const CHAR_TRACKER_WIN_ID = 'characterDataTrackerWindow';

export const createTrackCharacterContent = (winData?: { [key: string]: unknown }) => {
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
    addOnCloseToWindow(CHAR_TRACKER_WIN_ID, () => {
      deleteSceneAppLooper(trackCharLoopIndex);
    });
  }, 200);

  return debuggerTrackerWindowCmp;
};

export const createEditCharacterContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const character = characters[d.id];
  if (debuggerWindowPane) {
    debuggerWindowPane.dispose();
    debuggerWindowPane = null;
  }
  if (debuggerWindowCmp) {
    debuggerWindowCmp.remove();
    debuggerWindowCmp = null;
  }
  if (!character) {
    // We want to close the window when no character is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => {
      closeDraggableWindow(CHAR_EDIT_WIN_ID);
    }, 0);
    return CMP();
  }

  addOnCloseToWindow(CHAR_EDIT_WIN_ID, () => {
    updateDebuggerCharactersListSelectedClass('');
  });
  updateDebuggerCharactersListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    onRemoveCmp: () => (debuggerWindowPane = null),
  });

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  // @NOTE: The copy code button is not that easy to implement here
  // because the character object only has references to the mesh and phys objects,
  // and also controls (especially these would be hard to print).
  const openCharacterDataButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Open character data tracker">${getSvgIcon('personArmsUp')}</button>`,
    onClick: () => {
      openDraggableWindow({
        id: CHAR_TRACKER_WIN_ID,
        position: { x: 130, y: 80 },
        size: { w: 400, h: 400 },
        saveToLS: true,
        title: `Character data: ${character.name || `[${character.id}]`}`,
        isDebugWindow: true,
        content: createTrackCharacterContent,
        data: { id: character.id, winId: CHAR_TRACKER_WIN_ID },
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
      deleteCharacter(character.id);
      closeDraggableWindow(CHAR_EDIT_WIN_ID);
      closeDraggableWindow(CHAR_TRACKER_WIN_ID);
    },
  });

  debuggerWindowCmp.add({
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
  if (!physObject) return debuggerWindowCmp;

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
    const positionInput = debuggerWindowPane.addBinding(rigidBody, 'position', {
      label: 'Position',
    });
    debuggerWindowPane.addButton({ title: 'Set position' }).on('click', () => {
      physObject.rigidBody?.setTranslation(
        new THREE.Vector3(rigidBody.position.x, rigidBody.position.y, rigidBody.position.z),
        true
      );
    });
    debuggerWindowPane.addButton({ title: 'Update position input' }).on('click', () => {
      rigidBody.position = physObject.rigidBody?.translation() || rigidBody.position;
      positionInput.refresh();
    });
    debuggerWindowPane.addBlade({ view: 'separator' });
    // Rotation
    const rotationInput = debuggerWindowPane.addBinding(rigidBody, 'rotation', {
      label: 'Rotation',
      step: Math.PI / 8,
    });
    debuggerWindowPane.addButton({ title: 'Set rotation' }).on('click', () => {
      physObject.rigidBody?.setRotation(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rigidBody.rotation.x, rigidBody.rotation.y, rigidBody.rotation.z)
        ),
        true
      );
    });
    debuggerWindowPane.addButton({ title: 'Update rotation input' }).on('click', () => {
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

  return debuggerWindowCmp;
};

const createCharactersDebuggerList = () => {
  const keys = Object.keys(characters);
  let html = '<ul class="ulList">';

  for (let i = 0; i < keys.length; i++) {
    const character = characters[keys[i]];
    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(CHAR_EDIT_WIN_ID);
        if (winState?.isOpen && winState?.data?.id === keys[i]) {
          closeDraggableWindow(CHAR_EDIT_WIN_ID);
          return;
        }
        openDraggableWindow({
          id: CHAR_EDIT_WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit character: ${character.name || `[${character.id}]`}`,
          isDebugWindow: true,
          content: createEditCharacterContent,
          data: { id: character.id, CHAR_EDIT_WIN_ID },
          removeOnSceneChange: true, // @TODO: This is the only way to get the character window to work properly after scene change (and coming back), fix this
          onClose: () => updateDebuggerCharactersListSelectedClass(null),
        });
        updateDebuggerCharactersListSelectedClass(keys[i]);
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

export const createCharactersDebuggerGUI = () => {
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
      const winState = getDraggableWindow(CHAR_EDIT_WIN_ID);
      if (winState?.isOpen && winState.data?.id) {
        const id = (winState.data as { id: string }).id;
        updateDebuggerCharactersListSelectedClass(id);
      }
      return container;
    },
  });
};

export const updateCharactersDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!isDebugEnvironment()) return;
  if (only !== 'WINDOW') debuggerListCmp?.update({ html: createCharactersDebuggerList });
  if (only === 'LIST') return;
  const winState = getDraggableWindow(CHAR_EDIT_WIN_ID);
  if (winState) updateDraggableWindow(CHAR_EDIT_WIN_ID);
};

export const updateDebuggerCharactersListSelectedClass = (id: string | null) => {
  const ulElem = debuggerListCmp?.elem;
  if (!ulElem) return;

  for (const child of ulElem.children) {
    child.classList.remove('selected');
    if (id === null) continue;
    const elemId = child.getAttribute('data-id');
    if (elemId === id) child.classList.add('selected');
  }
};

// export const mergeCameraDataFromLS = (id: string | undefined) => {
//   if (!isDebugEnvironment() || !id) return;

//   const curState = lsGetItem(LS_KEY, {});
//   if (!id || !curState[id]) return;

//   const state = curState[id];
//   const camera = cameras[id];

//   if (state.saveToLS !== undefined) camera.userData.saveToLS = state.saveToLS;
//   if (state.showHelper !== undefined) camera.userData.showHelper = state.showHelper;
//   if (state.position) camera.position.set(state.position.x, state.position.y, state.position.z);
//   if (state.cameraNear !== undefined) camera.near = state.cameraNear;
//   if (state.cameraFar !== undefined) camera.far = state.cameraFar;
// };
