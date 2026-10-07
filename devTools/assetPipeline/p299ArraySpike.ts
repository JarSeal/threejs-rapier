/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { ensureKtx, getKtxEnv } from './ktxTool';

/**
 * p299 Phase 0: the spike's test files, for the `textureArraySpike` scene.
 *
 * - `arr2_<codec>.ktx2`: a two-layer array encoded by `ktx create --layers 2` (layers 0 and 1).
 * - `s<i>_<codec>.ktx2`: layers 0-3 as single textures, for runtime assembly and the layer swap.
 * - `perf/m<nn>_uastc.ktx2`: 16 single 1K members, for timing CPU concatenation against
 *   `copyTextureToTexture` assembly.
 *
 * Each layer is white with `i + 1` coloured vertical stripes and a black bar at its top, so a
 * wrong layer or a flipped one shows. Encoded flipped, like the pipeline's standalone textures.
 * A throwaway for Phase 0: Phase 2 adds `--layers` to the pipeline itself.
 *
 * Usage: `npx tsx devTools/assetPipeline/p299ArraySpike.ts [--force]`
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'src/public/debugger/assets/testOptimized/p299');
const TMP_DIR = path.join(ROOT, '.cache', 'p299-spike');
const FORCE = process.argv.includes('--force');

const LAYER_COLORS: [number, number, number][] = [
  [220, 40, 40],
  [40, 180, 60],
  [40, 90, 220],
  [230, 200, 40],
];

const CODEC_ARGS = {
  etc1s: ['--encode', 'basis-lz', '--qlevel', '128'],
  uastc: ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18'],
} as const;
type Codec = keyof typeof CODEC_ARGS;

/** A layer image (top row first), written as a flipped PNG. */
const writeLayerPng = async (
  file: string,
  size: number,
  stripes: number,
  color: [number, number, number]
) => {
  const data = Buffer.alloc(size * size * 3);
  const barHeight = Math.max(4, size >> 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isStripe = Math.floor((x * stripes * 2) / size) % 2 === 1;
      const c = y < barHeight ? [0, 0, 0] : isStripe ? color : [255, 255, 255];
      data.set(c, (y * size + x) * 3);
    }
  }
  await sharp(data, { raw: { width: size, height: size, channels: 3 } })
    .flip()
    .png()
    .toFile(file);
};

const main = async () => {
  const tool = await ensureKtx({ log: console.log });
  const ktxCreate = (codec: Codec, inputs: string[], output: string, layers?: number) => {
    if (!FORCE && fs.existsSync(output)) return;
    const args = [
      'create',
      '--format',
      'R8G8B8_SRGB',
      '--assign-tf',
      'srgb',
      '--assign-primaries',
      'bt709',
      '--generate-mipmap',
      ...CODEC_ARGS[codec],
      ...(layers ? ['--layers', String(layers)] : []),
      ...inputs,
      output,
    ];
    execFileSync(tool.path, args, { env: getKtxEnv(tool) });
    console.log(`  ${path.relative(ROOT, output)} (${fs.statSync(output).size} B)`);
  };

  fs.mkdirSync(path.join(OUT_DIR, 'perf'), { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const layerPngs: string[] = [];
  for (let i = 0; i < LAYER_COLORS.length; i++) {
    const file = path.join(TMP_DIR, `l${i}.png`);
    await writeLayerPng(file, 256, i + 1, LAYER_COLORS[i]);
    layerPngs.push(file);
  }
  for (const codec of Object.keys(CODEC_ARGS) as Codec[]) {
    ktxCreate(codec, layerPngs.slice(0, 2), path.join(OUT_DIR, `arr2_${codec}.ktx2`), 2);
    layerPngs.forEach((png, i) =>
      ktxCreate(codec, [png], path.join(OUT_DIR, `s${i}_${codec}.ktx2`))
    );
  }

  for (let i = 0; i < 16; i++) {
    const nn = String(i).padStart(2, '0');
    const png = path.join(TMP_DIR, `m${nn}.png`);
    const hue = (i / 16) * Math.PI * 2;
    const color = [0, 2, 4].map((k) =>
      Math.round(127 + 100 * Math.cos(hue + (k * Math.PI) / 3))
    ) as [number, number, number];
    await writeLayerPng(png, 1024, (i % 8) + 1, color);
    ktxCreate('uastc', [png], path.join(OUT_DIR, 'perf', `m${nn}_uastc.ktx2`));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
