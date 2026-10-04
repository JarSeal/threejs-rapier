import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { encodePng, type Img } from './images';
import { ensureKtx, getKtxEnv, type KtxTool } from './ktxTool';
import type { ResolvedTextureSettings } from './settings';
import { ROOT } from './sources';

/**
 * KTX2 encoding with the `ktx` CLI (p300 DD4): an image is written as an 8-bit PNG and encoded
 * by `ktx create`. The output depends only on the pixels and the options (not on the file
 * names), and `ktx` records the options in the order given (`KTXwriterScParams`), so the
 * argument order is Phase 1's (`phase1Variants.ts`), to reproduce its files byte for byte.
 */

const TMP_DIR = path.join(ROOT, '.cache', 'asset-pipeline', 'tmp');

export type KtxSettings = Exclude<ResolvedTextureSettings, { codec: 'none' }>;

/** Thrown when there is no working `ktx` and none could be set up (§8: "encoder missing"). */
export class EncoderMissingError extends Error {}

export type KtxProvider = () => Promise<KtxTool>;

/**
 * One `ensureKtx()` per run, called before the first encode only (so a run that encodes
 * nothing needs no `ktx`). A failure is kept too: the run doesn't retry the setup per asset, and
 * every asset gets the same reason (`runAssetsCommand` prints it once).
 */
export const createKtxProvider = (log?: (message: string) => void): KtxProvider => {
  let promise: Promise<KtxTool> | null = null;
  return () =>
    (promise ??= ensureKtx({ log }).catch((error: Error) => {
      throw new EncoderMissingError(error.message);
    }));
};

/** The `ktx create` options for an image with `channels` (3 or 4) channels. */
export const getKtxCreateArgs = (
  settings: KtxSettings,
  opts: { channels: 3 | 4; isSrgb: boolean; isNormal: boolean }
) => {
  const { isSrgb } = opts;
  return [
    '--format',
    `${opts.channels === 4 ? 'R8G8B8A8' : 'R8G8B8'}_${isSrgb ? 'SRGB' : 'UNORM'}`,
    '--assign-tf',
    isSrgb ? 'srgb' : 'linear',
    '--assign-primaries',
    isSrgb ? 'bt709' : 'none',
    ...(settings.mipmaps ? ['--generate-mipmap'] : []),
    ...(opts.isNormal ? ['--normalize'] : []),
    ...(settings.normalMode ? ['--normal-mode'] : []),
    ...(settings.codec === 'etc1s'
      ? ['--encode', 'basis-lz', '--qlevel', String(settings.quality)]
      : [
          '--encode',
          'uastc',
          '--uastc-quality',
          String(settings.level),
          ...(settings.rdo ? ['--uastc-rdo', '--uastc-rdo-l', String(settings.rdo)] : []),
          ...(settings.zstd ? ['--zstd', String(settings.zstd)] : []),
        ]),
  ];
};

/** One channel becomes RGB (grey, as a browser shows a grey PNG); two are written as RGB, B = 0. */
const toRgb = (img: Img): Img => {
  if (img.channels !== 1) return img;
  const out: Img = { ...img, channels: 3, data: new Float32Array(img.data.length * 3) };
  for (let i = 0; i < img.data.length; i++) out.data.fill(img.data[i], i * 3, i * 3 + 3);
  return out;
};

/**
 * Encodes linear float channels (already resized and flipped as they should be stored) as KTX2.
 * Throws {@link EncoderMissingError} without `ktx`, and an Error when `ktx create` fails.
 */
export const encodeKtx2 = async (
  img: Img,
  settings: KtxSettings,
  opts: { isSrgb: boolean; isNormal: boolean; getKtx: KtxProvider }
): Promise<Uint8Array> => {
  const tool = await opts.getKtx();
  const input = toRgb(img);
  const args = getKtxCreateArgs(settings, {
    channels: input.channels === 4 ? 4 : 3,
    isSrgb: opts.isSrgb,
    isNormal: opts.isNormal,
  });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_DIR, 'ktx-'));
  try {
    const inputFile = path.join(dir, 'input.png');
    const outputFile = path.join(dir, 'output.ktx2');
    fs.writeFileSync(inputFile, await encodePng(input, opts.isSrgb));
    try {
      await promisify(execFile)(tool.path, ['create', ...args, inputFile, outputFile], {
        env: getKtxEnv(tool),
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const { stderr, stdout, message } = error as { stderr?: string; stdout?: string } & Error;
      throw new Error(`ktx create ${args.join(' ')} failed: ${stderr || stdout || message}`);
    }
    return new Uint8Array(fs.readFileSync(outputFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
