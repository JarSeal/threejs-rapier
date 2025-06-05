import * as THREE from 'three/webgpu';
import {
  createPhysicsObjectWithMesh,
  deletePhysicsObject,
  getPhysicsObject,
  PhysicsParams,
} from './PhysicsRapier';
import { lerror, llog } from '../utils/Logger';
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

export type CharacterObject = {
  id: string;
  name?: string;
  physObjectId: string;
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
 * @param physicsParamas (PhysicsParams) ({@link PhysicsParams})
 * @param meshOrMeshId (THREE.Mesh | string) mesh or mesh id of the representation of the physics object
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
    name,
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
const WIN_ID = 'characterEditorWindow';

export const createEditCameraContent = (data?: { [key: string]: unknown }) => {
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
    // We want to close the window, but we have to return first, so wait one iteration
    setTimeout(() => {
      closeDraggableWindow(WIN_ID);
    }, 0);
    return CMP();
  }

  addOnCloseToWindow(WIN_ID, () => {
    updateDebuggerCharactersListSelectedClass('');
  });
  updateDebuggerCharactersListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    onRemoveCmp: () => (debuggerWindowPane = null),
  });

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  //   const copyCodeButton = CMP({
  //     class: 'winSmallIconButton',
  //     html: () => `<button title="Copy character creation script">${getSvgIcon('fileCode')}</button>`,
  //     onClick: () => {
  //       let paramsString = '';
  //       paramsString = `{
  //     id: ${character.id},${character.name ? `\n    name: '${character.name}',` : ''}
  //     physicsParams: ${JSON.stringify(character.physicsParams)},
  //     meshOrMeshId,
  //     controls,
  //     sceneId,
  //     noWarnForUnitializedScene,
  //     data = {},
  //     isCurrentCamera: false,
  //   }`;
  //       const createScript = `createCharacter(
  //   ${paramsString}
  // );`;
  //       llog(createScript);
  //       navigator.clipboard.writeText(createScript);
  //       // @TODO: add toast that the script has been copied
  //     },
  //   });
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this camera to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('CHARACTER:***************', character, '**********************');
    },
  });
  // const cameraState = lsGetItem(LS_KEY, {})[camera.userData.id];
  // const lsIsEmpty =
  //   !cameraState ||
  //   (cameraState && Object.keys(cameraState).length === 1 && cameraState.saveToLS === false);
  // clearLSButton = CMP({
  //   class: 'winSmallIconButton',
  //   html: () =>
  //     `<button title="Clear Local Storage params for this light">${getSvgIcon('databaseX')}</button>`,
  //   attr: lsIsEmpty ? { disabled: 'true' } : {},
  //   onClick: () => {
  //     const state = lsGetItem(LS_KEY, {});
  //     delete state[camera.userData.id];
  //     lsSetItem(LS_KEY, state);
  //     updateCamerasDebuggerGUI('WINDOW');
  //     // @TODO: add toast to tell that the Local Storage has been cleared for this light
  //   },
  // });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Remove character (only for this browser load, does not delete character permanently)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      deleteCharacter(character.id);
      closeDraggableWindow(WIN_ID);
    },
  });

  debuggerWindowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Name:</span> ${character.name || ''}</div>
  <div><span class="winSmallLabel">Id:</span> ${character.id}</div>
</div>
<div style="text-align:right">${logButton}${deleteButton}</div>
</div>`,
  });

  const physObject = getPhysicsObject(character.physObjectId);
  if (!physObject) return debuggerWindowCmp;

  if (physObject.rigidBody) {
    const rigidBody = { position: physObject.rigidBody.translation() };
    debuggerWindowPane
      .addBinding(rigidBody, 'position', { label: 'Position' })
      .on('change', (e) => {
        physObject.rigidBody?.setTranslation(
          new THREE.Vector3(e.value.x, e.value.y, e.value.z),
          true
        );
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
        const winState = getDraggableWindow(WIN_ID);
        if (winState?.isOpen && winState?.data?.id === keys[i]) {
          closeDraggableWindow(WIN_ID);
          return;
        }
        openDraggableWindow({
          id: WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit character: ${character.name || `[${character.id}]`}`,
          isDebugWindow: true,
          content: createEditCameraContent,
          data: { id: character.id, WIN_ID },
          closeOnSceneChange: true,
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
      const winState = getDraggableWindow(WIN_ID);
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
  const winState = getDraggableWindow(WIN_ID);
  if (winState) updateDraggableWindow(WIN_ID);
};

export const updateDebuggerCharactersListSelectedClass = (id: string) => {
  const ulElem = debuggerListCmp?.elem;
  if (!ulElem) return;

  for (const child of ulElem.children) {
    const elemId = child.getAttribute('data-id');
    if (elemId === id) {
      child.classList.add('selected');
      continue;
    }
    child.classList.remove('selected');
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
