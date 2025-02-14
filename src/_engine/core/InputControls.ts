import { lerror, lwarn } from '../utils/Logger';

export type InputControlType =
  | 'KEY_UP'
  | 'KEY_DOWN'
  | 'MOUSE_UP'
  | 'MOUSE_DOWN'
  | 'MOUSE_MOVE'
  | 'CONTROLLER';

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
const keyUpMappings: {
  id?: string;
  key: string;
  fn: (e: KeyboardEvent, pressedTime: number) => void;
  startTime?: number;
}[] = [];
const keyDownMappings: {
  id?: string;
  key: string;
  fn: (e: KeyboardEvent, startTime: number) => void;
  startTime: number;
}[] = [];

const initKeyUpControls = () => {
  controlListenerFns.keyUp = (e: KeyboardEvent) => {
    const KEY = e.key;
    const timeNow = performance.now();
    for (let i = 0; i < keyUpMappings.length; i++) {
      const mapping = keyUpMappings[i];
      if (KEY === mapping.key) mapping.fn(e, timeNow - (mapping.startTime || timeNow));
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
      if (KEY === mapping.key) mapping.startTime = timeNow;
    }
    for (let i = 0; i < keyDownMappings.length; i++) {
      const mapping = keyDownMappings[i];
      if (KEY === mapping.key) {
        mapping.startTime = timeNow;
        mapping.fn(e, timeNow);
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
}: {
  id?: string;
  type: InputControlType;
  key: string;
  fn: (e: KeyboardEvent, time: number) => void;
}) => {
  switch (type) {
    case 'KEY_UP':
      if (id && keyUpMappings.find((mapping) => mapping.id === id)) {
        const msg = `Key input control id already taken (id: ${id}), could not add key control. Remove the old control first before adding it.`;
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
      keyUpMappings.push({ key, fn, startTime: 0, ...(id ? { id } : {}) });
      break;
    default:
      lwarn(`${type} controls are not yet implemented.`);
      break;
  }
};

/**
 * Removes all or specific controller types
 * @param type (enum) 'ALL' | 'MOUSE' | {@link InputControlType}: 'ALL' | 'KEY' | 'MOUSE' | 'KEY_UP' | 'KEY_DOWN' | 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE' | 'CONTROLLER'
 */
export const removeControls = (type: 'ALL' | 'KEY' | 'MOUSE' | InputControlType) => {
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
