import {
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorldGeometry,
  normalView,
  modelScale,
  modelViewMatrix,
  cameraViewMatrix,
  uniform,
  vec2,
  vec3,
  vec4,
  float,
  mod,
  min,
  max,
  clamp,
  step,
  smoothstep,
  oneMinus,
  fwidth,
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

// Minor lines widen (up to the major thickness) once their half-thickness would drop below this
// many pixels, so they don't break up / vanish at a distance.
const MINOR_LINE_MIN_HALF_PIXELS = 0.75;

// ─── Static defines ───
// Structural switches, resolved at shader build time (only the used paths end up in the shader).
// Set them in the material JSON `staticDefines`, or per mesh with `matOverrides.staticDefines`
// (which gives the mesh a cached material variant, see getMaterialVariant).
type GridDefines = {
  /** Lines follow the object's rotation (world scale kept, so units stay meters), else world-aligned */
  alignToObject: boolean;
  /** alignToObject only: fit a whole number of cells to the geometry's bounds (lines on the edges) */
  fitToBounds: boolean;
  /** Thinner lines between the major lines */
  minorLines: boolean;
  /** Grooves along the lines (normalNode) */
  seamNormals: boolean;
};

const DEFAULT_DEFINES: GridDefines = {
  alignToObject: true,
  fitToBounds: false,
  minorLines: true,
  seamNormals: true,
};

const getDefines = (defines?: Record<string, unknown>): GridDefines => {
  const result = { ...DEFAULT_DEFINES };
  for (const key of Object.keys(DEFAULT_DEFINES) as (keyof GridDefines)[]) {
    if (typeof defines?.[key] === 'boolean') result[key] = defines[key] as boolean;
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

// ─── Pattern ───

type PatternParams = {
  lineThickness: Node<'float'>;
  lineFrequency: Node<'float'>;
  minorLineDivisions: Node<'float'>;
};

// The colorNode inputs that shape the pattern (normalNode reads them from the colorNode uniforms)
const getPatternParams = (
  source: Record<string, Node | undefined>,
  prefix: string,
  defines: GridDefines
): PatternParams => {
  const keys = [
    'lineThickness',
    'lineFrequency',
    ...(defines.minorLines ? ['minorLineDivisions'] : []),
  ];
  const missing = keys.filter((key) => !source[prefix + key]);
  if (missing.length) {
    throw new Error(
      `[triplanarGrid] Missing colorNode input(s) ${missing.map((key) => `"${key}"`).join(', ')} (normalNode also needs the colorNode block declared before it).`
    );
  }
  return {
    lineThickness: source[`${prefix}lineThickness`] as Node<'float'>,
    lineFrequency: source[`${prefix}lineFrequency`] as Node<'float'>,
    minorLineDivisions: (source[`${prefix}minorLineDivisions`] ?? float(1.0)) as Node<'float'>,
  };
};

// Projection space shared by both sockets: object-aligned (rotation follows the mesh, world scale
// multiplied back in so units stay meters) or world-aligned (continuous across separate meshes).
// fitToBounds anchors the lines to the bounding box corner and stretches the spacing per axis so a
// whole number of cells spans the object, putting lines on its edges.
// Uses the geometry normal so the blend isn't fed back through the perturbed seam normal.
const projectionSpace = (params: PatternParams, defines: GridDefines, material: NodeMaterial) => {
  const baseSpacing = vec3(params.lineFrequency);
  let pos: Node<'vec3'> = positionWorld;
  let spacing: Node<'vec3'> = baseSpacing;
  let normal: Node<'vec3'> = normalWorldGeometry;

  if (defines.alignToObject) {
    pos = positionLocal.mul(modelScale);
    normal = normalLocal.div(modelScale).normalize();

    if (defines.fitToBounds) {
      const bounds = getBoundsUniforms(material);
      const boundsSize = bounds.max.sub(bounds.min).mul(modelScale);
      pos = pos.sub(bounds.min.mul(modelScale));
      // Flat axes (eg. a plane's thickness) keep the base spacing instead of dividing by zero
      const cellCount = max(boundsSize.div(params.lineFrequency).round(), vec3(1.0));
      spacing = mix(baseSpacing, boundsSize.div(cellCount), step(vec3(0.0001), boundsSize));
    }
  }

  // Triplanar blend weights (components sum to 1)
  let blend = normal.abs();
  blend = blend.div(blend.dot(vec3(1.0)));

  return { pos, spacing, blend };
};

// One axis of a line set (lines at multiples of `spacing`, not at cell centers):
// - mask: anti-aliased color mask (1 = on a line)
// - profile: rounded groove across the line width, 1 - smoothstep(0, halfThickness, dist)
// - slope: analytic derivative of the groove height -halfThickness * profile (no screen-space
//   derivatives), which peaks at 1.5 for any thickness
const lineAxis = (coord: Node<'float'>, spacing: Node<'float'>, halfThickness: Node<'float'>) => {
  const cell = mod(coord, spacing);
  const dist = min(cell, spacing.sub(cell));
  const dir = select(cell.lessThan(spacing.mul(0.5)), float(1.0), float(-1.0));

  const aa = max(halfThickness.mul(0.2), float(0.0001)); // avoid smoothstep(x, x)
  const mask = oneMinus(smoothstep(halfThickness.sub(aa), halfThickness, dist));

  const t = clamp(dist.div(halfThickness), 0.0, 1.0);
  const profile = oneMinus(smoothstep(0.0, halfThickness, dist));
  const slope = t.mul(oneMinus(t)).mul(6.0).mul(dir);

  return { mask, profile, slope };
};

// Both axes of a line set in one projection; where lines cross, the stronger groove wins
const lineSet = (
  coord: Node<'vec2'>,
  spacing: Node<'vec2'>,
  halfThicknessX: Node<'float'>,
  halfThicknessY: Node<'float'>
) => {
  const axisX = lineAxis(coord.x, spacing.x, halfThicknessX);
  const axisY = lineAxis(coord.y, spacing.y, halfThicknessY);
  return {
    mask: max(axisX.mask, axisY.mask),
    profile: max(axisX.profile, axisY.profile),
    slope: select(
      axisX.profile.greaterThan(axisY.profile),
      vec2(axisX.slope, 0.0),
      vec2(0.0, axisY.slope)
    ),
  };
};

// Half the major thickness, widened toward the major thickness when it gets close to pixel size
const minorHalfThickness = (coord: Node<'float'>, majorHalfThickness: Node<'float'>) =>
  min(
    majorHalfThickness,
    max(majorHalfThickness.mul(0.5), fwidth(coord).mul(MINOR_LINE_MIN_HALF_PIXELS))
  );

// Major + optional minor lines for one triplanar projection (minor is null when disabled)
const gridPattern = (
  coord: Node<'vec2'>,
  spacing: Node<'vec2'>,
  params: PatternParams,
  defines: GridDefines
) => {
  const majorHalf = params.lineThickness.mul(0.5);
  const major = lineSet(coord, spacing, majorHalf, majorHalf);

  const minor = defines.minorLines
    ? lineSet(
        coord,
        spacing.div(max(params.minorLineDivisions, 1.0)),
        minorHalfThickness(coord.x, majorHalf),
        minorHalfThickness(coord.y, majorHalf)
      )
    : null;

  return { major, minor };
};

// ─── Sockets ───

// Inputs arrive pre-wrapped by createMaterial: numbers as float uniforms, hex strings as color
// uniforms. The minorLine* inputs are only needed with the minorLines define.
export const colorNode = (
  inputs: {
    lineThickness: Node<'float'>;
    lineFrequency: Node<'float'>;
    lineColor: Node<'color'>;
    backgroundColor: Node<'color'>;
    minorLineDivisions?: Node<'float'>;
    minorLineColor?: Node<'color'>;
  },
  material: NodeMaterial,
  staticDefines?: Record<string, unknown>
) => {
  const defines = getDefines(staticDefines);
  const params = getPatternParams(inputs, '', defines);
  const { lineColor, backgroundColor, minorLineColor } = inputs;
  if (defines.minorLines && !minorLineColor) {
    throw new Error('[triplanarGrid] Missing colorNode input "minorLineColor" (minorLines is on).');
  }
  const { pos, spacing, blend } = projectionSpace(params, defines, material);

  // Major lines are drawn over minor lines, minor lines over the background
  const projectionColor = (coord: Node<'vec2'>, axisSpacing: Node<'vec2'>) => {
    const { major, minor } = gridPattern(coord, axisSpacing, params, defines);
    const withMinor =
      minor && minorLineColor ? mix(backgroundColor, minorLineColor, minor.mask) : backgroundColor;
    return mix(withMinor, lineColor, major.mask);
  };

  return add(
    projectionColor(pos.yz, spacing.yz).mul(blend.x),
    projectionColor(pos.zx, spacing.zx).mul(blend.y),
    projectionColor(pos.xy, spacing.xy).mul(blend.z)
  );
};

// Seam grooves derived from the same line data as colorNode. The pattern inputs are read from the
// colorNode block's uniforms, so the `colorNode` block must be declared before `normalNode` in the
// material JSON. Without the seamNormals define the material keeps its default normal.
export const normalNode = (
  inputs: { seamNormalStrength: Node<'float'>; minorSeamNormalStrength?: Node<'float'> },
  material: NodeMaterial,
  staticDefines?: Record<string, unknown>
) => {
  const defines = getDefines(staticDefines);
  if (!defines.seamNormals) return null;

  const uniforms = (material.userData.uniforms || {}) as Record<string, Node | undefined>;
  const params = getPatternParams(uniforms, 'colorNode_', defines);
  const strength = inputs.seamNormalStrength;
  const minorStrength = inputs.minorSeamNormalStrength ?? float(0.0);
  const { pos, spacing, blend } = projectionSpace(params, defines, material);

  // The stronger groove (major or minor) sets the slope, each with its own strength
  const slope = (coord: Node<'vec2'>, axisSpacing: Node<'vec2'>) => {
    const { major, minor } = gridPattern(coord, axisSpacing, params, defines);
    const majorSlope = major.slope.mul(strength);
    if (!minor) return majorSlope;
    return select(
      minor.profile.greaterThan(major.profile),
      minor.slope.mul(minorStrength),
      majorSlope
    );
  };

  // Lift each projection's 2D gradient back to 3D (projection X uses yz, Y uses zx, Z uses xy)
  const slopeX = slope(pos.yz, spacing.yz);
  const slopeY = slope(pos.zx, spacing.zx);
  const slopeZ = slope(pos.xy, spacing.xy);
  const gradient = add(
    vec3(0.0, slopeX.x, slopeX.y).mul(blend.x),
    vec3(slopeY.y, 0.0, slopeY.x).mul(blend.y),
    vec3(slopeZ.x, slopeZ.y, 0.0).mul(blend.z)
  );

  // Into view space: world coords via the camera, object coords via the model-view (divided by
  // the world scale that projectionSpace multiplied in, leaving rotation only)
  const gradientView = defines.alignToObject
    ? modelViewMatrix.mul(vec4(gradient.div(modelScale), 0.0)).xyz
    : cameraViewMatrix.mul(vec4(gradient, 0.0)).xyz;

  // Surface-gradient perturbation: n' = n - (g - n * dot(n, g))
  const tangentGradient = gradientView.sub(normalView.mul(normalView.dot(gradientView)));
  return normalView.sub(tangentGradient).normalize();
};
