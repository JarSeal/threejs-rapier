import { isUsingDebugCamera } from '../debug/DebugTools';
import { lerror, lwarn } from '../utils/Logger';
import { isDebugEnvironment } from './Config';
import { getCurrentSceneId } from './Scene';

export type InputControlType =
  | 'KEY_UP'
  | 'KEY_DOWN'
  | 'MOUSE_UP'
  | 'MOUSE_DOWN'
  | 'MOUSE_MOVE'
  | 'CONTROLLER';

type EnabledInDebugCam = 'ENABLED_IN_DEBUG' | 'ENABLED_ONLY_IN_DEBUG' | 'NOT_ENABLED_IN_DEBUG';

type KeyMapping = {
  id?: string;
  key?: string | string[];
  fn: (e: KeyboardEvent, pressedTime: number) => void;
  time?: number;
  enabled?: boolean; // Default is true
  enabledInDebugCam?: EnabledInDebugCam; // Default is 'ENABLED_IN_DEBUG'
};
type MouseMapping = {
  id?: string;
  fn: (e: MouseEvent, pressedTime: number) => void;
  time?: number;
  enabled?: boolean; // Default is true
  enabledInDebugCam?: EnabledInDebugCam; // Default is 'ENABLED_IN_DEBUG'
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
let mouseUpMappings: MouseMapping[] = [];
let mouseDownMappings: MouseMapping[] = [];
let mouseMoveMappings: MouseMapping[] = [];
let keyUpSceneMappings: { [sceneId: string]: KeyMapping[] } = {};
let keyDownSceneMappings: { [sceneId: string]: KeyMapping[] } = {};
let mouseUpSceneMappings: { [sceneId: string]: MouseMapping[] } = {};
let mouseDownSceneMappings: { [sceneId: string]: MouseMapping[] } = {};
let mouseMoveSceneMappings: { [sceneId: string]: MouseMapping[] } = {};

let allInputsEnabled = true;
let keyInputsEnabled = true;
let mouseInputsEnabled = true;

export const setAllInputsEnabled = (enabled: boolean) => (allInputsEnabled = enabled);
export const setKeyInputsEnabled = (enabled: boolean) => (keyInputsEnabled = enabled);
export const setMouseInputsEnabled = (enabled: boolean) => (mouseInputsEnabled = enabled);

const isInputInDebugCamInvalid = (enabledInDebugCam?: EnabledInDebugCam) =>
  isDebugEnvironment() &&
  ((enabledInDebugCam === 'NOT_ENABLED_IN_DEBUG' && isUsingDebugCamera()) ||
    (enabledInDebugCam === 'ENABLED_ONLY_IN_DEBUG' && !isUsingDebugCamera()));

const isKeyInputDisabled = (mapping: KeyMapping) =>
  mapping.enabled === false || isInputInDebugCamInvalid(mapping.enabledInDebugCam);

const isMouseInputDisabled = (mapping: MouseMapping) =>
  mapping.enabled === false || isInputInDebugCamInvalid(mapping.enabledInDebugCam);

const initKeyUpControls = () => {
  if (controlListenerFns.keyUp) return;
  controlListenerFns.keyUp = (e: KeyboardEvent) => {
    if (!allInputsEnabled || !keyInputsEnabled) return;
    const KEY = e.key;
    const timeNow = performance.now();
    for (let i = 0; i < keyUpMappings.length; i++) {
      const mapping = keyUpMappings[i];
      if (isKeyInputDisabled(mapping)) continue;
      let isCurrentKey = KEY === mapping.key;
      if (Array.isArray(mapping.key)) isCurrentKey = mapping.key.includes(KEY);
      if (isCurrentKey || !mapping.key) {
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
      if (isKeyInputDisabled(mapping)) continue;
      let isCurrentKey = KEY === mapping.key;
      if (Array.isArray(mapping.key)) isCurrentKey = mapping.key.includes(KEY);
      if (isCurrentKey || !mapping.key) {
        mapping.fn(e, timeNow - (mapping.time || timeNow));
        mapping.time = 0;
      }
    }
  };
  window.addEventListener('keyup', controlListenerFns.keyUp);
};

const initKeyDownControls = () => {
  if (controlListenerFns.keyDown) return;
  controlListenerFns.keyDown = (e: KeyboardEvent) => {
    if (!allInputsEnabled || !keyInputsEnabled) return;
    const KEY = e.key;
    const timeNow = performance.now();
    for (let i = 0; i < keyUpMappings.length; i++) {
      const mapping = keyUpMappings[i];
      if (isKeyInputDisabled(mapping)) continue;
      let isCurrentKey = KEY === mapping.key;
      if (Array.isArray(mapping.key)) isCurrentKey = mapping.key.includes(KEY);
      if ((isCurrentKey || !mapping.key) && !mapping.time) {
        mapping.time = timeNow;
      }
    }
    for (let i = 0; i < keyDownMappings.length; i++) {
      const mapping = keyDownMappings[i];
      if (isKeyInputDisabled(mapping)) continue;
      let isCurrentKey = KEY === mapping.key;
      if (Array.isArray(mapping.key)) isCurrentKey = mapping.key.includes(KEY);
      if (isCurrentKey || !mapping.key) {
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
        if (isKeyInputDisabled(mapping)) continue;
        let isCurrentKey = KEY === mapping.key;
        if (Array.isArray(mapping.key)) isCurrentKey = mapping.key.includes(KEY);
        if ((isCurrentKey || !mapping.key) && !mapping.time) {
          mapping.time = timeNow;
        }
      }
    }
    const sceneKeyDownMappings = keyDownSceneMappings[sceneId];
    if (!sceneKeyDownMappings) return;
    for (let i = 0; i < sceneKeyDownMappings.length; i++) {
      const mapping = sceneKeyDownMappings[i];
      if (isKeyInputDisabled(mapping)) continue;
      let isCurrentKey = KEY === mapping.key;
      if (Array.isArray(mapping.key)) isCurrentKey = mapping.key.includes(KEY);
      if (isCurrentKey || !mapping.key) {
        mapping.fn(e, timeNow - (mapping.time || timeNow));
      }
    }
  };
  window.addEventListener('keydown', controlListenerFns.keyDown);
};

const initMouseUpControls = () => {
  if (controlListenerFns.mouseUp) return;
  controlListenerFns.mouseUp = (e: MouseEvent) => {
    if (!allInputsEnabled || !mouseInputsEnabled) return;
    const timeNow = performance.now();
    for (let i = 0; i < mouseUpMappings.length; i++) {
      const mapping = mouseUpMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.fn(e, timeNow - (mapping.time || timeNow));
      mapping.time = 0;
    }
    const sceneId = getCurrentSceneId();
    if (!sceneId) return;
    const sceneMouseUpMappings = mouseUpSceneMappings[sceneId];
    if (!sceneMouseUpMappings) return;
    for (let i = 0; i < sceneMouseUpMappings.length; i++) {
      const mapping = sceneMouseUpMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.fn(e, timeNow - (mapping.time || timeNow));
      mapping.time = 0;
    }
  };
  window.addEventListener('mouseup', controlListenerFns.mouseUp);
};

const initMouseDownControls = () => {
  if (controlListenerFns.mouseDown) return;
  controlListenerFns.mouseDown = (e: MouseEvent) => {
    if (!allInputsEnabled || !mouseInputsEnabled) return;
    const timeNow = performance.now();
    for (let i = 0; i < mouseUpMappings.length; i++) {
      const mapping = mouseUpMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.time = timeNow;
    }
    for (let i = 0; i < mouseDownMappings.length; i++) {
      const mapping = mouseDownMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.time = timeNow;
      mapping.fn(e, timeNow);
    }

    const sceneId = getCurrentSceneId();
    if (!sceneId) return;
    const sceneMouseUpMappings = mouseUpSceneMappings[sceneId];
    if (sceneMouseUpMappings) {
      for (let i = 0; i < sceneMouseUpMappings.length; i++) {
        const mapping = sceneMouseUpMappings[i];
        if (isMouseInputDisabled(mapping)) continue;
        mapping.time = timeNow;
      }
    }
    const sceneMouseDownMappings = mouseDownSceneMappings[sceneId];
    if (!sceneMouseDownMappings) return;
    for (let i = 0; i < sceneMouseDownMappings.length; i++) {
      const mapping = sceneMouseDownMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.fn(e, timeNow - (mapping.time || timeNow));
    }
  };
  window.addEventListener('mousedown', controlListenerFns.mouseDown);
};

const initMouseMoveControls = () => {
  if (controlListenerFns.mouseMove) return;
  controlListenerFns.mouseMove = (e: MouseEvent) => {
    if (!allInputsEnabled || !mouseInputsEnabled) return;
    const timeNow = performance.now();
    for (let i = 0; i < mouseMoveMappings.length; i++) {
      const mapping = mouseMoveMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.fn(e, timeNow);
      mapping.time = 0;
    }
    const sceneId = getCurrentSceneId();
    if (!sceneId) return;
    const sceneMouseMoveMappings = mouseMoveSceneMappings[sceneId];
    if (!sceneMouseMoveMappings) return;
    for (let i = 0; i < sceneMouseMoveMappings.length; i++) {
      const mapping = sceneMouseMoveMappings[i];
      if (isMouseInputDisabled(mapping)) continue;
      mapping.fn(e, timeNow);
      mapping.time = 0;
    }
  };
  window.addEventListener('mousemove', controlListenerFns.mouseMove);
};

/**
 * Adds a keyboard input control. Only the fn (function) is a required property.
 * @param params (object) { id?: string, key?: string, sceneId?: string, type?: 'KEY_UP' | 'KEY_DOWN', fn: (e: KeyboardEvent) => void, enabled?: boolean }
 */
export const addKeyInputControl = ({
  id,
  key,
  type,
  sceneId,
  fn,
  enabled,
  enabledInDebugCam,
}: {
  id?: string;
  key?: string | string[];
  sceneId?: string;
  type?: 'KEY_UP' | 'KEY_DOWN';
  fn: (e: KeyboardEvent, time: number) => void;
  enabled?: boolean;
  enabledInDebugCam?: EnabledInDebugCam;
}) => {
  let idFound = false;
  switch (type) {
    case 'KEY_DOWN':
      idFound = Boolean(
        id &&
          (keyDownMappings.find((mapping) => mapping.id === id) ||
            (sceneId && keyDownSceneMappings[sceneId].find((mapping) => mapping.id === id)))
      );
      if (idFound) return;
      initKeyDownControls();
      if (sceneId) {
        if (!keyDownSceneMappings[sceneId]) keyDownSceneMappings[sceneId] = [];
        keyDownSceneMappings[sceneId].push({
          ...(key ? { key } : {}),
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      } else {
        keyDownMappings.push({
          ...(key ? { key } : {}),
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      }
      break;
    default:
    case 'KEY_UP':
      idFound = Boolean(
        id &&
          (keyUpMappings.find((mapping) => mapping.id === id) ||
            (sceneId && keyUpSceneMappings[sceneId].find((mapping) => mapping.id === id)))
      );
      if (idFound) return;
      initKeyUpControls();
      initKeyDownControls();
      if (sceneId) {
        if (!keyUpSceneMappings[sceneId]) keyUpSceneMappings[sceneId] = [];
        keyUpSceneMappings[sceneId].push({
          ...(key ? { key } : {}),
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      } else {
        keyUpMappings.push({
          ...(key ? { key } : {}),
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      }
      break;
  }
};

/**
 * Adds a mouse input control. Only the fn (function) is a required property.
 * @param params (object) { id?: string, sceneId?: string, type?: 'MOUSE_UP' | 'MOUSE_DOWN | 'MOUSE_MOVE', fn: (e: MouseEvent) => void, enabled?: boolean }
 */
export const addMouseInputControl = ({
  id,
  type,
  sceneId,
  fn,
  enabled,
  enabledInDebugCam,
}: {
  id?: string;
  sceneId?: string;
  type?: 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE';
  fn: (e: MouseEvent, time: number) => void;
  enabled?: boolean;
  enabledInDebugCam?: EnabledInDebugCam;
}) => {
  let idFound = false;
  switch (type) {
    case 'MOUSE_MOVE':
      idFound = Boolean(
        id &&
          (mouseMoveMappings.find((mapping) => mapping.id === id) ||
            (sceneId && mouseMoveSceneMappings[sceneId].find((mapping) => mapping.id === id)))
      );
      if (idFound) return;
      initMouseMoveControls();
      if (sceneId) {
        if (!mouseMoveSceneMappings[sceneId]) mouseMoveSceneMappings[sceneId] = [];
        mouseMoveSceneMappings[sceneId].push({
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      } else {
        mouseMoveMappings.push({
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      }
      break;
    case 'MOUSE_DOWN':
      idFound = Boolean(
        id &&
          (mouseDownMappings.find((mapping) => mapping.id === id) ||
            (sceneId && mouseDownSceneMappings[sceneId].find((mapping) => mapping.id === id)))
      );
      if (idFound) return;
      initMouseDownControls();
      if (sceneId) {
        if (!mouseDownSceneMappings[sceneId]) mouseDownSceneMappings[sceneId] = [];
        mouseDownSceneMappings[sceneId].push({
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      } else {
        mouseDownMappings.push({
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      }
      break;
    default:
    case 'MOUSE_UP':
      idFound = Boolean(
        id &&
          (mouseUpMappings.find((mapping) => mapping.id === id) ||
            (sceneId && mouseUpSceneMappings[sceneId].find((mapping) => mapping.id === id)))
      );
      if (idFound) return;
      initMouseUpControls();
      initMouseDownControls();
      if (sceneId) {
        if (!mouseUpSceneMappings[sceneId]) mouseUpSceneMappings[sceneId] = [];
        mouseUpSceneMappings[sceneId].push({
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      } else {
        mouseUpMappings.push({
          fn,
          time: 0,
          ...(id ? { id } : {}),
          enabled: enabled !== false,
          ...(enabledInDebugCam && enabledInDebugCam !== 'ENABLED_IN_DEBUG'
            ? { enabledInDebugCam }
            : {}),
        });
      }
      break;
  }
};

/**
 * Returns an array of KeyMapping objects by id or key (one is required). Also the scene id and/or type can be provided. If no type is provided, then all types will be searched.
 * @param params (object) { id?: string, key?: string, sceneId?: string, type?: 'KEY_UP' | 'KEY_DOWN' }
 * @returns KeyMapping[] ({@link KeyMapping})
 */
export const getKeyInputControl = ({
  id,
  key,
  sceneId,
  type,
}: {
  id?: string;
  key?: string;
  sceneId?: string;
  type?: 'KEY_UP' | 'KEY_DOWN';
}): KeyMapping[] => {
  if (!id && !key) {
    const msg = 'Id or key is required when searching for key input control.';
    lerror(msg);
    return [];
  }

  const mappings: (KeyMapping | null)[] = [];
  if (id) {
    if (sceneId) {
      if (type === 'KEY_UP' || !type) {
        mappings.push(
          keyUpSceneMappings[sceneId]
            ? keyUpSceneMappings[sceneId].find((mapping) => mapping.id === id) || null
            : null
        );
      }
      if (type === 'KEY_DOWN' || !type) {
        mappings.push(
          keyDownSceneMappings[sceneId]
            ? keyDownSceneMappings[sceneId].find((mapping) => mapping.id === id) || null
            : null
        );
      }
    } else {
      if (type === 'KEY_UP' || !type) {
        mappings.push(keyUpMappings.find((mapping) => mapping.id === id) || null);
      }
      if (type === 'KEY_DOWN' || !type) {
        mappings.push(keyDownMappings.find((mapping) => mapping.id === id) || null);
      }
    }
  }

  if (!id && key) {
    if (sceneId) {
      if (type === 'KEY_UP' || !type) {
        const mappingsByKey = keyUpSceneMappings[sceneId]
          ? keyUpSceneMappings[sceneId].filter((mapping) => mapping.key === key)
          : [null];
        if (mappingsByKey.length) mappings.push(...mappingsByKey);
      }
      if (type === 'KEY_DOWN' || !type) {
        const mappingsByKey = keyDownSceneMappings[sceneId]
          ? keyDownSceneMappings[sceneId].filter((mapping) => mapping.key === key)
          : [null];
        if (mappingsByKey.length) mappings.push(...mappingsByKey);
      }
    } else {
      if (type === 'KEY_UP' || !type) {
        const mappingsByKey = keyUpMappings.filter((mapping) => mapping.key === key);
        if (mappingsByKey.length) mappings.push(...mappingsByKey);
      }
      if (type === 'KEY_DOWN' || !type) {
        const mappingsByKey = keyDownMappings.filter((mapping) => mapping.key === key);
        if (mappingsByKey.length) mappings.push(...mappingsByKey);
      }
    }
  }

  return mappings.filter(Boolean) as KeyMapping[];
};

/**
 * Enables (or disables) one or many KeyMapping objects by id or key (one is required). Also the scene id and/or type can be provided. If no type is provided, then all types will be searched.
 * @param params (object) { id?: string, key?: string, sceneId?: string, type?: 'KEY_UP' | 'KEY_DOWN', enabled: boolean }
 */
export const enableKeyInputControl = ({
  id,
  key,
  sceneId,
  type,
  enabled,
}: {
  id?: string;
  key?: string;
  sceneId?: string;
  type?: 'KEY_UP' | 'KEY_DOWN';
  enabled: boolean;
}) => {
  if (!id && !key) {
    const msg = 'Id or key is required when enabling key input control.';
    lerror(msg);
    return;
  }

  const mappings = getKeyInputControl({ id, key, sceneId, type });
  if (!mappings.length) {
    lwarn(
      `Could not find any key mappings with id: "${id}", key: "${key}", sceneId: "${sceneId}", and type: "${type}" in enableKeyInputControl (enabled: ${enabled})`
    );
    return;
  }
  for (let i = 0; i < mappings.length; i++) {
    mappings[i].enabled = enabled;
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
    const msg = 'Id or key is required when removing key input control.';
    lerror(msg);
    return;
  }

  if (id) {
    if (sceneId) {
      if ((type === 'KEY_UP' || !type) && keyUpSceneMappings[sceneId]) {
        keyUpSceneMappings[sceneId] = keyUpSceneMappings[sceneId].filter(
          (mapping) => mapping.id !== id
        );
      }
      if ((type === 'KEY_DOWN' || !type) && keyDownSceneMappings[sceneId]) {
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
      if ((type === 'KEY_UP' || !type) && keyUpSceneMappings[sceneId]) {
        keyUpSceneMappings[sceneId] = keyUpSceneMappings[sceneId].filter(
          (mapping) => mapping.key !== key
        );
      }
      if ((type === 'KEY_DOWN' || !type) && keyDownSceneMappings[sceneId]) {
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
 * Returns an array of MouseMapping objects by id. Also the scene id and/or type can be provided. If no type is provided, then all types will be searched.
 * @param params (object) { id?: string, sceneId?: string, type?: 'MOUSE_UP' | 'MOUSE_DOWN' }
 * @returns MouseMapping[] ({@link MouseMapping})
 */
export const getMouseInputControl = ({
  id,
  sceneId,
  type,
}: {
  id: string;
  sceneId?: string;
  type?: 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE';
}): MouseMapping[] => {
  const mappings: (MouseMapping | null)[] = [];
  if (sceneId) {
    if (type === 'MOUSE_UP' || !type) {
      mappings.push(
        mouseUpSceneMappings[sceneId]
          ? mouseUpSceneMappings[sceneId].find((mapping) => mapping.id === id) || null
          : null
      );
    }
    if (type === 'MOUSE_DOWN' || !type) {
      mappings.push(
        mouseDownSceneMappings[sceneId]
          ? mouseDownSceneMappings[sceneId].find((mapping) => mapping.id === id) || null
          : null
      );
    }
    if (type === 'MOUSE_MOVE' || !type) {
      mappings.push(
        mouseMoveSceneMappings[sceneId]
          ? mouseMoveSceneMappings[sceneId].find((mapping) => mapping.id === id) || null
          : null
      );
    }
  } else {
    if (type === 'MOUSE_UP' || !type) {
      mappings.push(mouseUpMappings.find((mapping) => mapping.id === id) || null);
    }
    if (type === 'MOUSE_DOWN' || !type) {
      mappings.push(mouseDownMappings.find((mapping) => mapping.id === id) || null);
    }
    if (type === 'MOUSE_MOVE' || !type) {
      mappings.push(mouseMoveMappings.find((mapping) => mapping.id === id) || null);
    }
  }

  return mappings.filter(Boolean) as MouseMapping[];
};

/**
 * Enables (or disables) one or many MouseMapping objects by id. Also the scene id and/or type can be provided. If no type is provided, then all types will be searched.
 * @param params (object) { id?: string, sceneId?: string, type?: 'MOUSE_UP' | 'MOUSE_DOWN', enabled: boolean }
 */
export const enableMouseInputControl = ({
  id,
  sceneId,
  type,
  enabled,
}: {
  id: string;
  sceneId?: string;
  type?: 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE';
  enabled: boolean;
}) => {
  const mappings = getMouseInputControl({ id, sceneId, type });
  if (!mappings.length) {
    lwarn(
      `Could not find any mouse mappings with id: "${id}", sceneId: "${sceneId}", and type: "${type}" in enableMouseInputControl (enabled: ${enabled})`
    );
    return;
  }
  for (let i = 0; i < mappings.length; i++) {
    mappings[i].enabled = enabled;
  }
};

/**
 * Removes a mouse input control by id. Also the scene id and/or type can be provided. If no type is provided, then all types will be removed.
 * @param params (object) { id?: string, sceneId?: string, type?: 'MOUSE_UP' | 'MOUSE_DOWN' }
 */
export const removeMouseInputControl = ({
  id,
  sceneId,
  type,
}: {
  id: string;
  sceneId?: string;
  type?: 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE';
}) => {
  if (sceneId) {
    if ((type === 'MOUSE_UP' || !type) && mouseUpSceneMappings[sceneId]) {
      mouseUpSceneMappings[sceneId] = mouseUpSceneMappings[sceneId].filter(
        (mapping) => mapping.id !== id
      );
    }
    if ((type === 'MOUSE_DOWN' || !type) && mouseDownSceneMappings[sceneId]) {
      mouseDownSceneMappings[sceneId] = mouseDownSceneMappings[sceneId].filter(
        (mapping) => mapping.id !== id
      );
    }
    if ((type === 'MOUSE_MOVE' || !type) && mouseMoveSceneMappings[sceneId]) {
      mouseMoveSceneMappings[sceneId] = mouseMoveSceneMappings[sceneId].filter(
        (mapping) => mapping.id !== id
      );
    }
    return;
  }

  if (type === 'MOUSE_UP' || !type) {
    mouseUpMappings = mouseUpMappings.filter((mapping) => mapping.id !== id);
  }
  if (type === 'MOUSE_DOWN' || !type) {
    mouseDownMappings = mouseDownMappings.filter((mapping) => mapping.id !== id);
  }
  if (type === 'MOUSE_MOVE' || !type) {
    mouseMoveMappings = mouseMoveMappings.filter((mapping) => mapping.id !== id);
  }
};

/**
 * Removes all or specific controller listeners (also removes mappings)
 * @param type (enum) 'ALL' | 'KEY' | 'MOUSE' | 'KEY_UP' | 'KEY_DOWN' | 'MOUSE_UP' | 'MOUSE_DOWN' | 'MOUSE_MOVE' | 'CONTROLLER'
 */
export const removeControlsListeners = (type: 'ALL' | 'KEY' | 'MOUSE' | InputControlType) => {
  if (type === 'ALL') {
    if (controlListenerFns.keyUp) window.removeEventListener('keyup', controlListenerFns.keyUp);
    if (controlListenerFns.keyDown)
      window.removeEventListener('keydown', controlListenerFns.keyDown);
    controlListenerFns.keyUp = null;
    controlListenerFns.keyDown = null;
    controlListenerFns.mouseUp = null;
    controlListenerFns.mouseDown = null;
    controlListenerFns.mouseMove = null;
    controlListenerFns.controller = null;
    keyUpMappings = [];
    keyUpSceneMappings = {};
    keyDownMappings = [];
    keyDownSceneMappings = {};
    mouseUpMappings = [];
    mouseUpSceneMappings = {};
    mouseDownMappings = [];
    mouseDownSceneMappings = {};
    mouseMoveMappings = [];
    mouseMoveSceneMappings = {};
    return;
  }

  if (type === 'KEY') {
    if (controlListenerFns.keyUp) window.removeEventListener('keyup', controlListenerFns.keyUp);
    if (controlListenerFns.keyDown)
      window.removeEventListener('keydown', controlListenerFns.keyDown);
    controlListenerFns.keyUp = null;
    controlListenerFns.keyDown = null;
    keyUpMappings = [];
    keyUpSceneMappings = {};
    keyDownMappings = [];
    keyDownSceneMappings = {};
    return;
  }

  if (type === 'KEY_UP') {
    if (controlListenerFns.keyUp) window.removeEventListener('keyup', controlListenerFns.keyUp);
    controlListenerFns.keyUp = null;
    keyUpMappings = [];
    keyUpSceneMappings = {};
    return;
  }

  if (type === 'KEY_DOWN') {
    if (controlListenerFns.keyDown)
      window.removeEventListener('keydown', controlListenerFns.keyDown);
    controlListenerFns.keyDown = null;
    keyDownMappings = [];
    keyDownSceneMappings = {};
    return;
  }

  if (type === 'MOUSE') {
    controlListenerFns.mouseUp = null;
    controlListenerFns.mouseDown = null;
    controlListenerFns.mouseMove = null;
    mouseUpMappings = [];
    mouseUpSceneMappings = {};
    mouseDownMappings = [];
    mouseDownSceneMappings = {};
    mouseMoveMappings = [];
    mouseMoveSceneMappings = {};
    return;
  }

  if (type === 'MOUSE_UP') {
    controlListenerFns.mouseUp = null;
    mouseUpMappings = [];
    mouseUpSceneMappings = {};
    return;
  }

  if (type === 'MOUSE_DOWN') {
    controlListenerFns.mouseDown = null;
    mouseDownMappings = [];
    mouseDownSceneMappings = {};
    return;
  }

  if (type === 'MOUSE_MOVE') {
    controlListenerFns.mouseMove = null;
    mouseMoveMappings = [];
    mouseMoveSceneMappings = {};
    return;
  }

  if (type === 'CONTROLLER') {
    controlListenerFns.controller = null;
    return;
  }
};
