import { vec2, abs, max, fract, fwidth, smoothstep, oneMinus, mix } from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import { type Node, type NodeMaterial } from 'three/webgpu';
import { blendProjections, readBooleanDefines, triplanarProjection } from './triplanarProjection';

// Plus sign proportions as fractions of one cell (hardcoded, not exposed as inputs)
const PLUS_HALF_ARM_LENGTH = 0.175;
const PLUS_HALF_BAR_THICKNESS = 0.03;
// The plus signs fade out while one pixel grows from this (start) to this (end) fraction of a cell,
// ie. once they'd be too thin on screen to draw without shimmering
const PLUS_FADE_PIXEL_START = 0.025;
const PLUS_FADE_PIXEL_END = 0.075;

// ─── Static defines ───
// Structural switches, resolved at shader build time (only the used paths end up in the shader).
// Set them in the material JSON `staticDefines`, or per mesh with `matOverrides.staticDefines`
// (which gives the mesh a cached material variant, see getMaterialVariant).
const DEFAULT_DEFINES = {
  /** Cells follow the object's rotation (world scale kept, so units stay meters), else world-aligned */
  alignToObject: true,
  /** alignToObject only: fit a whole number of cells to the geometry's bounds (edges on cell edges) */
  fitToBounds: false,
  /** Only the projection the surface faces most, no triplanar blending: no doubled checkers on flat
   * slopes, but hard seams on curved surfaces (see triplanarProjection) */
  dominantAxis: false,
  /** A solid "+" centered in every cell */
  plusSigns: false,
};

// Box-filtered checker parity (0 = color A, 1 = color B) of `p` in cell units: the analytic
// integral of the checker over the pixel footprint `w`, so it fades to the average of the two
// colors in the distance instead of aliasing (Inigo Quilez, "filtered checker").
const filteredChecker = (p: Node<'vec2'>, w: Node<'vec2'>) => {
  const squareWaveIntegral = (x: Node<'vec2'>) => abs(fract(x.mul(0.5)).sub(0.5));
  const i = squareWaveIntegral(p.sub(w.mul(0.5)))
    .sub(squareWaveIntegral(p.add(w.mul(0.5))))
    .mul(2.0)
    .div(w);
  return oneMinus(i.x.mul(i.y)).mul(0.5);
};

// Anti-aliased 1 inside |d| < halfWidth, 0 outside (px = half a pixel in the same units)
const band = (d: Node<'float'>, halfWidth: number, px: Node<'float'>) =>
  oneMinus(smoothstep(px.negate().add(halfWidth), px.add(halfWidth), d));

// Plus sign mask centered in each cell of `p` (cell units), `w` = pixel footprint in cell units
const plusSignMask = (p: Node<'vec2'>, w: Node<'vec2'>) => {
  const local = abs(fract(p).sub(0.5)); // distance from the cell center, per axis
  const px = w.mul(0.5);
  const horizontal = band(local.y, PLUS_HALF_BAR_THICKNESS, px.y).mul(
    band(local.x, PLUS_HALF_ARM_LENGTH, px.x)
  );
  const vertical = band(local.x, PLUS_HALF_BAR_THICKNESS, px.x).mul(
    band(local.y, PLUS_HALF_ARM_LENGTH, px.y)
  );
  const fade = oneMinus(smoothstep(PLUS_FADE_PIXEL_START, PLUS_FADE_PIXEL_END, max(w.x, w.y)));
  return max(horizontal, vertical).mul(fade);
};

// Inputs arrive pre-wrapped by createMaterial: numbers as float uniforms, hex strings as color
// uniforms. `plusSignColor` is only needed with the plusSigns define.
export const colorNode = (
  inputs: {
    checkerSize: Node<'float'>;
    checkerColorA: Node<'color'>;
    checkerColorB: Node<'color'>;
    plusSignColor?: Node<'color'>;
  },
  material: NodeMaterial,
  staticDefines?: Record<string, unknown>
) => {
  const defines = readBooleanDefines(DEFAULT_DEFINES, staticDefines);
  const { checkerSize, checkerColorA, checkerColorB, plusSignColor } = inputs;
  const missing = [
    ['checkerSize', checkerSize],
    ['checkerColorA', checkerColorA],
    ['checkerColorB', checkerColorB],
    ...(defines.plusSigns ? [['plusSignColor', plusSignColor]] : []),
  ].filter(([, node]) => !node);
  if (missing.length) {
    throw new Error(
      `[triplanarCheckerboard] Missing colorNode input(s) ${missing.map(([key]) => `"${key}"`).join(', ')}.`
    );
  }

  const projection = triplanarProjection(
    {
      cellSize: checkerSize,
      alignToObject: defines.alignToObject,
      fitToBounds: defines.fitToBounds,
      dominantAxis: defines.dominantAxis,
    },
    material
  );

  return blendProjections(projection, (coord, cellSize) => {
    const p = coord.div(cellSize); // cell units: cell (i, j) spans [i, i + 1) x [j, j + 1)
    const w = fwidth(p).add(vec2(0.001)); // pixel footprint, never 0 (it divides)
    const base = mix(checkerColorA, checkerColorB, filteredChecker(p, w));
    return defines.plusSigns && plusSignColor ? mix(base, plusSignColor, plusSignMask(p, w)) : base;
  });
};
