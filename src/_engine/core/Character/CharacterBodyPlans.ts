import type {
  CharacterBodyData,
  CharacterBodyPlan,
  CharacterDimensions,
  CharacterProbeDimensions,
} from './CharacterTypes';

/** {@link HUMANOID_CAPSULE}'s sizes (m, in body space: Y up from the body's center). */
export type HumanoidCapsuleDimensions = CharacterDimensions & {
  /** Half the walk capsule's cylinder part (its total height is 2 × (this + radius)). */
  walkHalfHeight: number;
  /** Half the crouch capsule's cylinder part. */
  crouchHalfHeight: number;
  /** Y of the crouch capsule's center: its bottom lines up with the walk capsule's. */
  crouchOffsetY: number;
  /** The wall sensor capsule's radius: `_radius` widened by `_skinThickness`. */
  wallSensorRadius: number;
  /** Half the wall sensor capsule's cylinder part. */
  wallSensorHalfHeight: number;
  /** Y of the wall sensor's center: lifted, so it never touches the floor under the character. */
  wallSensorOffsetY: number;
  /** The floor sensor ball's radius. */
  floorSensorRadius: number;
  /** Y of the floor sensor's center: `_groundDetectorOffset` above the walk capsule's bottom. */
  floorSensorOffsetY: number;
};

const WALL_SENSOR_LIFT = 0.05;
/** The wall cast sits this much above the active capsule's center. */
const WALL_CAST_LIFT = 0.1;
/** The wall cast's cylinder, as a fraction of the active capsule's cylinder part. */
const WALL_CAST_HEIGHT_FACTOR = 0.9;

/** The probes around a capsule whose center is at `centerY`. */
const getCapsuleProbes = (
  halfHeight: number,
  centerY: number,
  wallCastRadius: number,
  radius: number
): CharacterProbeDimensions => ({
  wallCastOffsetY: centerY + WALL_CAST_LIFT,
  wallCastHalfHeight: Math.max(0.01, halfHeight * WALL_CAST_HEIGHT_FACTOR),
  wallCastRadius,
  floorRayLength: halfHeight * 2 + radius * 4,
});

/**
 * An upright capsule body (`kind: 'HUMANOID'`): a walk capsule (`MAIN`), a shorter crouch capsule
 * (`CROUCH`, its bottom where the walk capsule's is), a slightly wider capsule sensor (`WALL_SENSOR`)
 * and a ball sensor at the bottom (`FLOOR_SENSOR`). `_height` is the walk capsule's full height,
 * so a capsule mesh of `_height` and `_radius` matches it.
 */
export const HUMANOID_CAPSULE: CharacterBodyPlan<HumanoidCapsuleDimensions> = {
  kind: 'HUMANOID',

  getDimensions: (d: CharacterBodyData): HumanoidCapsuleDimensions => {
    const walkHalfHeight = Math.max(0, d._height / 2 - d._radius);
    const crouchHalfHeight = Math.max(0, Math.min(d._crouchHeight, d._height) / 2 - d._radius);
    const crouchOffsetY = crouchHalfHeight - walkHalfHeight;
    const wallSensorRadius = d._radius * (1 + d._skinThickness);
    return {
      walkHalfHeight,
      crouchHalfHeight,
      crouchOffsetY,
      wallSensorRadius,
      wallSensorHalfHeight: Math.max(0, walkHalfHeight + d._radius - wallSensorRadius),
      wallSensorOffsetY: WALL_SENSOR_LIFT,
      floorSensorRadius: d._radius * d._groundDetectorRadius,
      floorSensorOffsetY: -(walkHalfHeight + d._radius) + d._groundDetectorOffset,
      standing: getCapsuleProbes(walkHalfHeight, 0, wallSensorRadius, d._radius),
      crouching: getCapsuleProbes(crouchHalfHeight, crouchOffsetY, wallSensorRadius, d._radius),
    };
  },

  getColliders: (dims, d) => [
    {
      role: 'MAIN',
      params: { type: 'CAPSULE', halfHeight: dims.walkHalfHeight, radius: d._radius },
    },
    {
      role: 'CROUCH',
      params: {
        type: 'CAPSULE',
        friction: 0.9,
        halfHeight: dims.crouchHalfHeight,
        radius: d._radius,
        translation: { x: 0, y: dims.crouchOffsetY, z: 0 },
      },
    },
    {
      role: 'WALL_SENSOR',
      params: {
        type: 'CAPSULE',
        halfHeight: dims.wallSensorHalfHeight,
        radius: dims.wallSensorRadius,
        isSensor: true,
        density: 0,
        translation: { x: 0, y: dims.wallSensorOffsetY, z: 0 },
      },
    },
    {
      role: 'FLOOR_SENSOR',
      params: {
        type: 'BALL',
        radius: dims.floorSensorRadius,
        isSensor: true,
        density: 0,
        translation: { x: 0, y: dims.floorSensorOffsetY, z: 0 },
      },
    },
  ],
};
