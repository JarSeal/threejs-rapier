import type { Img } from './images';

/**
 * Alpha-coverage-preserving mips (p341; Castaño, "Computing alpha mipmaps", 2010, as NVTT's
 * `scaleAlphaForCoverage`): a mip level averages alpha, so an alpha test cuts a thin feature
 * whose texels fall below the cut. Each level's alpha is scaled so the share of it passing the
 * cut stays level 0's.
 */

/**
 * Bump when what {@link scaleAlphaForCoverage} writes changes: it is in the cache key of every
 * output built with `alphaCoverage`, so those are encoded again.
 */
export const ALPHA_COVERAGE_VERSION = 1;

/** x, y, width, height in texels, top-left origin */
export type CoverageRegion = [number, number, number, number];

/** Sub-samples per texel side: 4 × 4 bilinear taps a texel (Castaño's measure) */
const SUB_SAMPLES = 4;
/** Bisection steps once the scale is bracketed */
const SEARCH_STEPS = 12;
/** The bracket stops doubling here: 8-bit alpha's smallest step (1/255) reaches any cut */
const MAX_SCALE = 256;
/**
 * Alpha is measured as the encoder gets it, an 8-bit PNG (`encodePng` rounds the same way): the
 * search puts texels right at the cut, and measuring the floats would lose those that round below
 */
const ALPHA_STEPS = 255;

const getWholeRegion = (img: Img): CoverageRegion => [0, 0, img.width, img.height];

/** A region's alpha (the image's last channel), contiguous */
const readAlpha = (img: Img, [rx, ry, rw, rh]: CoverageRegion) => {
  const alpha = new Float32Array(rw * rh);
  const { width, channels, data } = img;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      alpha[y * rw + x] = data[((ry + y) * width + rx + x) * channels + channels - 1];
    }
  }
  return alpha;
};

/**
 * The bilinear taps along one side: per sub-sample the two texels it lies between and its weight
 * toward the second, clamped to the region's edge (an atlas cell's padding is its own edge
 * extended, so a GPU tap at its border reads the same)
 */
const getTaps = (size: number) => {
  const count = size * SUB_SAMPLES;
  const i0 = new Int32Array(count);
  const i1 = new Int32Array(count);
  const f = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Texel centres are at k + 0.5
    const u = (i + 0.5) / SUB_SAMPLES - 0.5;
    const k = Math.floor(u);
    i0[i] = Math.min(Math.max(k, 0), size - 1);
    i1[i] = Math.min(Math.max(k + 1, 0), size - 1);
    f[i] = u - k;
  }
  return { i0, i1, f };
};

type CoverageSampler = (scale: number) => number;

/**
 * Coverage of one region's alpha at any scale: the share of sub-samples whose bilinear alpha,
 * from the texels' `clamp(alpha × scale)` in 8 bits, is at least the cut (three's `alphaTest`
 * discards below it).
 */
const createCoverageSampler = (alpha: Float32Array, rw: number, rh: number, cut: number) => {
  const xs = getTaps(rw);
  const ys = getTaps(rh);
  const scaled = new Float32Array(alpha.length);
  const total = xs.f.length * ys.f.length;
  return ((scale: number) => {
    for (let i = 0; i < alpha.length; i++) {
      scaled[i] = Math.round(Math.min(1, alpha[i] * scale) * ALPHA_STEPS) / ALPHA_STEPS;
    }
    let passed = 0;
    for (let sy = 0; sy < ys.f.length; sy++) {
      const row0 = ys.i0[sy] * rw;
      const row1 = ys.i1[sy] * rw;
      const fy = ys.f[sy];
      for (let sx = 0; sx < xs.f.length; sx++) {
        const x0 = xs.i0[sx];
        const x1 = xs.i1[sx];
        const fx = xs.f[sx];
        const top = scaled[row0 + x0] + (scaled[row0 + x1] - scaled[row0 + x0]) * fx;
        const bottom = scaled[row1 + x0] + (scaled[row1 + x1] - scaled[row1 + x0]) * fx;
        if (top + (bottom - top) * fy >= cut) passed++;
      }
    }
    return passed / total;
  }) satisfies CoverageSampler;
};

/**
 * The share of `region` (default: the whole image) passing an alpha test at `cut`, measured
 * with 4 × 4 bilinear sub-samples per texel on the 8-bit alpha. The image's last channel is its
 * alpha.
 */
export const measureAlphaCoverage = (img: Img, cut: number, region = getWholeRegion(img)) =>
  createCoverageSampler(readAlpha(img, region), region[2], region[3], cut)(1);

/**
 * The alpha scale whose coverage is closest to `target`: coverage only grows with the scale, so
 * it is bracketed (doubling up from 1, or [0, 1]) and bisected. Ties keep the scale nearest 1, so
 * a level already at its target (an empty or opaque cell) is left as it is.
 */
const findAlphaScale = (coverageAt: CoverageSampler, target: number) => {
  const unscaled = coverageAt(1);
  let best = 1;
  let bestError = Math.abs(unscaled - target);
  const consider = (scale: number, coverage: number) => {
    const error = Math.abs(coverage - target);
    if (error < bestError || (error === bestError && Math.abs(scale - 1) < Math.abs(best - 1))) {
      best = scale;
      bestError = error;
    }
  };
  if (bestError === 0) return best;

  let low = 0;
  let high = 1;
  if (unscaled < target) {
    low = 1;
    high = 2;
    for (let coverage = coverageAt(high); coverage < target; coverage = coverageAt(high)) {
      consider(high, coverage);
      if (high >= MAX_SCALE) return best;
      low = high;
      high *= 2;
    }
  }
  for (let step = 0; step < SEARCH_STEPS && bestError > 0; step++) {
    const middle = (low + high) / 2;
    const coverage = coverageAt(middle);
    consider(middle, coverage);
    if (coverage < target) low = middle;
    else high = middle;
  }
  consider(high, coverageAt(high));
  return best;
};

/**
 * A copy of `img` whose alpha is scaled, region by region, so each region's coverage at `cut` is
 * the closest it gets to its target (`regions[i]` to `targets[i]`; default: the whole image to
 * `targets[0]`). Texels outside the regions are copied as they are. Returns the copy and each
 * region's scale (1: unchanged).
 */
export const scaleAlphaForCoverage = (
  img: Img,
  cut: number,
  targets: number[],
  regions: CoverageRegion[] = [getWholeRegion(img)]
) => {
  const out: Img = { ...img, data: img.data.slice() };
  const { width, channels } = img;
  const scales = regions.map((region, index) => {
    const [rx, ry, rw, rh] = region;
    const scale = findAlphaScale(
      createCoverageSampler(readAlpha(img, region), rw, rh, cut),
      targets[index]
    );
    if (scale !== 1) {
      for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
          const o = (y * width + x) * channels + channels - 1;
          out.data[o] = Math.min(1, img.data[o] * scale);
        }
      }
    }
    return scale;
  });
  return { image: out, scales };
};
