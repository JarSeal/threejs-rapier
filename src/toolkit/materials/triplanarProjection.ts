// Shared triplanar projection helpers for the toolkit's procedural TSL materials
// (triplanarGrid, triplanarCheckerboard).
import {
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorldGeometry,
  modelScale,
  uniform,
  vec3,
  max,
  step,
  mix,
  add,
  select,
} from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import {
  Vector3,
  type BufferGeometry,
  type Node,
  type NodeMaterial,
  type Object3D,
} from 'three/webgpu';

/**
 * Boolean static defines with defaults: `defines` is the socket function's 3rd argument (the
 * material JSON `staticDefines`, merged with a mesh's `matOverrides.staticDefines` in a variant).
 * They're resolved at shader build time, so a TSL function can branch on them in JS.
 */
export const readBooleanDefines = <T extends Record<string, boolean>>(
  defaults: T,
  defines?: Record<string, unknown>
): T => {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = defines?.[key as string];
    if (typeof value === 'boolean') result[key] = value as T[keyof T];
  }
  return result;
};

// ─── Per-object local bounds (fitToBounds only) ───
// The one per-object cost: two uniforms updated before each draw, and only in fitToBounds variants,
// so a mesh's geometry and world scale can change at runtime.

const noBounds = new Vector3();
const localBounds = (object: Object3D | null) => {
  const geometry = (object as { geometry?: BufferGeometry } | null)?.geometry;
  if (!geometry) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox;
};

const boundsUniforms = new WeakMap<NodeMaterial, { min: Node<'vec3'>; max: Node<'vec3'> }>();
const getBoundsUniforms = (material: NodeMaterial) => {
  let bounds = boundsUniforms.get(material);
  if (!bounds) {
    bounds = {
      min: uniform(new Vector3()).onObjectUpdate(
        ({ object }) => localBounds(object)?.min ?? noBounds
      ),
      max: uniform(new Vector3()).onObjectUpdate(
        ({ object }) => localBounds(object)?.max ?? noBounds
      ),
    };
    boundsUniforms.set(material, bounds);
  }
  return bounds;
};

export type TriplanarProjectionOptions = {
  /** Base cell size in meters (grid line spacing, checker size) */
  cellSize: Node<'float'>;
  /** Project in object space (rotation follows the mesh, world scale multiplied back in so units
   * stay meters), else in world space (continuous across separate meshes) */
  alignToObject: boolean;
  /** alignToObject only: anchor at the geometry's bounding box corner and stretch the cell size per
   * axis so a whole number of cells spans the object (cell edges on the object's edges) */
  fitToBounds: boolean;
  /** Use only the projection the surface faces most instead of blending all three: no doubled
   * lines/cells on flat slopes (two blended projections put their lines at different places there),
   * slopes up to 45° continue the floor's pattern seamlessly (stretched along the incline), and the
   * pattern is evaluated once instead of three times. Hard seams on curved surfaces where the
   * facing axis switches, where blending gives terrain its contour-line look instead. */
  dominantAxis: boolean;
};

/**
 * Triplanar projection: the position to evaluate a pattern at, the (per axis) cell size, and the
 * blend weights of the three projections (components sum to 1), or with `dominantAxis` which
 * single projection to use. Both use the geometry normal, never `normalWorld`, which outside the
 * normal sub-build is the perturbed normal.
 */
export const triplanarProjection = (
  { cellSize, alignToObject, fitToBounds, dominantAxis }: TriplanarProjectionOptions,
  material: NodeMaterial
) => {
  const baseSize = vec3(cellSize);
  let pos: Node<'vec3'> = positionWorld;
  let size: Node<'vec3'> = baseSize;
  let normal: Node<'vec3'> = normalWorldGeometry;

  if (alignToObject) {
    pos = positionLocal.mul(modelScale);
    normal = normalLocal.div(modelScale).normalize();

    if (fitToBounds) {
      const bounds = getBoundsUniforms(material);
      const boundsSize = bounds.max.sub(bounds.min).mul(modelScale);
      pos = pos.sub(bounds.min.mul(modelScale));
      // Flat axes (eg. a plane's thickness) keep the base size instead of dividing by zero
      const cellCount = max(boundsSize.div(cellSize).round(), vec3(1.0));
      size = mix(baseSize, boundsSize.div(cellCount), step(vec3(0.0001), boundsSize));
    }
  }

  const facing = normal.abs();
  const blend = facing.div(facing.dot(vec3(1.0)));

  // X faces most, else Y faces more than Z (else Z)
  const dominant = dominantAxis
    ? {
        isX: facing.x.greaterThanEqual(max(facing.y, facing.z)),
        isY: facing.y.greaterThanEqual(facing.z),
      }
    : null;

  return { pos, size, blend, dominant };
};

export type TriplanarProjection = ReturnType<typeof triplanarProjection>;

type ProjectionPattern<T> = (coord: Node<'vec2'>, cellSize: Node<'vec2'>) => T;

/**
 * Evaluates `pattern` for the three projections (X uses the yz plane, Y zx, Z xy) and blends the
 * results by the projection's weights, or with `dominantAxis` evaluates it once, for the
 * projection the surface faces most.
 */
export const blendProjections = (
  { pos, size, blend, dominant }: TriplanarProjection,
  pattern: ProjectionPattern<Node<'vec3'>>
) => {
  if (dominant) {
    const coord = select(dominant.isX, pos.yz, select(dominant.isY, pos.zx, pos.xy));
    const cellSize = select(dominant.isX, size.yz, select(dominant.isY, size.zx, size.xy));
    return pattern(coord, cellSize);
  }
  return add(
    pattern(pos.yz, size.yz).mul(blend.x),
    pattern(pos.zx, size.zx).mul(blend.y),
    pattern(pos.xy, size.xy).mul(blend.z)
  );
};

/**
 * Like blendProjections, for a 2D gradient in projection coordinates (eg. a height slope for
 * normals): each projection's gradient is lifted back to 3D (in the projection's coordinate space)
 * before blending.
 */
export const blendProjectionGradients = (
  { pos, size, blend, dominant }: TriplanarProjection,
  gradient: ProjectionPattern<Node<'vec2'>>
) => {
  const liftX = (g: Node<'vec2'>) => vec3(0.0, g.x, g.y); // yz plane
  const liftY = (g: Node<'vec2'>) => vec3(g.y, 0.0, g.x); // zx plane
  const liftZ = (g: Node<'vec2'>) => vec3(g.x, g.y, 0.0); // xy plane

  if (dominant) {
    const coord = select(dominant.isX, pos.yz, select(dominant.isY, pos.zx, pos.xy));
    const cellSize = select(dominant.isX, size.yz, select(dominant.isY, size.zx, size.xy));
    const g = gradient(coord, cellSize);
    return select(dominant.isX, liftX(g), select(dominant.isY, liftY(g), liftZ(g)));
  }
  return add(
    liftX(gradient(pos.yz, size.yz)).mul(blend.x),
    liftY(gradient(pos.zx, size.zx)).mul(blend.y),
    liftZ(gradient(pos.xy, size.xy)).mul(blend.z)
  );
};
