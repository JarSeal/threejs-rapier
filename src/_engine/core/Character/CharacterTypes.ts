/**
 * What a character wants to do, written by its input scheme, AI, cutscene or network code and
 * read only by its controller's tick (once per fixed physics sub-step).
 *
 * Yaw convention: forward is `(cos yaw, 0, -sin yaw)`, so yaw 0 faces +X (East) and yaw π/2
 * faces -Z (North).
 *
 * The move and turn fields are per sub-step: writers add to them (opposite keys cancel out) and
 * the tick clears them, along with `jump`. The tick clamps the summed move to length 1 and `turn`
 * to -1..1. `faceYaw`, `run` and `crouch` persist until changed.
 */
export type CharacterIntent = {
  /** World-space move direction (X = East), summed per sub-step. */
  moveX: number;
  /** World-space move direction (Z = South, -Z = North), summed per sub-step. */
  moveZ: number;
  /** Move along the facing, after this sub-step's turn (+1 forward, -1 backward). Added to
   * `moveX`/`moveZ`. */
  moveForward: number;
  /** Turn input, -1..1 (positive = left / counter-clockwise), at `_rotateSpeed`. Overrides
   * `faceYaw` and turning to the move direction for this sub-step. */
  turn: number;
  /** Yaw to turn toward (radians, along the shortest way at `_rotateSpeed`), or null. Overrides
   * turning to the move direction. */
  faceYaw: number | null;
  /** Edge-triggered: the tick tries one jump and clears it. */
  jump: boolean;
  run: boolean;
  crouch: boolean;
};

/** What moves a character (eg. createDynamicCharacter's controller). */
export type CharacterController = {
  /** Runs once per fixed physics sub-step (APP_PHYSICS_STEP), with the fixed timestep. */
  tick: (dt: number) => void;
  /** Runs when the character's entity is deleted, before its components are gone. */
  dispose?: () => void;
};

/** A character's registry entry: the data of its entity's `CHARACTER` component. */
export type CharacterObject = {
  id: string;
  name?: string;
  entityId: number;
  /** App id of the visual root (the Object3D the body moves). */
  visualId: string;
  /** Binding ids owned by this character (namespaced `${id}:…`), deleted with it. */
  keyBindingIds: string[];
  mouseBindingIds: string[];
  /** Live controller data. Keys follow the naming convention the debug tools rely on: no prefix =
   * state, `_` = configuration, `__` = internal memory. */
  data: Record<string, unknown>;
  /** What the character wants to do this sub-step: write it to drive the character. */
  intent: CharacterIntent;
  /** Set by the controller's creator once the character exists (until then nothing ticks). */
  controller?: CharacterController;
};
