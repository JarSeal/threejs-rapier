import type { ColliderParams } from '../Physics/PhysicsAPITypes';

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
  /** Persistent: run while true. */
  run: boolean;
  /** Persistent: crouch while true. */
  crouch: boolean;
};

/** The character data a body plan sizes its colliders and probes from (lengths in m). */
export type CharacterBodyData = {
  /** Standing height, from the bottom of the body to its top. */
  _height: number;
  /** Body radius. */
  _radius: number;
  /** Crouching height, from the bottom of the body to its top. */
  _crouchHeight: number;
  /** How much wider than the body the wall sensor is, as a fraction of `_radius`. */
  _skinThickness: number;
  /** Height of the floor sensor's center above the bottom of the body. */
  _groundDetectorOffset: number;
  /** Floor sensor radius, as a fraction of `_radius`. */
  _groundDetectorRadius: number;
};

/** The sizes of a character's probes in one stance (standing or crouching), in body space. */
export type CharacterProbeDimensions = {
  /** Y of the wall cast's center (above the body's center). */
  wallCastOffsetY: number;
  /** Half the height of the wall cast's cylinder. */
  wallCastHalfHeight: number;
  /** Radius of the wall cast's cylinder. */
  wallCastRadius: number;
  /** Length of the floor ray, cast straight down from the body's center. */
  floorRayLength: number;
};

/** What a body plan derives from the character's data: at least the probe sizes of both stances.
 * A plan adds its own sizes (eg. `HumanoidCapsuleDimensions`). */
export type CharacterDimensions = {
  /** The probes while standing. */
  standing: CharacterProbeDimensions;
  /** The probes while crouching. */
  crouching: CharacterProbeDimensions;
};

/** The collider roles the dynamic controller looks up. A body plan has exactly one collider for
 * each of them, and can add colliders with roles of its own (eg. `'TAIL'`).
 * - `MAIN`: the solid body while standing (enabled at creation).
 * - `CROUCH`: the solid body while crouching (the controller creates it disabled).
 * - `WALL_SENSOR`: a sensor around the body that tells when a wall is near.
 * - `FLOOR_SENSOR`: a sensor under the body that tells when it is grounded. */
export type CharacterColliderRole = 'MAIN' | 'CROUCH' | 'WALL_SENSOR' | 'FLOOR_SENSOR';

/** One collider of a body plan. */
export type CharacterBodyCollider = {
  /** A {@link CharacterColliderRole}, or a role of the plan's own. */
  role: string;
  /** The collider's shape, size, offset (`translation`) and material. */
  params: ColliderParams;
};

/**
 * What a character's body looks like to physics: its kind and its colliders and probes, all sized
 * from the character's data. A controller (eg. createDynamicCharacter) decides how the body moves;
 * the body plan only shapes it, so one controller can move several kinds of bodies.
 */
export type CharacterBodyPlan<Dims extends CharacterDimensions = CharacterDimensions> = {
  /** The character's kind (eg. `'HUMANOID'`): data for game code, set as `CharacterObject.kind`. */
  kind: string;
  /** Derives every size from the data. Pure: call it again after the data changes. */
  getDimensions(data: CharacterBodyData): Dims;
  /** The colliders, by role, sized from `getDimensions`' result. */
  getColliders(dims: Dims, data: CharacterBodyData): CharacterBodyCollider[];
};

/**
 * What a character's body is doing, derived by its controller once per sub-step: what a future
 * animation-state system switches on.
 * - `IDLE`, `WALK`, `RUN`: grounded, without or with move input (RUN while running).
 * - `CROUCH`, `CROUCH_WALK`: crouching, without or with move input.
 * - `JUMP`: from a jump until the character stops rising in the air or lands.
 * - `FALL`: in the air without a jump (eg. off a ledge), or after a jump's highest point.
 * - `SLIDE`: grounded and sliding on too steep ground, or faster than the character moves by
 *   itself (eg. pushed). Slowing down after a move is not a slide.
 * - `TUMBLE`, `GET_UP`: knocked over (or in `PHYSICS_ONLY` control mode), and turning upright
 *   again.
 */
export type LocomotionState =
  | 'IDLE'
  | 'WALK'
  | 'RUN'
  | 'CROUCH'
  | 'CROUCH_WALK'
  | 'JUMP'
  | 'FALL'
  | 'SLIDE'
  | 'TUMBLE'
  | 'GET_UP';

/** Called once per locomotion state change, from the controller's tick (inside a physics
 * sub-step: write the intent, don't touch the body). */
export type LocomotionStateListener = (
  next: LocomotionState,
  prev: LocomotionState,
  character: CharacterObject
) => void;

/**
 * Who moves the character's body:
 * - `CONTROLLED`: the controller (velocities, turning, upright rotation lock).
 * - `PHYSICS_ONLY`: physics alone (eg. a ragdoll). The controller applies no velocities, torques
 *   or rotation locks, and starts no tumbling, but keeps its data and locomotion state up to date.
 *   Back to `CONTROLLED`, the character gets up first (the getting-up path).
 */
export type CharacterControlMode = 'CONTROLLED' | 'PHYSICS_ONLY';

/** What moves a character (eg. createDynamicCharacter's controller). */
export type CharacterController = {
  /** Runs once per fixed physics sub-step (APP_PHYSICS_STEP), with the fixed timestep. */
  tick: (dt: number) => void;
  /** Runs when the character's entity is deleted, before its components are gone. */
  dispose?: () => void;
};

/** A character's registry entry: the data of its entity's `CHARACTER` component. */
export type CharacterObject = {
  /** The character's id: the public handle (`getCharacterById`, `deleteCharacter`). */
  id: string;
  /** A display name (the debug tools show it). */
  name?: string;
  /** The body's kind, from its body plan (eg. `'HUMANOID'`). Data, not a code path: switch on it
   * in game code. */
  kind: string;
  /** The character's entity: the visual's, with the physics components. */
  entityId: number;
  /** App id of the visual root (the Object3D the body moves). */
  visualId: string;
  /** Key binding ids owned by this character (namespaced `${id}:…`), deleted with it. */
  keyBindingIds: string[];
  /** Mouse binding ids owned by this character, deleted with it. */
  mouseBindingIds: string[];
  /** Live controller data. Keys follow the naming convention the debug tools rely on: no prefix =
   * state, `_` = configuration, `__` = internal memory. */
  data: Record<string, unknown>;
  /** What the character wants to do this sub-step: write it to drive the character. */
  intent: CharacterIntent;
  /** Who moves the body. Change it with `setControlMode`: the controller applies it on its next
   * tick. */
  controlMode: CharacterControlMode;
  /** Set by the controller's creator once the character exists (until then nothing ticks). */
  controller?: CharacterController;
};
