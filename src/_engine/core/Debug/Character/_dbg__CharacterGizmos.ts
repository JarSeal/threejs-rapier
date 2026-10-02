import * as THREE from 'three/webgpu';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../../AppECSRegistry';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { lwarn } from '../../../utils/Logger';
import { getCharacterById } from '../../Character';
import type {
  CharacterBodyData,
  CharacterCastRecord,
  CharacterObject,
  CharacterProbes,
} from '../../Character/CharacterTypes';
import type { CharacterData } from '../../Character/DynamicCharacter';
import { getECSWorld, type ECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import {
  createLines,
  preloadFatLineBackend,
  type LineObject,
  type LineWriter,
} from '../../LineManager';
import type { ColliderParams } from '../../Physics/PhysicsAPITypes';
import { getPhysGameTime } from '../../PhysicsAPI';

/**
 * Character debug gizmos: in-world overlays of the vectors and probes a character's controller
 * decides its state from. A character's gizmo set lives while it has an owner (its state window).
 *
 * The lines are refilled at APP_RENDER_SYNC after the pose producers (POSE_CONSUMERS), so they
 * start from the visual's pose of the frame being drawn (a main late looper runs after the render,
 * so its lines would trail the mesh by a frame). Nothing moves while the app is paused, so a set
 * is then refilled only when its settings change.
 */

const LS_KEY = 'AEK_charGizmos';
const SYSTEM_ID = 'characterGizmoSystem';
const LINE_WIDTH = 2;
const DASH = { dashPx: 6, gapPx: 4 };
// Drawn after the opaque scene, so a line without the depth test is on top of it
const RENDER_ORDER = 999;

export type CharacterGizmoId =
  | 'velocity'
  | 'relVelocity'
  | 'facing'
  | 'groundNormal'
  | 'floorRay'
  | 'floorSensor'
  | 'wallCast'
  | 'trail';

/** The header row's toggles, in order. `isLate`: drawn from an async cast's result. */
export const CHARACTER_GIZMOS: {
  id: CharacterGizmoId;
  label: string;
  title: string;
  isLate?: boolean;
}[] = [
  { id: 'velocity', label: 'Vel', title: 'Velocity (length = speed × scale)' },
  {
    id: 'relVelocity',
    label: 'Rel',
    title: 'Velocity relative to the moving platform (only while on one)',
  },
  { id: 'facing', label: 'Face', title: 'Facing (charRotation)' },
  {
    id: 'groundNormal',
    label: 'Normal',
    title: 'Ground normal at the floor ray hit: green walkable, red too steep',
    isLate: true,
  },
  {
    id: 'floorRay',
    label: 'Floor ray',
    title:
      'The last floor ray, from the body center: solid to the hit (a cross), dashed past it (all dashed on a miss)',
    isLate: true,
  },
  {
    id: 'floorSensor',
    label: 'Sensor',
    title: 'Floor sensor (isGrounded): lit while grounded, grey in the air',
  },
  {
    id: 'wallCast',
    label: 'Wall',
    title:
      'The last wall cast (its cylinder and sweep): solid on a hit, dashed on a miss, gone 300 ms after it. ' +
      'Hit normal: green used as a wall, red rejected (|y| > _wallNormalMaxY)',
    isLate: true,
  },
  { id: 'trail', label: 'Trail', title: 'The last ~2 s of the path' },
];
const GIZMO_IDS = CHARACTER_GIZMOS.map((g) => g.id);

/** Per viewer, shared by all character windows: the last used values are the next set's. */
export type CharacterGizmoSettings = {
  enabled: Record<CharacterGizmoId, boolean>;
  depthTest: boolean;
  /** The velocity arrows' metres per m/s */
  vectorScale: number;
};
const DEFAULT_SETTINGS: CharacterGizmoSettings = {
  enabled: {
    velocity: true,
    relVelocity: false,
    facing: false,
    groundNormal: true,
    floorRay: false,
    floorSensor: true,
    wallCast: false,
    trail: false,
  },
  depthTest: false,
  vectorScale: 0.25,
};

/** One line of a gizmo: a line has one colour and one dash pattern, so each part is its own. */
type GizmoLineSpec = { capacity: number; color: THREE.ColorRepresentation; dashed?: boolean };

/** What a gizmo writer reads, resolved once per refill. Valid only during the call. */
type GizmoFrame = {
  character: CharacterObject;
  /** The controller's probes (undefined: a controller without them) */
  probes: Readonly<CharacterProbes> | undefined;
  /** The visual's world position this frame */
  anchor: THREE.Vector3;
  /** The visual's world rotation this frame */
  rotation: THREE.Quaternion;
  settings: CharacterGizmoSettings;
};

type GizmoImpl = {
  lines: GizmoLineSpec[];
  /** Refills the gizmo's lines (in `lines`' order), allocation-free. */
  write: (lines: LineObject[], frame: GizmoFrame) => void;
};

// Drawing

const GIZMO_COLORS = {
  velocity: 0x00e5ff,
  relVelocity: 0xff4dff,
  facing: 0xffd400,
  walkable: 0x3ddc84,
  steep: 0xff4040,
  floorRay: 0xd0d0d0,
  sensorGrounded: 0xc6ff00,
  sensorAirborne: 0x707070,
  wallCast: 0xff9a1f,
};
const FACING_LENGTH = 0.8;
const NORMAL_LENGTH = 0.5;
/** Half the size of a cast's hit cross */
const HIT_CROSS_HALF = 0.06;
const MIN_ARROW_LENGTH = 1e-3;
const ARROW_HEAD_MAX = 0.15;
const ARROW_HEAD_RATIO = 0.3;
/** A shaft and two crossed "V"s */
const ARROW_SEGMENTS = 5;
const CIRCLE_SEGMENTS = 24;
/** Three great circles */
const SPHERE_SEGMENTS = CIRCLE_SEGMENTS * 3;
/** Two circles, 4 verticals and the sweep */
const WALL_CAST_SEGMENTS = CIRCLE_SEGMENTS * 2 + 5;
/** A wall cast is drawn this long after its result arrived (physics time) */
const WALL_CAST_HOLD_MS = 300;
const CIRCLE_COS: number[] = [];
const CIRCLE_SIN: number[] = [];
for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
  const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
  CIRCLE_COS.push(Math.cos(angle));
  CIRCLE_SIN.push(Math.sin(angle));
}

type Vec3 = { x: number; y: number; z: number };
/** The keys the vector gizmos read: a controller without them draws nothing for that gizmo */
type GizmoData = Partial<
  Pick<
    CharacterData,
    | 'velocity'
    | 'relVelocity'
    | 'isOnMovingPlatform'
    | 'charRotation'
    | 'groundNormal'
    | 'groundIsWalkable'
    | 'isGrounded'
    | '_wallNormalMaxY'
  >
>;

/** Appends an arrow from (ox, oy, oz) along (dx, dy, dz), its length the vector's: the shaft and
 * a head of two crossed "V"s in the planes through it. Below MIN_ARROW_LENGTH it writes nothing. */
const writeArrow = (
  w: LineWriter,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number
) => {
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(length >= MIN_ARROW_LENGTH)) return;
  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;
  const tx = ox + dx;
  const ty = oy + dy;
  const tz = oz + dz;
  w.segment(ox, oy, oz, tx, ty, tz);

  // Two unit perpendiculars: n × ref (ref = up, or X when n is near vertical), then n × p1
  let p1x: number;
  let p1y: number;
  let p1z: number;
  if (Math.abs(ny) < 0.9) {
    p1x = -nz;
    p1y = 0;
    p1z = nx;
  } else {
    p1x = 0;
    p1y = nz;
    p1z = -ny;
  }
  const p1Length = Math.sqrt(p1x * p1x + p1y * p1y + p1z * p1z);
  p1x /= p1Length;
  p1y /= p1Length;
  p1z /= p1Length;
  const p2x = ny * p1z - nz * p1y;
  const p2y = nz * p1x - nx * p1z;
  const p2z = nx * p1y - ny * p1x;

  const headLength = Math.min(ARROW_HEAD_MAX, length * ARROW_HEAD_RATIO);
  const halfWidth = headLength * 0.5;
  const bx = tx - nx * headLength;
  const by = ty - ny * headLength;
  const bz = tz - nz * headLength;
  const ax = p1x * halfWidth;
  const ay = p1y * halfWidth;
  const az = p1z * halfWidth;
  const cx = p2x * halfWidth;
  const cy = p2y * halfWidth;
  const cz = p2z * halfWidth;
  w.segment(tx, ty, tz, bx + ax, by + ay, bz + az);
  w.segment(tx, ty, tz, bx - ax, by - ay, bz - az);
  w.segment(tx, ty, tz, bx + cx, by + cy, bz + cz);
  w.segment(tx, ty, tz, bx - cx, by - cy, bz - cz);
};

/** Appends a 3-axis cross centred on (x, y, z). */
const writeCross = (w: LineWriter, x: number, y: number, z: number) => {
  const h = HIT_CROSS_HALF;
  w.segment(x - h, y, z, x + h, y, z);
  w.segment(x, y - h, z, x, y + h, z);
  w.segment(x, y, z - h, x, y, z + h);
};

/** Appends three great circles (in the XY, XZ and YZ planes) of a ball centred on (x, y, z). */
const writeSphere = (w: LineWriter, x: number, y: number, z: number, radius: number) => {
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const c0 = CIRCLE_COS[i] * radius;
    const s0 = CIRCLE_SIN[i] * radius;
    const c1 = CIRCLE_COS[i + 1] * radius;
    const s1 = CIRCLE_SIN[i + 1] * radius;
    w.segment(x + c0, y + s0, z, x + c1, y + s1, z);
    w.segment(x + c0, y, z + s0, x + c1, y, z + s1);
    w.segment(x, y + c0, z + s0, x, y + c1, z + s1);
  }
};

/** Appends a horizontal circle centred on (x, y, z). */
const writeCircleXZ = (w: LineWriter, x: number, y: number, z: number, radius: number) => {
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    w.segment(
      x + CIRCLE_COS[i] * radius,
      y,
      z + CIRCLE_SIN[i] * radius,
      x + CIRCLE_COS[i + 1] * radius,
      y,
      z + CIRCLE_SIN[i + 1] * radius
    );
  }
};

/** Appends a wall cast: its upright cylinder at the cast's origin (the verticals ahead, behind
 * and to the sides of `dir`) and the sweep along `dir`. */
const writeWallCast = (
  w: LineWriter,
  cast: CharacterCastRecord,
  halfHeight: number,
  radius: number
) => {
  const { origin: o, dir: d } = cast;
  writeCircleXZ(w, o.x, o.y - halfHeight, o.z, radius);
  writeCircleXZ(w, o.x, o.y + halfHeight, o.z, radius);
  // dir is horizontal: (-dz, 0, dx) is its side
  const fx = d.x * radius;
  const fz = d.z * radius;
  const sx = -d.z * radius;
  const sz = d.x * radius;
  const bottom = o.y - halfHeight;
  const top = o.y + halfHeight;
  w.segment(o.x + fx, bottom, o.z + fz, o.x + fx, top, o.z + fz);
  w.segment(o.x - fx, bottom, o.z - fz, o.x - fx, top, o.z - fz);
  w.segment(o.x + sx, bottom, o.z + sz, o.x + sx, top, o.z + sz);
  w.segment(o.x - sx, bottom, o.z - sz, o.x - sx, top, o.z - sz);
  const sweep = cast.isHit ? cast.distance : cast.maxDistance;
  if (sweep > 0) w.segment(o.x, o.y, o.z, o.x + d.x * sweep, o.y + d.y * sweep, o.z + d.z * sweep);
};

/** The radius of a ball around a collider's shape, centred on its origin (null: a mesh-like
 * shape, not drawn). */
const getBoundingRadius = (params: ColliderParams): number | null => {
  switch (params.type) {
    case 'BALL':
    case 'SPHERE':
      return params.radius ?? 0;
    case 'CUBOID':
    case 'BOX':
      return (
        Math.hypot(params.hx ?? 0, params.hy ?? 0, params.hz ?? 0) + (params.borderRadius ?? 0)
      );
    case 'CAPSULE':
      return (params.halfHeight ?? 0) + (params.radius ?? 0) + (params.borderRadius ?? 0);
    case 'CONE':
    case 'CYLINDER':
      return Math.hypot(params.halfHeight ?? 0, params.radius ?? 0) + (params.borderRadius ?? 0);
    default:
      return null;
  }
};

/** A floor sensor as a ball in body space (its collider's translation and radius). */
type SensorBall = { x: number; y: number; z: number; radius: number };
/** Per controller (its probes object): the body plan's colliders are sized once, at creation */
const sensorBalls = new WeakMap<object, SensorBall | null>();
const warnedSensorKinds = new Set<string>();

/** The `FLOOR_SENSOR` collider's ball, looked up by role (null: none, or not drawable). A sensor
 * that isn't a ball gets its bounding ball, with a warning once per body kind. */
const getFloorSensorBall = (probes: Readonly<CharacterProbes>, character: CharacterObject) => {
  let ball = sensorBalls.get(probes);
  if (ball !== undefined) return ball;
  ball = null;
  const collider = probes.body
    .getColliders(probes.dims, character.data as CharacterBodyData)
    .find((c) => c.role === 'FLOOR_SENSOR');
  if (collider) {
    const { params } = collider;
    const radius = getBoundingRadius(params);
    const isBall = params.type === 'BALL' || params.type === 'SPHERE';
    if (!isBall && !warnedSensorKinds.has(probes.body.kind)) {
      warnedSensorKinds.add(probes.body.kind);
      lwarn(
        `[Character gizmos] The '${probes.body.kind}' body plan's FLOOR_SENSOR is a ${params.type}: ` +
          (radius === null
            ? 'the Sensor gizmo draws nothing.'
            : 'the Sensor gizmo draws its bounding ball.')
      );
    }
    if (radius !== null) {
      const t = params.translation;
      ball = { x: t?.x ?? 0, y: t?.y ?? 0, z: t?.z ?? 0, radius };
    }
  }
  sensorBalls.set(probes, ball);
  return ball;
};

const _sensorCenter = new THREE.Vector3();

/** A vector arrow from the anchor, scaled by the vector scale. */
const writeVectorFromAnchor = (line: LineObject, vec: Vec3 | undefined, frame: GizmoFrame) => {
  const w = line.beginWrite();
  if (vec) {
    const s = frame.settings.vectorScale;
    const a = frame.anchor;
    writeArrow(w, a.x, a.y, a.z, vec.x * s, vec.y * s, vec.z * s);
  }
  line.endWrite();
};

/** The drawable gizmos. One without an entry has its toggle disabled. */
const GIZMO_IMPLS: Partial<Record<CharacterGizmoId, GizmoImpl>> = {
  velocity: {
    lines: [{ capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.velocity }],
    write: (lines, frame) => {
      writeVectorFromAnchor(lines[0], (frame.character.data as GizmoData).velocity, frame);
    },
  },
  relVelocity: {
    lines: [{ capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.relVelocity }],
    write: (lines, frame) => {
      const data = frame.character.data as GizmoData;
      writeVectorFromAnchor(
        lines[0],
        data.isOnMovingPlatform ? data.relVelocity : undefined,
        frame
      );
    },
  },
  facing: {
    lines: [{ capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.facing }],
    write: (lines, frame) => {
      const yaw = (frame.character.data as GizmoData).charRotation;
      const w = lines[0].beginWrite();
      if (typeof yaw === 'number') {
        // Forward is (cos yaw, 0, -sin yaw) (CharacterIntent)
        const a = frame.anchor;
        writeArrow(
          w,
          a.x,
          a.y,
          a.z,
          Math.cos(yaw) * FACING_LENGTH,
          0,
          -Math.sin(yaw) * FACING_LENGTH
        );
      }
      lines[0].endWrite();
    },
  },
  groundNormal: {
    // One line per colour: the one not in use is emptied
    lines: [
      { capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.walkable },
      { capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.steep },
    ],
    write: (lines, frame) => {
      const data = frame.character.data as GizmoData;
      const ray = frame.probes?.floorRay;
      const normal = data.groundNormal;
      // A miss (or no ray yet) draws nothing: the controller then uses level ground
      const isShown = Boolean(ray && ray.resolvedAt && ray.isHit && normal);
      const isWalkable = data.groundIsWalkable !== false;
      for (let i = 0; i < 2; i++) {
        const w = lines[i].beginWrite();
        if (isShown && isWalkable === (i === 0)) {
          const p = ray!.point;
          writeArrow(
            w,
            p.x,
            p.y,
            p.z,
            normal!.x * NORMAL_LENGTH,
            normal!.y * NORMAL_LENGTH,
            normal!.z * NORMAL_LENGTH
          );
        }
        lines[i].endWrite();
      }
    },
  },
  floorRay: {
    lines: [
      // The ray to the hit and the hit's cross
      { capacity: 4, color: GIZMO_COLORS.floorRay },
      // The rest of the ray past the hit (all of it on a miss)
      { capacity: 1, color: GIZMO_COLORS.floorRay, dashed: true },
    ],
    write: (lines, frame) => {
      const ray = frame.probes?.floorRay;
      const solid = lines[0].beginWrite();
      const dashed = lines[1].beginWrite();
      // Nothing before the first result
      if (ray?.resolvedAt) {
        const { origin: o, dir: d } = ray;
        const hitDistance = ray.isHit ? ray.distance : 0;
        const hx = o.x + d.x * hitDistance;
        const hy = o.y + d.y * hitDistance;
        const hz = o.z + d.z * hitDistance;
        if (ray.isHit) {
          solid.segment(o.x, o.y, o.z, hx, hy, hz);
          writeCross(solid, hx, hy, hz);
        }
        if (ray.maxDistance > hitDistance) {
          const end = ray.maxDistance;
          dashed.segment(hx, hy, hz, o.x + d.x * end, o.y + d.y * end, o.z + d.z * end);
        }
      }
      lines[0].endWrite();
      lines[1].endWrite();
    },
  },
  floorSensor: {
    // One line per colour: the one not in use is emptied
    lines: [
      { capacity: SPHERE_SEGMENTS, color: GIZMO_COLORS.sensorGrounded },
      { capacity: SPHERE_SEGMENTS, color: GIZMO_COLORS.sensorAirborne },
    ],
    write: (lines, frame) => {
      const ball = frame.probes ? getFloorSensorBall(frame.probes, frame.character) : null;
      const isGrounded = (frame.character.data as GizmoData).isGrounded === true;
      // Rides the visual like the collider rides the body (also tumbling): its offset turns with it
      if (ball) {
        _sensorCenter.set(ball.x, ball.y, ball.z).applyQuaternion(frame.rotation).add(frame.anchor);
      }
      for (let i = 0; i < 2; i++) {
        const w = lines[i].beginWrite();
        if (ball && isGrounded === (i === 0)) {
          writeSphere(w, _sensorCenter.x, _sensorCenter.y, _sensorCenter.z, ball.radius);
        }
        lines[i].endWrite();
      }
    },
  },
  wallCast: {
    lines: [
      // The cast that hit, and the one that missed
      { capacity: WALL_CAST_SEGMENTS, color: GIZMO_COLORS.wallCast },
      { capacity: WALL_CAST_SEGMENTS, color: GIZMO_COLORS.wallCast, dashed: true },
      // The hit normal: used as a wall, or rejected as too steep (_wallNormalMaxY)
      { capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.walkable },
      { capacity: ARROW_SEGMENTS, color: GIZMO_COLORS.steep },
    ],
    write: (lines, frame) => {
      const probes = frame.probes;
      const cast = probes?.wallCast;
      // Fired only near a wall while moving: an old cast is gone
      const isShown = Boolean(
        cast?.resolvedAt && getPhysGameTime() - cast.resolvedAt <= WALL_CAST_HOLD_MS
      );
      const maxY = (frame.character.data as GizmoData)._wallNormalMaxY;
      const isRejected = typeof maxY === 'number' && Math.abs(cast?.normal.y ?? 0) > maxY;
      for (let i = 0; i < 4; i++) {
        const w = lines[i].beginWrite();
        if (isShown) {
          const c = cast!;
          if (i < 2 && c.isHit === (i === 0)) {
            const stance = c.isCrouching ? probes!.dims.crouching : probes!.dims.standing;
            writeWallCast(w, c, stance.wallCastHalfHeight, stance.wallCastRadius);
          } else if (i >= 2 && c.isHit && isRejected === (i === 3)) {
            const { point: p, normal: n } = c;
            writeArrow(
              w,
              p.x,
              p.y,
              p.z,
              n.x * NORMAL_LENGTH,
              n.y * NORMAL_LENGTH,
              n.z * NORMAL_LENGTH
            );
          }
        }
        lines[i].endWrite();
      }
    },
  },
};

export const isCharacterGizmoAvailable = (id: CharacterGizmoId) => Boolean(GIZMO_IMPLS[id]);

export type CharacterGizmoSet = {
  charId: string;
  /** The entity the set was built for: another entity under the same id is another set */
  entityId: number;
  owners: Set<object>;
  settings: CharacterGizmoSettings;
  lines: Partial<Record<CharacterGizmoId, LineObject[]>>;
  /** Refills are skipped and the lines keep their last geometry */
  isFrozen: boolean;
  isDisposed: boolean;
};

const sets = new Map<string, CharacterGizmoSet>();
// Rewritten by every refill (no allocation per frame); `character` is set before any writer reads it
const frame: GizmoFrame = {
  character: null as unknown as CharacterObject,
  probes: undefined,
  anchor: new THREE.Vector3(),
  rotation: new THREE.Quaternion(),
  settings: DEFAULT_SETTINGS,
};
const _scale = new THREE.Vector3();

// Settings

const sanitizeScale = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.vectorScale;
};

const loadSettings = (): CharacterGizmoSettings => {
  let saved: Partial<CharacterGizmoSettings> | null = null;
  try {
    saved = lsGetItem(LS_KEY, {}) as Partial<CharacterGizmoSettings> | null;
  } catch {
    saved = null;
  }
  const enabled = { ...DEFAULT_SETTINGS.enabled };
  const savedEnabled = saved?.enabled as Partial<Record<CharacterGizmoId, unknown>> | undefined;
  for (const id of GIZMO_IDS) {
    if (typeof savedEnabled?.[id] === 'boolean') enabled[id] = savedEnabled[id] as boolean;
  }
  return {
    enabled,
    depthTest: typeof saved?.depthTest === 'boolean' ? saved.depthTest : DEFAULT_SETTINGS.depthTest,
    vectorScale: sanitizeScale(saved?.vectorScale),
  };
};

const saveSettings = (settings: CharacterGizmoSettings) => lsSetItem(LS_KEY, settings);

// Refilling

/** A line is shown while its gizmo is on and it has something to draw (an empty line would still
 * issue a zero-count draw call). */
const syncVisibility = (set: CharacterGizmoSet, id: CharacterGizmoId) => {
  const lines = set.lines[id];
  if (!lines) return;
  const isEnabled = set.settings.enabled[id];
  for (let i = 0; i < lines.length; i++) {
    lines[i].object3D.visible = isEnabled && lines[i].segmentCount > 0;
  }
};

/** Refills the set's enabled gizmos (`all`: the disabled ones too). Disposes the set when its
 * character is gone or is another entity now. */
const refillSet = (set: CharacterGizmoSet, world: ECSWorld, all = false) => {
  const character = getCharacterById(set.charId);
  if (!character || character.entityId !== set.entityId) {
    disposeSet(set);
    return;
  }
  const obj = world.getComponent(character.entityId, ComponentType.OBJECT3D)?.value;
  if (!obj) return;
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(frame.anchor, frame.rotation, _scale);
  frame.character = character;
  frame.probes = character.controller?.probes;
  frame.settings = set.settings;

  for (let i = 0; i < GIZMO_IDS.length; i++) {
    const id = GIZMO_IDS[i];
    const lines = set.lines[id];
    if (!lines || (!all && !set.settings.enabled[id])) continue;
    GIZMO_IMPLS[id]!.write(lines, frame);
    syncVisibility(set, id);
  }
};

const characterGizmoSystem = (world: ECSWorld) => {
  for (const set of sets.values()) {
    if (!set.isFrozen) refillSet(set, world);
  }
};

/** A change while the app is paused shows at once (the system doesn't run then). Frozen sets keep
 * their lines. */
const refillNow = (set: CharacterGizmoSet) => {
  if (!set.isDisposed && !set.isFrozen) refillSet(set, getECSWorld());
};

// Lifecycle

const createSet = (character: CharacterObject): CharacterGizmoSet => {
  const settings = loadSettings();
  const set: CharacterGizmoSet = {
    charId: character.id,
    entityId: character.entityId,
    owners: new Set(),
    settings,
    lines: {},
    isFrozen: false,
    isDisposed: false,
  };
  for (const id of GIZMO_IDS) {
    const impl = GIZMO_IMPLS[id];
    if (!impl) continue;
    set.lines[id] = impl.lines.map((spec, i) =>
      createLines({
        name: `charGizmo_${character.id}_${id}_${i}`,
        capacity: spec.capacity,
        growth: 'FIXED',
        // Pinned, so a dashed part draws dashed and no line swaps backends
        backend: 'FAT',
        width: LINE_WIDTH,
        dash: spec.dashed ? DASH : undefined,
        color: spec.color,
        depthTest: settings.depthTest,
        renderOrder: RENDER_ORDER,
        // The set owns their lifetime (it is rebuilt after a scene change, not disposed by it)
        persistent: true,
        attach: { to: 'ROOT_SCENE' },
        // Shown by the first refill that draws something
        visible: false,
      })
    );
  }
  return set;
};

const disposeSet = (set: CharacterGizmoSet) => {
  if (set.isDisposed) return;
  set.isDisposed = true;
  for (const id of GIZMO_IDS) {
    const lines = set.lines[id];
    if (lines) for (const line of lines) line.dispose();
  }
  set.lines = {};
  if (sets.get(set.charId) === set) sets.delete(set.charId);
  if (!sets.size) getECSWorld().removeSystem(SYSTEM_ID);
};

// Public (debug module) API

/** Adds an owner to the character's gizmo set, creating the set on the first one. Returns null
 * when there is no such character. */
export const acquireCharacterGizmos = (charId: string, owner: object) => {
  const character = getCharacterById(charId);
  if (!character) return null;
  let set = sets.get(charId);
  if (set && set.entityId !== character.entityId) {
    disposeSet(set);
    set = undefined;
  }
  if (!set) {
    void preloadFatLineBackend();
    set = createSet(character);
    sets.set(charId, set);
    getECSWorld().addSystem(
      ECSSystemStage.APP_RENDER_SYNC,
      SYSTEM_ID,
      characterGizmoSystem,
      APP_RENDER_SYNC_ORDER.POSE_CONSUMERS
    );
    refillNow(set);
  }
  set.owners.add(owner);
  return set;
};

/** Removes an owner. The last one out disposes the set (its lines). */
export const releaseCharacterGizmos = (set: CharacterGizmoSet, owner: object) => {
  set.owners.delete(owner);
  if (!set.owners.size) disposeSet(set);
};

export const setCharacterGizmoEnabled = (
  set: CharacterGizmoSet,
  id: CharacterGizmoId,
  enabled: boolean
) => {
  if (set.settings.enabled[id] === enabled) return;
  set.settings.enabled[id] = enabled;
  saveSettings(set.settings);
  refillNow(set);
  // Also when frozen: the lines hold the freeze moment
  syncVisibility(set, id);
};

/** Rebuilds every line's pipeline: on a toggle only. */
export const setCharacterGizmoDepthTest = (set: CharacterGizmoSet, depthTest: boolean) => {
  if (set.settings.depthTest === depthTest) return;
  set.settings.depthTest = depthTest;
  saveSettings(set.settings);
  for (const id of GIZMO_IDS) {
    const lines = set.lines[id];
    if (lines) for (const line of lines) line.setDepthTest(depthTest);
  }
};

/** Returns the sanitised scale. While frozen it applies on unfreeze (the lines keep the freeze
 * moment). */
export const setCharacterGizmoVectorScale = (set: CharacterGizmoSet, value: unknown) => {
  const vectorScale = sanitizeScale(value);
  if (set.settings.vectorScale === vectorScale) return vectorScale;
  set.settings.vectorScale = vectorScale;
  saveSettings(set.settings);
  refillNow(set);
  return vectorScale;
};

/** Freezing first fills every gizmo, disabled ones too, so a gizmo turned on while frozen shows
 * the same moment as the rest (like the state window's closed groups). */
export const setCharacterGizmosFrozen = (set: CharacterGizmoSet, isFrozen: boolean) => {
  if (set.isFrozen === isFrozen || set.isDisposed) return;
  if (isFrozen) refillSet(set, getECSWorld(), true);
  set.isFrozen = isFrozen;
  refillNow(set);
};
