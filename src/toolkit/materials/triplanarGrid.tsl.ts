import {
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorldGeometry,
  normalView,
  modelScale,
  modelViewMatrix,
  cameraViewMatrix,
  vec2,
  vec3,
  vec4,
  float,
  mod,
  min,
  max,
  clamp,
  smoothstep,
  oneMinus,
  fwidth,
  mix,
  add,
  select,
} from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import { type Node, type NodeMaterial } from 'three/webgpu';

// Minor lines widen (up to the major thickness) once their half-thickness would drop below this
// many pixels, so they don't break up / vanish at a distance.
const MINOR_LINE_MIN_HALF_PIXELS = 0.75;

type PatternParams = {
  lineThickness: Node<'float'>;
  lineFrequency: Node<'float'>;
  minorLines: Node<'bool'>;
  minorLineDivisions: Node<'float'>;
};

// Projection space shared by both sockets: object-aligned (rotation follows the mesh, world scale
// multiplied back in so units stay meters) or world-aligned (continuous across separate meshes).
// Uses the geometry normal so the blend isn't fed back through the perturbed seam normal.
const projectionSpace = (alignToObject: Node<'bool'>) => {
  const pos = select(alignToObject, positionLocal.mul(modelScale), positionWorld);
  const normal = select(
    alignToObject,
    normalLocal.div(modelScale),
    normalWorldGeometry
  ).normalize();

  // Triplanar blend weights (components sum to 1)
  let blend = normal.abs();
  blend = blend.div(blend.dot(vec3(1.0)));

  return { pos, blend };
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
  spacing: Node<'float'>,
  halfThicknessX: Node<'float'>,
  halfThicknessY: Node<'float'>
) => {
  const axisX = lineAxis(coord.x, spacing, halfThicknessX);
  const axisY = lineAxis(coord.y, spacing, halfThicknessY);
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

// Major + optional minor lines for one triplanar projection
const gridPattern = (coord: Node<'vec2'>, params: PatternParams) => {
  const majorHalf = params.lineThickness.mul(0.5);
  const major = lineSet(coord, params.lineFrequency, majorHalf, majorHalf);

  const minorSpacing = params.lineFrequency.div(max(params.minorLineDivisions, 1.0));
  const minor = lineSet(
    coord,
    minorSpacing,
    minorHalfThickness(coord.x, majorHalf),
    minorHalfThickness(coord.y, majorHalf)
  );
  const minorEnabled = select(params.minorLines, float(1.0), float(0.0));
  const minorMask = minor.mask.mul(minorEnabled);
  const minorProfile = minor.profile.mul(minorEnabled);

  return {
    majorMask: major.mask,
    minorMask,
    slope: select(minorProfile.greaterThan(major.profile), minor.slope, major.slope),
  };
};

// Inputs arrive pre-wrapped by createMaterial: numbers as float uniforms, booleans as bool
// uniforms, hex strings as color uniforms
export const colorNode = (inputs: {
  lineThickness: Node<'float'>;
  lineFrequency: Node<'float'>;
  alignToObject: Node<'bool'>;
  lineColor: Node<'color'>;
  backgroundColor: Node<'color'>;
  minorLines: Node<'bool'>;
  minorLineDivisions: Node<'float'>;
  minorLineColor: Node<'color'>;
}) => {
  const { alignToObject, lineColor, backgroundColor, minorLineColor } = inputs;
  const { pos, blend } = projectionSpace(alignToObject);

  // Major lines are drawn over minor lines, minor lines over the background
  const projectionColor = (coord: Node<'vec2'>) => {
    const pattern = gridPattern(coord, inputs);
    const withMinor = mix(backgroundColor, minorLineColor, pattern.minorMask);
    return mix(withMinor, lineColor, pattern.majorMask);
  };

  return add(
    projectionColor(pos.yz).mul(blend.x),
    projectionColor(pos.zx).mul(blend.y),
    projectionColor(pos.xy).mul(blend.z)
  );
};

// Seam grooves derived from the same line data as colorNode. The pattern inputs are read from the
// colorNode block's uniforms, so the `colorNode` block must be declared before `normalNode` in the
// material JSON.
export const normalNode = (
  inputs: { seamNormals: Node<'bool'>; seamNormalStrength: Node<'float'> },
  material: NodeMaterial
) => {
  const { seamNormals, seamNormalStrength } = inputs;
  const uniforms = (material.userData.uniforms || {}) as Record<string, Node | undefined>;
  const params = {
    lineThickness: uniforms.colorNode_lineThickness,
    lineFrequency: uniforms.colorNode_lineFrequency,
    minorLines: uniforms.colorNode_minorLines,
    minorLineDivisions: uniforms.colorNode_minorLineDivisions,
  };
  const alignToObject = uniforms.colorNode_alignToObject as Node<'bool'> | undefined;
  const missing = Object.entries({ ...params, alignToObject })
    .filter(([, node]) => !node)
    .map(([key]) => `"${key}"`);
  if (missing.length || !alignToObject) {
    throw new Error(
      `[triplanarGrid] normalNode is missing the colorNode inputs ${missing.join(', ')} (declare the colorNode block before normalNode).`
    );
  }

  const { pos, blend } = projectionSpace(alignToObject);
  const slope = (coord: Node<'vec2'>) =>
    gridPattern(coord, params as PatternParams).slope.mul(seamNormalStrength);

  // Lift each projection's 2D gradient back to 3D (projection X uses yz, Y uses zx, Z uses xy)
  const slopeX = slope(pos.yz);
  const slopeY = slope(pos.zx);
  const slopeZ = slope(pos.xy);
  const gradient = add(
    vec3(0.0, slopeX.x, slopeX.y).mul(blend.x),
    vec3(slopeY.y, 0.0, slopeY.x).mul(blend.y),
    vec3(slopeZ.x, slopeZ.y, 0.0).mul(blend.z)
  );

  // Into view space: world coords via the camera, object coords via the model-view (divided by
  // the world scale that projectionSpace multiplied in, leaving rotation only)
  const gradientView = select(
    alignToObject,
    modelViewMatrix.mul(vec4(gradient.div(modelScale), 0.0)).xyz,
    cameraViewMatrix.mul(vec4(gradient, 0.0)).xyz
  );

  // Surface-gradient perturbation: n' = n - (g - n * dot(n, g))
  const tangentGradient = gradientView.sub(normalView.mul(normalView.dot(gradientView)));
  const seamNormal = normalView.sub(tangentGradient).normalize();

  return select(seamNormals, seamNormal, normalView);
};
