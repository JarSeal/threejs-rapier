// Octahedral maps (docs/plans/p351_impostor-billboard-lod.md §2.2): directions on a sphere (full) or
// the upper hemisphere (hemi) folded onto the square [-1, 1]². An octahedral impostor bakes one frame
// per point of an N × N grid on that square, and its material picks the frames nearest to the view
// direction the same way, so the bake and the material must agree exactly: the material's TSL
// versions of these functions live next to them.
//
// Both maps have +y at the square's centre. Full: the equator on the diamond |u| + |v| = 1, -y at
// the four corners. Hemi: the horizon on the square's edge (a full map's upper half turned 45° and
// scaled to fill it), anything below the horizon clamped onto it.
import * as THREE from 'three/webgpu';

/** Above this |y| a frame's up reference is -z instead of +y (the frame looks straight down or up). */
export const FRAME_POLE_Y = 0.999;

const signNotZero = (x: number) => (x >= 0 ? 1 : -1);

/**
 * The octahedral coordinates of a direction.
 * @param x the direction (any length but 0)
 * @param hemi the hemi map: a direction below the horizon is clamped onto it
 * @param out receives (u, v), each in [-1, 1]
 */
export const encodeOctahedral = (
  x: number,
  y: number,
  z: number,
  hemi: boolean,
  out: THREE.Vector2
) => {
  if (hemi) {
    const yUp = Math.max(y, 0);
    const sum = Math.abs(x) + yUp + Math.abs(z) || 1;
    const px = x / sum;
    const pz = z / sum;
    return out.set(px + pz, px - pz);
  }
  const sum = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  const px = x / sum;
  const pz = z / sum;
  if (y >= 0) return out.set(px, pz);
  return out.set((1 - Math.abs(pz)) * signNotZero(px), (1 - Math.abs(px)) * signNotZero(pz));
};

/**
 * The direction at octahedral coordinates (the inverse of {@link encodeOctahedral}).
 * @param out receives the unit direction
 */
export const decodeOctahedral = (u: number, v: number, hemi: boolean, out: THREE.Vector3) => {
  if (hemi) {
    const x = (u + v) / 2;
    const z = (u - v) / 2;
    return out.set(x, Math.max(0, 1 - Math.abs(x) - Math.abs(z)), z).normalize();
  }
  const y = 1 - Math.abs(u) - Math.abs(v);
  if (y >= 0) return out.set(u, y, v).normalize();
  return out
    .set((1 - Math.abs(v)) * signNotZero(u), y, (1 - Math.abs(u)) * signNotZero(v))
    .normalize();
};

/** Frame `index`'s octahedral coordinate (-1 to 1) along one side of a `frames`-wide grid: the
 * grid's first and last frames sit on the square's edges. */
export const getOctahedralFrameCoord = (index: number, frames: number) =>
  (index / (frames - 1)) * 2 - 1;

/**
 * The direction frame (`i`, `j`) of a `frames` × `frames` grid is baked from: the bake camera sits
 * on it, looking at the object's centre.
 * @param out receives the unit direction
 */
export const getOctahedralFrameDirection = (
  i: number,
  j: number,
  frames: number,
  hemi: boolean,
  out: THREE.Vector3
) =>
  decodeOctahedral(
    getOctahedralFrameCoord(i, frames),
    getOctahedralFrameCoord(j, frames),
    hemi,
    out
  );

/**
 * The image axes of the frame seen from `dir`: `right` and `up` as the bake camera's x and y, with
 * `dir` its z (it looks along -dir). Up is +y projected onto the image plane, except within
 * {@link FRAME_POLE_Y} of a pole, where it's -z.
 * @param dir the unit direction toward the camera
 */
export const getOctahedralFrameBasis = (
  dir: THREE.Vector3,
  outRight: THREE.Vector3,
  outUp: THREE.Vector3
) => {
  if (Math.abs(dir.y) > FRAME_POLE_Y) outUp.set(0, 0, -1);
  else outUp.set(0, 1, 0);
  outRight.crossVectors(outUp, dir).normalize();
  outUp.crossVectors(dir, outRight);
};
