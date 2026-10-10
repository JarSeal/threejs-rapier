/**
 * The scene runner's snapshot comparison (`scenes.ts`): an RGBA8 PNG against its baseline, with
 * the tolerance of `scenes.config.ts`.
 */
import sharp from 'sharp';
import type { SnapshotTolerance } from './scenes.config';

const readRGBA = async (png: Buffer | string) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

export type SnapshotDiff = { meanDelta: number; changedRatio: number; maxDelta: number };

/** Compares two RGBA8 images over RGB; when they differ beyond the tolerance, writes `diffFile`
 * (the current image dimmed, the changed pixels red) */
export const compareSnapshots = async (
  currentPng: Buffer,
  baselineFile: string,
  tolerance: SnapshotTolerance,
  diffFile: string
): Promise<SnapshotDiff | { sizeMismatch: string }> => {
  const current = await readRGBA(currentPng);
  const baseline = await readRGBA(baselineFile);
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return {
      sizeMismatch: `${current.width} × ${current.height}, baseline ${baseline.width} × ${baseline.height}`,
    };
  }
  const pixels = current.width * current.height;
  const diff = Buffer.alloc(pixels * 4);
  let sum = 0;
  let changed = 0;
  let maxDelta = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(current.data[i + c] - baseline.data[i + c]);
      sum += d;
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax > maxDelta) maxDelta = pixelMax;
    const isChanged = pixelMax > tolerance.pixelThreshold;
    if (isChanged) changed++;
    const grey = (current.data[i] + current.data[i + 1] + current.data[i + 2]) / 12;
    diff[i] = isChanged ? 255 : grey;
    diff[i + 1] = isChanged ? 0 : grey;
    diff[i + 2] = isChanged ? 0 : grey;
    diff[i + 3] = 255;
  }
  const result = { meanDelta: sum / (pixels * 3), changedRatio: changed / pixels, maxDelta };
  if (
    result.meanDelta > tolerance.maxMeanDelta ||
    result.changedRatio > tolerance.maxChangedRatio
  ) {
    await sharp(diff, { raw: { width: current.width, height: current.height, channels: 4 } })
      .png()
      .toFile(diffFile);
  }
  return result;
};
