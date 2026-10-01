import * as THREE from 'three/webgpu';
import type { KeyBinding, KeyHeldBinding, KeyUpDownBinding } from '../Input/KeyboardInput';
import { getMainCamera } from '../CameraManager';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { addIntentMove } from './CharacterIntent';
import type { CharacterIntent } from './CharacterTypes';

/**
 * How keys map to a character's intent:
 * - `TANK`: turn keys turn the character, forward/backward keys move along its facing.
 * - `WORLD_FIXED`: the keys move North (-Z), South (+Z), West (-X) and East (+X); combinations
 *   move diagonally. The character turns toward the move direction.
 * - `CAMERA_RELATIVE`: like `WORLD_FIXED`, with forward = the camera's view direction on the
 *   ground (screen-up).
 */
export type CharacterInputScheme = 'TANK' | 'WORLD_FIXED' | 'CAMERA_RELATIVE';

/** `TOGGLE`: a key press switches the state (default). `HOLD`: on while the key is held. */
export type CharacterInputHoldMode = 'TOGGLE' | 'HOLD';

/** Keys are `KeyboardEvent.key` values (case-insensitive); any of them triggers the action. */
type CharacterActionMappings = { jump?: string[]; run?: string[]; crouch?: string[] };

export type TankInputMappings = CharacterActionMappings & {
  rotateLeft: string[];
  rotateRight: string[];
  moveForward: string[];
  moveBackward: string[];
};

export type WorldFixedInputMappings = CharacterActionMappings & {
  moveNorth: string[];
  moveSouth: string[];
  moveWest: string[];
  moveEast: string[];
};

export type CameraRelativeInputMappings = CharacterActionMappings & {
  moveForward: string[];
  moveBackward: string[];
  moveLeft: string[];
  moveRight: string[];
};

type CharacterInputCommonOpts = {
  /** How the run key works (default `TOGGLE`). */
  runMode?: CharacterInputHoldMode;
  /** How the crouch key works (default `TOGGLE`). */
  crouchMode?: CharacterInputHoldMode;
};

/** A character's keyboard input: a scheme and its key mappings. */
export type CharacterInputOpts = CharacterInputCommonOpts &
  (
    | { scheme: 'TANK'; mappings: TankInputMappings }
    | { scheme: 'WORLD_FIXED'; mappings: WorldFixedInputMappings }
    | {
        scheme: 'CAMERA_RELATIVE';
        mappings: CameraRelativeInputMappings;
        /** The camera whose view the keys follow (default: the main camera, also while the debug
         * camera is on). */
        cameraEntityId?: number;
      }
  );

/** What a scheme gives the character: its bindings, and what the controller runs at the start of
 * each tick, before it reads the intent. */
export type CharacterInput = {
  bindings: KeyBinding[];
  beforeTick?: () => void;
};

/** Whether a scheme turns the character toward its move direction by default (the dynamic
 * character's `_turnToMoveDirection`). */
export const SCHEME_TURNS_TO_MOVE_DIRECTION: Record<CharacterInputScheme, boolean> = {
  TANK: false,
  WORLD_FIXED: true,
  CAMERA_RELATIVE: true,
};

const toChord = (keys: string[]) => keys.map((key) => ({ key }));

const _cameraForward = { x: 0, z: -1 };
/** The camera's screen-up direction on the ground, into _cameraForward (North without one). */
const readCameraForward = (cameraEntityId?: number) => {
  const camera =
    cameraEntityId === undefined
      ? getMainCamera()
      : (getECSWorld().getComponent(cameraEntityId, ComponentType.OBJECT3D)?.value as
          | THREE.Object3D
          | undefined);
  _cameraForward.x = 0;
  _cameraForward.z = -1;
  if (!camera) return _cameraForward;
  const e = camera.matrixWorld.elements;
  // The view direction (-Z axis) on the ground, or the up axis for a camera looking straight down
  let x = -e[8];
  let z = -e[10];
  let length = Math.hypot(x, z);
  if (length < 1e-4) {
    x = e[4];
    z = e[6];
    length = Math.hypot(x, z);
  }
  if (length < 1e-4) return _cameraForward;
  _cameraForward.x = x / length;
  _cameraForward.z = z / length;
  return _cameraForward;
};

/**
 * Builds a character's key bindings for an input scheme. Every binding writes only the intent,
 * so the controller's tick is the only thing that touches the body. Binding ids are namespaced
 * `${characterId}:${action}`, and every binding ignores modifiers: Shift and Ctrl are the
 * default run and crouch keys, and pressing one must not interrupt a held move key.
 */
export const createCharacterInput = (
  characterId: string,
  intent: CharacterIntent,
  opts: CharacterInputOpts
): CharacterInput => {
  const bindings: KeyBinding[] = [];
  const beforeTickFns: (() => void)[] = [];
  const bindingId = (action: string) => `${characterId}:${action}`;

  const addHeld = (action: string, keys: string[] | undefined, fn: () => void) => {
    if (!keys?.length) return;
    const binding: KeyHeldBinding = {
      id: bindingId(action),
      ignoreModifiers: true,
      type: 'KEY_HELD',
      chord: toChord(keys),
      fn,
    };
    bindings.push(binding);
  };

  const addPress = (action: string, keys: string[] | undefined, fn: () => void) => {
    if (!keys?.length) return;
    const binding: KeyUpDownBinding = {
      id: bindingId(action),
      ignoreModifiers: true,
      type: 'KEY_DOWN',
      chord: toChord(keys),
      fn: (e) => {
        e.preventDefault();
        if (e.repeat) return;
        fn();
      },
    };
    bindings.push(binding);
  };

  /** A run/crouch key. HOLD latches the held state and hands it to the intent before each tick:
   * KEY_UP would miss releases (blur, a hidden page or disabled inputs clear the held keys
   * without one) and leave the state stuck on. */
  const addState = (
    action: 'run' | 'crouch',
    keys: string[] | undefined,
    mode: CharacterInputHoldMode = 'TOGGLE'
  ) => {
    if (!keys?.length) return;
    if (mode === 'TOGGLE') {
      addPress(action, keys, () => (intent[action] = !intent[action]));
      return;
    }
    let isHeld = false;
    addHeld(action, keys, () => (isHeld = true));
    beforeTickFns.push(() => {
      intent[action] = isHeld;
      isHeld = false;
    });
  };

  switch (opts.scheme) {
    case 'TANK': {
      const m = opts.mappings;
      addHeld('rotateLeft', m.rotateLeft, () => (intent.turn += 1));
      addHeld('rotateRight', m.rotateRight, () => (intent.turn -= 1));
      addHeld('moveForward', m.moveForward, () => (intent.moveForward += 1));
      addHeld('moveBackward', m.moveBackward, () => (intent.moveForward -= 1));
      break;
    }
    case 'WORLD_FIXED': {
      const m = opts.mappings;
      addHeld('moveNorth', m.moveNorth, () => (intent.moveZ -= 1));
      addHeld('moveSouth', m.moveSouth, () => (intent.moveZ += 1));
      addHeld('moveWest', m.moveWest, () => (intent.moveX -= 1));
      addHeld('moveEast', m.moveEast, () => (intent.moveX += 1));
      break;
    }
    case 'CAMERA_RELATIVE': {
      const m = opts.mappings;
      const cameraEntityId = opts.cameraEntityId;
      // Right = forward turned 90° clockwise seen from above: (-forward.z, forward.x)
      addHeld('moveForward', m.moveForward, () => {
        const f = readCameraForward(cameraEntityId);
        addIntentMove(intent, f.x, f.z);
      });
      addHeld('moveBackward', m.moveBackward, () => {
        const f = readCameraForward(cameraEntityId);
        addIntentMove(intent, -f.x, -f.z);
      });
      addHeld('moveLeft', m.moveLeft, () => {
        const f = readCameraForward(cameraEntityId);
        addIntentMove(intent, f.z, -f.x);
      });
      addHeld('moveRight', m.moveRight, () => {
        const f = readCameraForward(cameraEntityId);
        addIntentMove(intent, -f.z, f.x);
      });
      break;
    }
  }

  addPress('jump', opts.mappings.jump, () => (intent.jump = true));
  addState('run', opts.mappings.run, opts.runMode);
  addState('crouch', opts.mappings.crouch, opts.crouchMode);

  return {
    bindings,
    beforeTick: beforeTickFns.length
      ? () => {
          for (let i = 0; i < beforeTickFns.length; i++) beforeTickFns[i]();
        }
      : undefined,
  };
};
