import { lerror, lwarn } from '../utils/Logger';
import { getCurrentSceneId } from './Scene';

export type InputControlType =
  | 'KEY_UP'
  | 'KEY_DOWN'
  | 'MOUSE_UP'
  | 'MOUSE_DOWN'
  | 'MOUSE_MOVE'
  | 'CONTROLLER';

type KeyMapping = {
  id?: string;
  key?: string;
  fn: (e: KeyboardEvent, pressedTime: number) => void;
  time?: number;
};

const initiatedControlTypes = {
  keyUpControls: false,
  keyDownControls: false,
  mouseUpControls: false,
  mouseDownControls: false,
  mouseMoveControls: false,
  controllerControls: false,
};
const controlListenerFns: {
  keyUp: null | ((e: KeyboardEvent) => void);
  keyDown: null | ((e: KeyboardEvent) => void);
  mouseUp: null | ((e: MouseEvent) => void);
  mouseDown: null | ((e: MouseEvent) => void);
  mouseMove: null | ((e: MouseEvent) => void);
  controller: null | ((e: unknown) => void); // @TODO: add correct event type for controller event
} = {
  keyUp: null,
  keyDown: null,
  mouseUp: null,
  mouseDown: null,
  mouseMove: null,
  controller: null,
};

let keyUpMappings: KeyMapping[] = [];
let keyDownMappings: KeyMapping[] = [];
let keyUpSceneMappings: { [sceneId: string]: KeyMapping[] } = {};
let keyDownSceneMappings: { [sceneId: string]: KeyMapping[] } = {};

const initKeyUpControls = () => {
  controlListenerFns.keyUp = (e: KeyboardEvent) => {
    const KEY = e.key;
    const timeNow = performance.now();
    for (let i = 0; i < keyUpMappings.length; i++) {
      const mapping = keyUpMappings[i];
      if (KEY === mapping.key || !mapping.key) {
        mapping.fn(e, timeNow - (mapping.time || timeNow));
        mapping.time = 0;
      }
    }
    const sceneId = getCurrentSceneId();
    if (!sceneId) return;
    const sceneKeyUpMappings = keyUpSceneMappings[sceneId];
    if (!sceneKeyUpMappings) return;
    for (let i = 0; i < sceneKeyUpMappings.length; i++) {
      const mapping = sceneKeyUpMappings[i];
      if (KEY === mapping.key || !mapping.key) {
        mapping.fn(e, timeNow - (mapping.time || timeNow));
        mapping.time = 0;
      }
    }
  };
  window.addEventListener('keyup', controlListenerFns.keyUp);
};

const initKeyDownControls = () => {
  controlListenerFns.keyDown = (e: KeyboardEvent) => {
    const KEY = e.key;
    const timeNow = performance.now();
    for (let i = 0; i < keyUpMappings.length; i++) {
      const mapping = keyUpMappings[i];
      if ((KEY === mapping.key || !mapping.key) && !mapping.time) {
        mapping.time = timeNow;
      }
    }
    for (let i = 0; i < keyDownMappings.length; i++) {
      const mapping = keyDownMappings[i];
      if (KEY === mapping.key || !mapping.key) {
        mapping.time = timeNow;
        mapping.fn(e, timeNow);
      }
    }

    const sceneId = getCurrentSceneId();
    if (!sceneId) return;
    const sceneKeyUpMappings = keyUpSceneMappings[sceneId];
    if (sceneKeyUpMappings) {
      for (let i = 0; i < sceneKeyUpMappings.length; i++) {
        const mapping = sceneKeyUpMappings[i];
        if (KEY === mapping.key || !mapping.key) {
          mapping.fn(e, timeNow - (mapping.time || timeNow));
        }
      }
    }
    const sceneKeyDownMappings = keyDownSceneMappings[sceneId];
    if (!sceneKeyDownMappings) return;
    for (let i = 0; i < sceneKeyDownMappings.length; i++) {
      const mapping = sceneKeyDownMappings[i];
      if (KEY === mapping.key || !mapping.key) {
        mapping.fn(e, timeNow - (mapping.time || timeNow));
      }
    }
  };
  window.addEventListener('keydown', controlListenerFns.keyDown);
};

export const addKeyInputControl = ({
  id,
  type,
  key,
  fn,
  sceneId,
}: {
  id?: string;
  type: InputControlType;
  key: string;
  fn: (e: KeyboardEvent, time: number) => void;
  sceneId?: string;
}) => {
  switch (type) {
    case 'KEY_UP':
      const idTaken =
        id &&
        (keyUpMappings.find((mapping) => mapping.id === id) ||
          (sceneId && keyUpSceneMappings[sceneId].find((mapping) => mapping.id === id)));
      if (idTaken) {
        const msg = `Key input control id already taken (id: ${id}), could not add key control. Remove the old control with the same id first before adding it (the id has to be unique, no matter if the id is global or scene related).`;
        lerror(msg);
        return;
      }
      if (!initiatedControlTypes.keyUpControls) {
        initKeyUpControls();
        initiatedControlTypes.keyUpControls = true;
      }
      if (!initiatedControlTypes.keyDownControls) {
        initKeyDownControls();
        initiatedControlTypes.keyDownControls = true;
      }
      if (sceneId) {
        if (!keyUpSceneMappings[sceneId]) keyUpSceneMappings[sceneId] = [];
        keyUpSceneMappings[sceneId].push({ key, fn, time: 0, ...(id ? { id } : {}) });
      } else {
        keyUpMappings.push({ key, fn, time: 0, ...(id ? { id } : {}) });
      }
      break;
    default:
      lwarn(`${type} controls are not yet implemented.`);
      break;
  }
};

/**
 * Removes a key input control by id or key (one is required). Also the scene id and/or type can be provided. If no type is provided, then all types will be removed.
 * @param params (object) { id?: string, key?: string, sceneId?: string, type?: 'KEY_UP' | 'KEY_DOWN' }
 */
export const removeKeyInputControl = ({
  id,
  key,
  sceneId,
  type,
}: {
  id?: string;
  key?: string;
  sceneId?: string;
  type?: 'KEY_UP' | 'KEY_DOWN';
}) => {
  if (!id && !key) {
    const msg = 'Id or key is required when removing key input controls.';
    lerror(msg);
    return;
  }

  if (id) {
    if (sceneId) {
      if (type === 'KEY_UP' || !type) {
        keyUpSceneMappings[sceneId] = keyUpSceneMappings[sceneId].filter(
          (mapping) => mapping.id !== id
        );
      }
      if (type === 'KEY_DOWN' || !type) {
        keyDownSceneMappings[sceneId] = keyDownSceneMappings[sceneId].filter(
          (mapping) => mapping.id !== id
        );
      }
      return;
    }

    if (type === 'KEY_UP' || !type) {
      keyUpMappings = keyUpMappings.filter((mapping) => mapping.id !== id);
    }
    if (type === 'KEY_DOWN' || !type) {
      keyDownMappings = keyDownMappings.filter((mapping) => mapping.id !== id);
    }
    return;
  }

  if (key) {
    if (sceneId) {
      if (type === 'KEY_UP' || !type) {
        keyUpSceneMappings[sceneId] = keyUpSceneMappings[sceneId].filter(
          (mapping) => mapping.key !== key
        );
      }
      if (type === 'KEY_DOWN' || !type) {
        keyDownSceneMappings[sceneId] = keyDownSceneMappings[sceneId].filter(
          (mapping) => mapping.key !== key
        );
      }
      return;
    }

    if (type === 'KEY_UP' || !type) {
      keyUpMappings = keyUpMappings.filter((mapping) => mapping.key !== key);
    }
    if (type === 'KEY_DOWN' || !type) {
      keyDownMappings = keyDownMappings.filter((mapping) => mapping.key !== key);
    }
  }
};

/**
 * Removes all or specific controller listeners
 * @param type (enum) 'ALL' | 'MOUSE' | {@link InputControlType}: 'ALL' | 'KEY' | 'MOUSE' | 'KEY_UP' | 'KEY_DOWN' | 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE' | 'CONTROLLER'
 */
export const removeControlsListeners = (type: 'ALL' | 'KEY' | 'MOUSE' | InputControlType) => {
  if (type === 'ALL') {
    if (controlListenerFns.keyUp) window.removeEventListener('keyup', controlListenerFns.keyUp);
    controlListenerFns.keyUp = null;
    controlListenerFns.keyDown = null;
    controlListenerFns.mouseUp = null;
    controlListenerFns.mouseDown = null;
    controlListenerFns.mouseMove = null;
    controlListenerFns.controller = null;
    return;
  }

  if (type === 'KEY' || type === 'KEY_UP') {
    if (controlListenerFns.keyUp) window.removeEventListener('keyup', controlListenerFns.keyUp);
    controlListenerFns.keyUp = null;
    controlListenerFns.keyDown = null;
    return;
  }

  if (type === 'KEY_DOWN') {
    controlListenerFns.keyDown = null;
    return;
  }

  if (type === 'MOUSE') {
    controlListenerFns.mouseUp = null;
    controlListenerFns.mouseDown = null;
    controlListenerFns.mouseMove = null;
    return;
  }

  if (type === 'MOUSE_UP') {
    controlListenerFns.mouseUp = null;
    return;
  }

  if (type === 'MOUSE_DOWN') {
    controlListenerFns.mouseDown = null;
    return;
  }

  if (type === 'MOUSE_MOVE') {
    controlListenerFns.mouseMove = null;
    return;
  }

  if (type === 'CONTROLLER') {
    controlListenerFns.controller = null;
    return;
  }
};
