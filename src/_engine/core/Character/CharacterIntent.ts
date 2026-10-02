import type { CharacterIntent } from './CharacterTypes';

export type { CharacterIntent } from './CharacterTypes';

/** Below this squared length, a move is no move. */
const MOVE_EPSILON_SQ = 1e-6;
const TWO_PI = Math.PI * 2;

/** A new intent: no move, no turn, facing left alone, not running or crouching. */
export const createIntent = (): CharacterIntent => ({
  moveX: 0,
  moveZ: 0,
  moveForward: 0,
  turn: 0,
  faceYaw: null,
  jump: false,
  run: false,
  crouch: false,
});

/** Clears the per-sub-step fields (moves, turn, jump). Controllers call this after their tick
 * has read the intent; `faceYaw`, `run` and `crouch` are kept. */
export const clearIntentSubStep = (intent: CharacterIntent) => {
  intent.moveX = 0;
  intent.moveZ = 0;
  intent.moveForward = 0;
  intent.turn = 0;
  intent.jump = false;
};

/** Adds a world-space move direction (X = East, -Z = North) to this sub-step's move. */
export const addIntentMove = (intent: CharacterIntent, x: number, z: number) => {
  intent.moveX += x;
  intent.moveZ += z;
};

/** Whether the intent asks for a move this sub-step (opposite moves that cancel out don't). */
export const hasMoveIntent = (intent: CharacterIntent) =>
  intent.moveX * intent.moveX + intent.moveZ * intent.moveZ > MOVE_EPSILON_SQ ||
  Math.abs(intent.moveForward) > 1e-3;

/** The yaw that faces a horizontal world direction (see {@link CharacterIntent}'s convention). */
export const yawFromDirection = (x: number, z: number) => Math.atan2(-z, x);

/** The angle wrapped to -π..π (the shortest turn for an angle difference). */
export const wrapToPi = (angle: number) => {
  const wrapped = (((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return wrapped - Math.PI;
};
