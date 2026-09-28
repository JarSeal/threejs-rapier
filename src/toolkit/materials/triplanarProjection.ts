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
};

/**
 * Triplanar projection: the position to evaluate a pattern at, the (per axis) cell size, and the
 * blend weights of the three projections (components sum to 1). The weights use the geometry
 * normal, never `normalWorld`, which outside the normal sub-build is the perturbed normal.
 */
export const triplanarProjection = (
  { cellSize, alignToObject, fitToBounds }: TriplanarProjectionOptions,
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

  let blend = normal.abs();
  blend = blend.div(blend.dot(vec3(1.0)));

  return { pos, size, blend };
};

export type TriplanarProjection = ReturnType<typeof triplanarProjection>;

/**
 * Evaluates `pattern` for the three projections (X uses the yz plane, Y zx, Z xy) and blends the
 * results by the projection's weights.
 */
export const blendProjections = (
  { pos, size, blend }: TriplanarProjection,
  pattern: (coord: Node<'vec2'>, cellSize: Node<'vec2'>) => Node<'vec3'>
) =>
  add(
    pattern(pos.yz, size.yz).mul(blend.x),
    pattern(pos.zx, size.zx).mul(blend.y),
    pattern(pos.xy, size.xy).mul(blend.z)
  );
