/**
 * Input hints for the Character state window's configuration editors: the dynamic character's
 * `_` keys (`DynamicCharacter.ts`' `CharacterData`). Optional: the window works with any
 * controller's keys, and a key missing here gets {@link DEFAULT_CONFIG_KEY_HINT}.
 */

export type ConfigKeyHint = {
  /** ArrowUp/ArrowDown step (Shift: ×10). In degrees for a `deg` key. */
  step: number;
  /** Clamps a committed value. In degrees for a `deg` key. */
  min?: number;
  max?: number;
  /** Shown after the input (eg. `'ms'`, `'m/s'`). */
  unit?: string;
  /** The value is in radians, but edited in degrees. */
  deg?: boolean;
  /** A tooltip line: what the key does (from its JSDoc), and when an edit takes effect. */
  note?: string;
};

export const DEFAULT_CONFIG_KEY_HINT: ConfigKeyHint = { step: 0.01 };

const NEXT_TUMBLE = 'An edit applies from the next tumble.';
const NEXT_WALL_CAST = 'An edit applies from the next wall cast.';

const CONFIG_KEY_HINTS: Record<string, ConfigKeyHint> = {
  _height: {
    step: 0.05,
    min: 0.1,
    unit: 'm',
    note: 'Standing height, from the capsule bottom to its top.',
  },
  _radius: { step: 0.05, min: 0.05, unit: 'm', note: 'Capsule radius.' },
  _crouchHeight: {
    step: 0.05,
    min: 0.1,
    unit: 'm',
    note: "Crouching height, from the crouch capsule's bottom to its top.",
  },
  _skinThickness: {
    step: 0.01,
    min: 0,
    unit: '×r',
    note: 'How much wider than the capsule the wall sensor is, as a fraction of _radius.',
  },
  _groundDetectorOffset: {
    step: 0.01,
    unit: 'm',
    note: "Height of the floor sensor's center above the capsule's bottom.",
  },
  _groundDetectorRadius: {
    step: 0.05,
    min: 0,
    unit: '×r',
    note: 'Floor sensor radius, as a fraction of _radius.',
  },
  _tumblingGroundSpeedThreshold: {
    step: 0.5,
    min: 0,
    unit: 'm/s',
    note: 'Relative speed above which landing starts tumbling.',
  },
  _tumblingWallSpeedThreshold: {
    step: 0.5,
    min: 0,
    unit: 'm/s',
    note: 'Relative speed above which touching a wall starts tumbling.',
  },
  _tumblingMinTime: {
    step: 100,
    min: 0,
    unit: 'ms',
    note: 'Minimum tumbling time before getting up.',
  },
  _tumblingEndMinVelo: {
    step: 0.1,
    min: 0,
    unit: 'm/s',
    note: 'Tumbling can end only below this relative speed.',
  },
  _tumblingEndMinAngVelo: {
    step: 0.1,
    min: 0,
    unit: 'rad/s',
    note: 'Tumbling can end only below this angular speed.',
  },
  _tumblingMaxAngVelo: {
    step: 0.1,
    min: 0,
    unit: 'rad/s',
    note: 'Max angular speed while tumbling.',
  },
  _tumblingAngularDamping: {
    step: 0.1,
    min: 0,
    note: `The body's angular damping while tumbling.\n${NEXT_TUMBLE}`,
  },
  _gettingUpDuration: { step: 50, min: 1, unit: 'ms', note: 'How long getting up takes.' },
  _gettingUpAngularDamping: {
    step: 1,
    min: 0,
    note: "The body's angular damping while getting up.",
  },
  _gettingUpMaxAngVelo: {
    step: 0.1,
    min: 0,
    unit: 'rad/s',
    note: 'Max angular speed while getting up.',
  },
  _gettingUpTorque: {
    step: 0.01,
    min: 0,
    note: 'Strength of the uprighting torque impulse (per radian off upright), once fully eased in.',
  },
  _rotateSpeed: {
    step: 0.1,
    min: 0,
    unit: 'rad/s',
    note: 'Turn speed, for turn input and for turning toward a yaw or the move direction.',
  },
  _turnToMoveDirection: {
    step: 1,
    note: "Turn toward the move direction while moving. The intent's turn and faceYaw override it.",
  },
  _maxVelocity: { step: 0.1, min: 0, unit: 'm/s', note: 'Max walking speed.' },
  _maxWalkableAngle: {
    step: 1,
    min: 0,
    max: 90,
    unit: '°',
    deg: true,
    note: 'Steepest walkable slope (stored in radians, edited in degrees).',
  },
  _minSlidingVelocity: {
    step: 0.1,
    min: 0,
    unit: 'm/s',
    note: 'Speed above which a grounded character without move input is sliding.',
  },
  _moveYOffset: {
    step: 0.01,
    unit: 'm/s',
    note: 'Upward velocity added to grounded moves (eg. 0.15 climbs steeper slopes).',
  },
  _jumpAmount: { step: 0.1, min: 0, note: 'Upward jump impulse.' },
  _jumpCooldown: { step: 10, min: 0, unit: 'ms', note: 'Minimum time between jumps.' },
  _inTheAirDiminisher: {
    step: 0.05,
    min: 0,
    unit: '×',
    note: 'Acceleration multiplier in the air.',
  },
  _accumulateVeloPerInterval: {
    step: 1,
    min: 0,
    unit: 'm/s²',
    note: 'Acceleration toward the max speed.',
  },
  _isFallingThreshold: {
    step: 50,
    min: 0,
    unit: 'ms',
    note: 'How long the character can be off the ground before it is falling (isFalling).',
  },
  _runningMultiplier: {
    step: 0.05,
    min: 0,
    unit: '×',
    note: 'Max speed multiplier while running.',
  },
  _crouchingMultiplier: {
    step: 0.05,
    min: 0,
    unit: '×',
    note: 'Max speed multiplier while crouching (the acceleration gets 1 + this).',
  },
  _keepMovingAfterJumpThreshold: {
    step: 0.5,
    unit: 'm/s',
    note: 'Landing with move input and a vertical speed above this zeroes the vertical speed.',
  },
  _wallMicroPush: {
    step: 0.01,
    min: 0,
    unit: 'm/s',
    note: 'Speed away from a wall added while sliding along it: breaks the contact whose friction would hold the character up.',
  },
  _wallNormalMaxY: {
    step: 0.05,
    min: 0,
    max: 1,
    note: `Wall cast hits with a normal steeper than this (|y|) are floors or ceilings, not walls.\n${NEXT_WALL_CAST}`,
  },
  _wallCastDistance: {
    step: 0.05,
    min: 0,
    unit: 'm',
    note: `How far ahead the wall cast looks.\n${NEXT_WALL_CAST}`,
  },
  _slopeSlideSpeed: {
    step: 1,
    min: 0,
    unit: 'm/s²',
    note: 'Downhill acceleration on unwalkable slopes, up to _maxVelocity.',
  },
  _fallStateDelay: {
    step: 10,
    min: 0,
    unit: 'ms',
    note: 'How long the character must be off the ground, without a jump, before its locomotion state is FALL.',
  },
};

/** The key's hints, or the generic ones (no clamping). */
export const getConfigKeyHint = (key: string): ConfigKeyHint =>
  Object.prototype.hasOwnProperty.call(CONFIG_KEY_HINTS, key)
    ? CONFIG_KEY_HINTS[key]
    : DEFAULT_CONFIG_KEY_HINT;
