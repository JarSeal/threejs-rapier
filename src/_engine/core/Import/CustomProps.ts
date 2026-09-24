import type { ColliderParams, RigidBodyParams } from '../Physics/PhysicsAPITypes';
import type { ImportPhysicsParams, ParsedCustomProps } from './ImportTypes';

const KNOWN_COLLIDER_TYPES: ColliderParams['type'][] = [
  'CUBOID',
  'BOX',
  'BALL',
  'SPHERE',
  'CAPSULE',
  'CONE',
  'CYLINDER',
  'TRIMESH',
  'HEIGHTFIELD',
  'CONVEXHULL',
];

const DEFAULT_DENSITY = 0.2;
const DEFAULT_FRICTION = 0.2;
const DEFAULT_RESTITUTION = 0.2;

type CombineRule = NonNullable<ColliderParams['frictionCombineRule']>;
const toCombineRule = (value: unknown): CombineRule =>
  value === 'MAX' || value === 'MIN' || value === 'MULTIPLY' ? value : 'AVERAGE';

const num = (value: unknown) => (typeof value === 'number' ? value : undefined);

/** Applies an {@link ImportPhysicsParams} override on top of raw custom props, field by field. */
const applyOverride = (
  raw: Record<string, unknown>,
  override?: ImportPhysicsParams
): Record<string, unknown> => {
  if (!override) return raw;
  const props: Record<string, unknown> = { ...raw };
  if (override.isPhysObj !== undefined) props.isPhysObj = override.isPhysObj;
  if (override.meshId) props.id = override.meshId;
  if (override.name) props.name = override.name;
  if (override.keepMesh !== undefined) props.keepMesh = override.keepMesh;
  if (override.index !== undefined) props.index = override.index;
  if (override.rigidBody?.rigidType) props.rigidType = override.rigidBody.rigidType;

  const collider = override.collider;
  if (collider) {
    if (collider.type) props.colliderType = collider.type;
    if (collider.density !== undefined) props.density = collider.density;
    if (collider.friction !== undefined) props.friction = collider.friction;
    if (collider.restitution !== undefined) props.restitution = collider.restitution;
    if (collider.frictionCombineRule) props.frictionCombineRule = collider.frictionCombineRule;
    if (collider.restitutionCombineRule) {
      props.restitutionCombineRule = collider.restitutionCombineRule;
    }
    for (const key of ['borderRadius', 'hx', 'hy', 'hz', 'radius', 'halfHeight'] as const) {
      if (key in collider) {
        const value = (collider as Record<string, unknown>)[key];
        if (value !== undefined) props[key] = value;
      }
    }
  }
  return props;
};

const toShapeParams = (props: Record<string, unknown>, type: ColliderParams['type']) => {
  switch (type) {
    case 'CUBOID':
    case 'BOX':
      return {
        type,
        ...(num(props.hx) !== undefined ? { hx: num(props.hx) } : {}),
        ...(num(props.hy) !== undefined ? { hy: num(props.hy) } : {}),
        ...(num(props.hz) !== undefined ? { hz: num(props.hz) } : {}),
        ...(num(props.borderRadius) !== undefined ? { borderRadius: num(props.borderRadius) } : {}),
      };
    case 'BALL':
    case 'SPHERE':
      return { type, ...(num(props.radius) !== undefined ? { radius: num(props.radius) } : {}) };
    case 'CAPSULE':
    case 'CONE':
    case 'CYLINDER':
      return {
        type,
        ...(num(props.halfHeight) !== undefined ? { halfHeight: num(props.halfHeight) } : {}),
        ...(num(props.radius) !== undefined ? { radius: num(props.radius) } : {}),
        ...(num(props.borderRadius) !== undefined ? { borderRadius: num(props.borderRadius) } : {}),
      };
    case 'HEIGHTFIELD':
      return {
        type,
        ...(num(props.nCols) !== undefined ? { ncols: num(props.nCols) } : {}),
        ...(num(props.nRows) !== undefined ? { nrows: num(props.nRows) } : {}),
      };
    case 'TRIMESH':
    case 'CONVEXHULL':
      // Vertices/indices come from the geometry when spawning
      return { type };
    default:
      return null;
  }
};

/**
 * Parses a node's Blender custom properties (glTF `extras`, found in GLTFLoader's
 * `object.userData`) into normalized physics metadata. Pure: `userData` is not mutated and no
 * physics is created. Defaults: density/friction/restitution 0.2, combine rules 'AVERAGE', an
 * unknown `rigidType` → 'FIXED'.
 * @param userData the node's custom props
 * @param override optional {@link ImportPhysicsParams} that wins field-by-field
 * @returns {@link ParsedCustomProps}
 */
export const parseCustomProps = (
  userData: Record<string, unknown>,
  override?: ImportPhysicsParams
): ParsedCustomProps => {
  const raw = { ...userData };
  const props = applyOverride(raw, override);
  const warnings: string[] = [];

  const isPhysObj = Boolean(props.isPhysObj);
  const rigidType =
    props.rigidType === undefined
      ? undefined
      : props.rigidType === 'DYNAMIC' ||
          props.rigidType === 'POS_BASED' ||
          props.rigidType === 'VELO_BASED'
        ? (props.rigidType as RigidBodyParams['rigidType'])
        : 'FIXED';

  const colliderType = props.colliderType as ColliderParams['type'] | undefined;
  let colliderParams: ColliderParams | undefined;
  if (isPhysObj) {
    if (colliderType === undefined) {
      // A visible compound member (isPhysObj + keepMesh, no collider) is fine; only the node
      // carrying the rigid body needs a collider, or its whole `index` group gets no physics
      if (rigidType) {
        warnings.push(
          '"rigidType" is set but "colliderType" is missing, so this node\'s physics group gets no rigid body.'
        );
      }
    } else if (!KNOWN_COLLIDER_TYPES.includes(colliderType)) {
      warnings.push(
        `Unknown "colliderType" "${String(colliderType)}" (known: ${KNOWN_COLLIDER_TYPES.join(', ')}), no collider is created.`
      );
    } else {
      const shape = toShapeParams(props, colliderType);
      if (shape) {
        colliderParams = {
          ...shape,
          density: num(props.density) ?? DEFAULT_DENSITY,
          friction: num(props.friction) ?? DEFAULT_FRICTION,
          frictionCombineRule: toCombineRule(props.frictionCombineRule),
          restitution: num(props.restitution) ?? DEFAULT_RESTITUTION,
          restitutionCombineRule: toCombineRule(props.restitutionCombineRule),
        } as ColliderParams;
      }
    }
  }

  const rigidBodyUserData: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (!key.startsWith('userData_')) continue;
    const userDataKey = key.slice('userData_'.length);
    if (userDataKey) rigidBodyUserData[userDataKey] = props[key];
  }

  return {
    raw,
    isPhysObj,
    ...(isPhysObj ? { keepMesh: Boolean(props.keepMesh) } : {}),
    ...(rigidType ? { rigidType } : {}),
    ...(colliderParams ? { colliderParams } : {}),
    ...(Object.keys(rigidBodyUserData).length ? { rigidBodyUserData } : {}),
    ...(typeof props.index === 'number' ? { index: props.index } : {}),
    ...(props.id !== undefined ? { id: String(props.id) } : {}),
    ...(props.name !== undefined ? { name: String(props.name) } : {}),
    warnings,
  };
};
