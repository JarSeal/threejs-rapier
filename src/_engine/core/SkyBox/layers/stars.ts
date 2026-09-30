/**
 * Stars layer: procedural stars (and an optional Milky Way band) in the stars' own frame, which
 * turns with the sky (SkyTime.ts computeSkyRotation). Inside a nebula with a star boost, more
 * cells have a star (the nebula cube's alpha, SkyStaticLayers.ts). Drawn behind the atmosphere:
 * its extinction dims them near the horizon and its inscatter hides them by day. Never in the
 * env bake (p110 §0.2).
 *
 * Placement is cube-projected (no pinching at the poles): the lookup direction's dominant axis
 * picks a face, and each face is a grid of cells, two grids at different scales. A PCG hash per
 * cell decides whether it has a star, where in the cell it is (away from the edges, so a star is
 * never cut by its cell), how bright (a power distribution: mostly faint) and its colour
 * temperature (blue, white, orange). A star is a disc of at least half a pixel's radius,
 * antialiased over one pixel; the pixel's angular size comes from `fwidth` of the (continuous) direction, not of the
 * per-cell distance, which jumps at cell edges.
 *
 * With the sun above fadeRange[0], the whole layer is skipped: its fade is a uniform, so the
 * branch stays in uniform control flow (fwidth is legal in it on WebGPU), and by day it costs a
 * uniform read and one matrix multiply. Nodes other layers share (the view direction) must be
 * built before the branch (see starsNode).
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  cubeTexture,
  float,
  floor,
  Fn,
  fwidth,
  hash,
  If,
  length,
  max,
  mix,
  mx_fractal_noise_float as fractalNoise,
  normalize,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  time,
  uniform,
  uint,
  vec2,
  vec3,
} from 'three/tsl';
import type { SkyBoxStarsDef } from '../SkyBoxTypes';

export const STARS_DEFAULTS = {
  enabled: true,
  density: 0.5,
  brightness: 1,
  size: 1,
  colorVariance: 0.5,
  twinkle: { amount: 0.2, frequency: 1 },
  fadeRange: [-4, -12] as [number, number],
  rotateWithSky: true,
  seed: 0,
  milkyWay: {
    enabled: true,
    intensity: 0.15,
    direction: [-0.87, 0.46, 0.18] as [number, number, number],
    width: 12,
  },
};

/** The coarse grid's cells per face edge at density 0 and 1 (the fine grid has 2.3× more). At
 * density 0.5 the coarse stars are about one per 5.5 square degrees, as the naked-eye sky's. */
const GRID_MIN = 20;
const GRID_MAX = 120;
const FINE_GRID_SCALE = 2.3;
/** Chance a cell has a star: coarse (the brighter stars) and fine (the faint ones). */
const COARSE_PROBABILITY = 0.3;
const FINE_PROBABILITY = 0.2;
/** The fine grid's stars are this much fainter. */
const FINE_BRIGHTNESS = 0.25;
/** A star's radiance: a floor plus a power distribution of the hash (most stars are faint). */
const BRIGHTNESS_FLOOR = 0.015;
const BRIGHTNESS_PEAK = 2.5;
/** ~8% of the stars over 0.5, ~15% over 0.1. */
const BRIGHTNESS_POWER = 20;
/** A star's angular radius at size 1 (it's never drawn under ~1 pixel). */
const STAR_RADIUS = THREE.MathUtils.degToRad(0.02);
/** Where a star can sit in its cell, keeping it clear of the edges. */
const JITTER_MIN = 0.2;
const JITTER_RANGE = 0.6;
/** Colour temperatures: blue, white, orange (linear). */
const STAR_BLUE = new THREE.Color('#9bb0ff');
const STAR_ORANGE = new THREE.Color('#ffc58a');
/** A cell's star chance is multiplied by 1 + this × the nebulae's boost mask (up to 3×). */
const STAR_BOOST_GAIN = 2;
/** The Milky Way's colour and noise scale. */
const MILKY_WAY_COLOR = new THREE.Color('#c9d4ff');
const MILKY_WAY_NOISE_SCALE = 3;

export type StarsUniforms = {
  /** World direction → stars' frame (identity unless it turns with the sky). */
  rotation: THREE.UniformNode<'mat3', THREE.Matrix3>;
  /** 0 by day (the layer is skipped), 1 at night. */
  fade: THREE.UniformNode<'float', number>;
  coarseGrid: THREE.UniformNode<'float', number>;
  fineGrid: THREE.UniformNode<'float', number>;
  brightness: THREE.UniformNode<'float', number>;
  radius: THREE.UniformNode<'float', number>;
  colorVariance: THREE.UniformNode<'float', number>;
  twinkleAmount: THREE.UniformNode<'float', number>;
  twinkleFrequency: THREE.UniformNode<'float', number>;
  seed: THREE.UniformNode<'uint', number>;
  milkyWayIntensity: THREE.UniformNode<'float', number>;
  /** The band's pole (unit), and sin of its half-width. */
  milkyWayPole: THREE.UniformNode<'vec3', THREE.Vector3>;
  milkyWayWidth: THREE.UniformNode<'float', number>;
};

export const createStarsUniforms = (): StarsUniforms => ({
  rotation: uniform(new THREE.Matrix3()),
  fade: uniform(0),
  coarseGrid: uniform(GRID_MIN),
  fineGrid: uniform(GRID_MIN * FINE_GRID_SCALE),
  brightness: uniform(STARS_DEFAULTS.brightness),
  radius: uniform(STAR_RADIUS),
  colorVariance: uniform(STARS_DEFAULTS.colorVariance),
  twinkleAmount: uniform(STARS_DEFAULTS.twinkle.amount),
  twinkleFrequency: uniform(STARS_DEFAULTS.twinkle.frequency),
  seed: uniform(0, 'uint'),
  milkyWayIntensity: uniform(STARS_DEFAULTS.milkyWay.intensity),
  milkyWayPole: uniform(new THREE.Vector3(...STARS_DEFAULTS.milkyWay.direction).normalize()),
  milkyWayWidth: uniform(Math.sin(THREE.MathUtils.degToRad(STARS_DEFAULTS.milkyWay.width))),
});

/** The nebulae's star boost: their baked cube (its alpha is the mask) and where to look it up. */
export type StarBoostSource = {
  cube: THREE.CubeTexture;
  /** The stars' frame → the cube's (static layers') frame. */
  starsToStatic: THREE.Node<'mat3'>;
};

/** Writes the stars' settings (the rotation and fade follow in applyStarsSkyUniforms). */
export const applyStarsUniforms = (u: StarsUniforms, def: SkyBoxStarsDef | undefined) => {
  const density = def?.density ?? STARS_DEFAULTS.density;
  const grid = Math.round(THREE.MathUtils.lerp(GRID_MIN, GRID_MAX, density));
  u.coarseGrid.value = grid;
  u.fineGrid.value = Math.round(grid * FINE_GRID_SCALE);
  u.brightness.value = def?.brightness ?? STARS_DEFAULTS.brightness;
  u.radius.value = STAR_RADIUS * (def?.size ?? STARS_DEFAULTS.size);
  u.colorVariance.value = def?.colorVariance ?? STARS_DEFAULTS.colorVariance;
  u.twinkleAmount.value = def?.twinkle?.amount ?? STARS_DEFAULTS.twinkle.amount;
  u.twinkleFrequency.value = def?.twinkle?.frequency ?? STARS_DEFAULTS.twinkle.frequency;
  u.seed.value = def?.seed ?? STARS_DEFAULTS.seed;
  const milkyWay = def?.milkyWay;
  u.milkyWayIntensity.value = milkyWay?.intensity ?? STARS_DEFAULTS.milkyWay.intensity;
  const [x, y, z] = milkyWay?.direction ?? STARS_DEFAULTS.milkyWay.direction;
  u.milkyWayPole.value.set(x, y, z);
  if (u.milkyWayPole.value.lengthSq() === 0) u.milkyWayPole.value.set(0, 1, 0);
  u.milkyWayPole.value.normalize();
  u.milkyWayWidth.value = Math.sin(
    THREE.MathUtils.degToRad(milkyWay?.width ?? STARS_DEFAULTS.milkyWay.width)
  );
};

/**
 * Writes what follows the sky: the fade from the sun's elevation, and the rotation (the
 * sidereal one, written by the caller, or identity). The day-night step calls it every time the
 * sky moves: it allocates nothing.
 * @param skyRotation the sidereal rotation (computeSkyRotation), or null for none
 */
export const applyStarsSkyUniforms = (
  u: StarsUniforms,
  def: SkyBoxStarsDef | undefined,
  sunDirection: THREE.Vector3,
  skyRotation: THREE.Matrix3 | null
) => {
  const [start, end] = def?.fadeRange ?? STARS_DEFAULTS.fadeRange;
  const elevation = THREE.MathUtils.radToDeg(
    Math.asin(THREE.MathUtils.clamp(sunDirection.y, -1, 1))
  );
  // 0 with the sun at or above `start`, 1 at or below `end`
  u.fade.value =
    start === end
      ? Number(elevation <= end)
      : THREE.MathUtils.smoothstep((start - elevation) / (start - end), 0, 1);
  const rotateWithSky = def?.rotateWithSky ?? STARS_DEFAULTS.rotateWithSky;
  if (skyRotation && rotateWithSky) u.rotation.value.copy(skyRotation);
  else u.rotation.value.identity();
};

/** A direction back from its cube face coordinates (in [-1, 1]). */
const fromFace = (
  isX: THREE.Node<'bool'>,
  isY: THREE.Node<'bool'>,
  faceAxis: THREE.Node<'float'>,
  uv: THREE.Node<'vec2'>
) =>
  normalize(
    select(
      isX,
      vec3(faceAxis, uv.x, uv.y),
      select(isY, vec3(uv.x, faceAxis, uv.y), vec3(uv.x, uv.y, faceAxis))
    )
  );

/**
 * One grid's stars in direction `s` (the stars' frame): its radiance, coloured and twinkling.
 * @param seedOffset makes the grids independent
 * @param boost the nebulae's star boost, or null. The mask is looked up at the cell's centre,
 * so a star is never cut by it.
 */
const starGrid = (
  s: THREE.Node<'vec3'>,
  grid: THREE.Node<'float'>,
  probability: number,
  gain: number,
  seedOffset: number,
  pixel: THREE.Node<'float'>,
  u: StarsUniforms,
  boost: StarBoostSource | null
) => {
  // The cube face: the dominant axis, and the face's coordinates in [-1, 1]
  const a = abs(s);
  const isX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const isY = isX.not().and(a.y.greaterThanEqual(a.z));
  const major = select(isX, a.x, select(isY, a.y, a.z));
  const faceUV = select(isX, s.yz, select(isY, s.xz, s.xy)).div(major);
  const faceAxis = select(isX, sign(s.x), select(isY, sign(s.y), sign(s.z)));
  const face = select(isX, float(0), select(isY, float(1), float(2)))
    .mul(2)
    .add(faceAxis.mul(0.5).add(0.5));

  const cell = floor(faceUV.mul(0.5).add(0.5).mul(grid));
  const seed = uint(cell.x)
    .add(uint(cell.y).mul(4096))
    .add(uint(face).mul(4096 * 4096))
    .add(u.seed.mul(16777259))
    .add(seedOffset);
  const cellDir = fromFace(isX, isY, faceAxis, cell.add(0.5).div(grid).mul(2).sub(1));
  const chance = boost
    ? float(probability).mul(
        float(1).add(
          cubeTexture(boost.cube, boost.starsToStatic.mul(cellDir), float(0)).a.mul(STAR_BOOST_GAIN)
        )
      )
    : float(probability);
  const hasStar = hash(seed).lessThan(chance);
  const jitter = vec2(hash(seed.add(1)), hash(seed.add(2)))
    .mul(JITTER_RANGE)
    .add(JITTER_MIN);
  const level = hash(seed.add(3));
  const temperature = hash(seed.add(4));
  const phase = hash(seed.add(5));

  // The star's direction, back from its face coordinates
  const starDir = fromFace(isX, isY, faceAxis, cell.add(jitter).div(grid).mul(2).sub(1));
  const dist = length(s.sub(starDir));
  // Full inside the radius (at least half a pixel), fading out over one pixel
  const radius = max(u.radius, pixel.mul(0.5));
  const coverage = float(1).sub(smoothstep(radius, radius.add(pixel), dist));

  const radiance = pow(level, BRIGHTNESS_POWER).mul(BRIGHTNESS_PEAK).add(BRIGHTNESS_FLOOR);
  const twinkle = float(1).add(
    sin(
      (time as unknown as THREE.Node<'float'>)
        .mul(u.twinkleFrequency.mul(Math.PI * 2))
        .mul(phase.add(0.5))
        .add(phase.mul(6.283))
    ).mul(u.twinkleAmount)
  );
  const ramp = mix(
    mix(vec3(STAR_BLUE.r, STAR_BLUE.g, STAR_BLUE.b), vec3(1), temperature.mul(2).clamp(0, 1)),
    vec3(STAR_ORANGE.r, STAR_ORANGE.g, STAR_ORANGE.b),
    temperature.mul(2).sub(1).clamp(0, 1)
  );
  const color = mix(vec3(1), ramp, u.colorVariance);
  return color.mul(radiance.mul(twinkle).mul(coverage).mul(gain)).mul(select(hasStar, 1, 0));
};

/** The Milky Way in direction `s` (the stars' frame): an fbm band around its pole. */
const milkyWay = (s: THREE.Node<'vec3'>, u: StarsUniforms) => {
  const offset = s.dot(u.milkyWayPole).div(u.milkyWayWidth);
  const band = offset.mul(offset).negate().exp();
  const clouds = fractalNoise(s.mul(MILKY_WAY_NOISE_SCALE), 4, 2, 0.5);
  const lanes = fractalNoise(s.mul(MILKY_WAY_NOISE_SCALE * 2.5).add(7.3), 3, 2, 0.5);
  const density = smoothstep(-0.3, 0.7, clouds).mul(smoothstep(-0.6, 0.2, lanes));
  return vec3(MILKY_WAY_COLOR.r, MILKY_WAY_COLOR.g, MILKY_WAY_COLOR.b).mul(
    band.mul(density).mul(u.milkyWayIntensity)
  );
};

/** The stars (and Milky Way) over `behind`; skipped entirely while their fade is 0 (by day).
 * @param boost the nebulae's star boost (their cube), or null without nebulae */
export const starsNode = (
  dir: THREE.Node<'vec3'>,
  behind: THREE.Node,
  u: StarsUniforms,
  hasMilkyWay: boolean,
  boost: StarBoostSource | null = null
): THREE.Node =>
  Fn(() => {
    const color = vec3(behind as THREE.Node<'vec3'>).toVar();
    // Built before the branch: TSL caches a node's value where it's first built, and `dir` is
    // shared with every layer after this one. First built inside the branch (a COLOR base
    // doesn't use it), it was unassigned whenever the branch was skipped, and by day the whole
    // sky became one flat colour.
    const s = u.rotation.mul(dir).toVar();
    If(u.fade.greaterThan(0), () => {
      // One pixel's angular size (from the continuous direction)
      const pixel = length(fwidth(s)).mul(0.75).toVar();
      const stars = starGrid(s, u.coarseGrid, COARSE_PROBABILITY, 1, 0, pixel, u, boost).add(
        starGrid(s, u.fineGrid, FINE_PROBABILITY, FINE_BRIGHTNESS, 0x51ed27, pixel, u, boost)
      );
      const light = hasMilkyWay ? stars.add(milkyWay(s, u)) : stars;
      color.addAssign(light.mul(u.brightness).mul(u.fade));
    });
    return color;
  })();
