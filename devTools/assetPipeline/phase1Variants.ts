/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { NodeIO, type Document } from '@gltf-transform/core';
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRTextureBasisu,
} from '@gltf-transform/extensions';
import { listTextureSlots, meshopt, quantize } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { ensureKtx, getKtxEnv, type KtxTool } from './ktxTool';

/**
 * p300 Phase 1c: builds the codec variants Phase 1 compares, from downloaded and committed
 * sources, plus a report of each one's size, estimated VRAM and error against its encoder input.
 * A throwaway for Phase 1: Phase 2's pipeline replaces it (its packing, encoding and metrics are
 * the reference for that).
 *
 * - `rocks01`: ambientCG Ground079S (CC0) packed as p303's LITE (`albedoRough`, `normalHeight`), 1K.
 * - `metalRust`: the committed Poliigon MetalRust 7642 set, ORM packed and normal, 1K, the normal
 *   also in `--normal-mode` (two channels: X in RGB, Y in alpha).
 * - `metalToolbox`: Poly Haven metal_toolbox (CC0) at 2K, meshopt + its three maps per variant.
 * - `colliders`: quantized and meshopt copies of three collider test models (DD6).
 *
 * Standalone textures are encoded flipped (they load with flipY, which compressed textures can't
 * apply), glTF textures as they are. Downloads go to the gitignored `.cache/p300-phase1/`, the
 * outputs to `src/public/debugger/assets/testOptimized/phase1/` (with `report.json`).
 *
 * Usage: `npx tsx devTools/assetPipeline/phase1Variants.ts [--only <group>] [--force]`
 * (`--force` re-encodes outputs that exist; groups: rocks01, metalRust, metalToolbox, colliders)
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_DIR = path.join(ROOT, '.cache', 'p300-phase1');
const TMP_DIR = path.join(CACHE_DIR, 'tmp');
const TEST_ASSETS_DIR = path.join(ROOT, 'src/public/debugger/assets');
const OUT_DIR = path.join(TEST_ASSETS_DIR, 'testOptimized/phase1');
const REPORT_FILE = path.join(OUT_DIR, 'report.json');
const USER_AGENT = 'aekasha-js asset pipeline (p300 phase 1)';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// p303 D3's example strength for AO multiplied into the albedo (LITE)
const AO_STRENGTH = 0.8;

const UASTC_ARGS = (rdoLambda?: number) => [
  '--encode',
  'uastc',
  '--uastc-quality',
  '2',
  ...(rdoLambda ? ['--uastc-rdo', '--uastc-rdo-l', String(rdoLambda)] : []),
  '--zstd',
  '18',
];

/** The codec variants every texture is encoded with (Zstd applies to UASTC only) */
const CODEC_VARIANTS = [
  { id: 'etc1s_q128', codec: 'etc1s', args: ['--encode', 'basis-lz', '--qlevel', '128'] },
  { id: 'etc1s_q255', codec: 'etc1s', args: ['--encode', 'basis-lz', '--qlevel', '255'] },
  { id: 'uastc', codec: 'uastc', args: UASTC_ARGS() },
  { id: 'uastc_rdo1', codec: 'uastc', args: UASTC_ARGS(1) },
  { id: 'uastc_rdo2', codec: 'uastc', args: UASTC_ARGS(2) },
  { id: 'uastc_rdo4', codec: 'uastc', args: UASTC_ARGS(4) },
] as const;
type CodecVariant = (typeof CODEC_VARIANTS)[number];

// ---------------------------------------------------------------------------------------------
// Images: float channels in 0..1, colour channels linear while packing and resizing
// ---------------------------------------------------------------------------------------------

type Img = { width: number; height: number; channels: number; data: Float32Array };

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * Reads an image (8 or 16 bits) as floats.
 * @param opts.channels keep the first N channels (default: all)
 * @param opts.srgbChannels decode the first N channels from sRGB to linear (default: none)
 */
const readImage = async (
  input: string | Buffer,
  opts: { channels?: number; srgbChannels?: number } = {}
): Promise<Img> => {
  const meta = await sharp(input).metadata();
  const is16 = meta.depth === 'ushort';
  // sharp outputs 8-bit sRGB unless told to keep a 16-bit colour space
  const image = is16
    ? sharp(input)
        .toColourspace(meta.channels < 3 ? 'grey16' : 'rgb16')
        .raw({ depth: 'ushort' })
    : sharp(input).raw();
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  const src = is16
    ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    : data;
  const max = is16 ? 65535 : 255;
  const channels = opts.channels ?? info.channels;
  const srgbChannels = opts.srgbChannels ?? 0;
  const pixels = info.width * info.height;
  const out = new Float32Array(pixels * channels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < channels; c++) {
      const v = src[i * info.channels + Math.min(c, info.channels - 1)] / max;
      out[i * channels + c] = c < srgbChannels ? srgbToLinear(v) : v;
    }
  }
  return { width: info.width, height: info.height, channels, data: out };
};

const createImage = (width: number, height: number, channels: number): Img => ({
  width,
  height,
  channels,
  data: new Float32Array(width * height * channels),
});

/** A 2×2 box filter (exact for a 2:1 step); normals are renormalized after averaging. */
const halve = (img: Img, isNormal: boolean): Img => {
  const { channels: ch } = img;
  const out = createImage(img.width >> 1, img.height >> 1, ch);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const o = (y * out.width + x) * ch;
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += img.data[((y * 2 + dy) * img.width + x * 2 + dx) * ch + c];
          }
        }
        out.data[o + c] = sum / 4;
      }
      if (isNormal) {
        const nx = out.data[o] * 2 - 1;
        const ny = out.data[o + 1] * 2 - 1;
        const nz = out.data[o + 2] * 2 - 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        out.data[o] = (nx / len + 1) / 2;
        out.data[o + 1] = (ny / len + 1) / 2;
        out.data[o + 2] = (nz / len + 1) / 2;
      }
    }
  }
  return out;
};

const resizeTo = (img: Img, size: number, isNormal = false) => {
  if (img.width !== img.height || (img.width & (img.width - 1)) !== 0 || img.width < size) {
    throw new Error(
      `Expected a square power-of-two source ≥ ${size}, got ${img.width}×${img.height}`
    );
  }
  let out = img;
  while (out.width > size) out = halve(out, isNormal);
  return out;
};

const flipY = (img: Img): Img => {
  const out = createImage(img.width, img.height, img.channels);
  const row = img.width * img.channels;
  for (let y = 0; y < img.height; y++) {
    out.data.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
  }
  return out;
};

/** Writes 8-bit PNG, encoding the first `srgbChannels` channels from linear to sRGB. */
const writePng = async (img: Img, file: string, srgbChannels: number) => {
  const bytes = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) {
    const v = i % img.channels < srgbChannels ? linearToSrgb(img.data[i]) : img.data[i];
    bytes[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const channels = img.channels as 1 | 2 | 3 | 4;
  await sharp(bytes, { raw: { width: img.width, height: img.height, channels } })
    .png({ compressionLevel: 9 })
    .toFile(file);
};

// ---------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------

const download = async (url: string, file: string, md5?: string) => {
  if (fs.existsSync(file)) return file;
  console.log(`  ↓ ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (md5 && crypto.createHash('md5').update(bytes).digest('hex') !== md5) {
    throw new Error(`${url}: MD5 mismatch`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
};

/** Downloads an ambientCG zip and extracts the maps matched by file-name suffix. */
const fetchAmbientCG = async (assetId: string, variant: string, maps: Record<string, string>) => {
  const dir = path.join(CACHE_DIR, assetId);
  const zipName = `${assetId}_${variant}.zip`;
  const zipFile = await download(
    `https://ambientcg.com/get?file=${zipName}`,
    path.join(dir, zipName)
  );
  let entries: Record<string, Uint8Array> | null = null;
  const files: Record<string, string> = {};
  for (const [map, suffix] of Object.entries(maps)) {
    const existing = fs.readdirSync(dir).find((name) => name.endsWith(suffix));
    if (existing) {
      files[map] = path.join(dir, existing);
      continue;
    }
    entries ??= unzipSync(new Uint8Array(fs.readFileSync(zipFile)));
    const name = Object.keys(entries).find((entry) => entry.endsWith(suffix));
    if (!name) throw new Error(`${zipName}: no file ending with "${suffix}"`);
    files[map] = path.join(dir, path.basename(name));
    fs.writeFileSync(files[map], entries[name]);
  }
  return files;
};

type PolyHavenFile = { url: string; md5: string; size: number };

/** Downloads a Poly Haven model's glTF (with its .bin and textures) at one resolution. */
const fetchPolyHavenGltf = async (assetId: string, resolution: string) => {
  const dir = path.join(CACHE_DIR, assetId);
  const listFile = await download(
    `https://api.polyhaven.com/files/${assetId}`,
    path.join(dir, 'files.json')
  );
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  const gltf: PolyHavenFile & { include: Record<string, PolyHavenFile> } =
    list.gltf[resolution].gltf;
  for (const [relPath, file] of Object.entries(gltf.include)) {
    await download(file.url, path.join(dir, relPath), file.md5);
  }
  return download(gltf.url, path.join(dir, path.basename(gltf.url)), gltf.md5);
};

// ---------------------------------------------------------------------------------------------
// Encoding and measuring
// ---------------------------------------------------------------------------------------------

/** What a texture holds: decides its KTX2 format, transfer function and error metrics. */
type TexKind = 'color' | 'normal' | 'normalHeight' | 'data';

type TextureMetrics = {
  /** PSNR (dB) of the transcoded base level against the encoder input, per channel group */
  psnr: Record<string, number>;
  /** The largest error of one texel, in 8-bit steps */
  maxAbs: Record<string, number>;
  /** Angle between the decoded and the input normal (degrees) */
  normalErrorDeg?: { mean: number; p99: number; max: number };
};

type TextureReport = {
  group: string;
  texture: string;
  kind: TexKind;
  variant: string;
  normalMode?: boolean;
  file: string;
  bytes: number;
  width: number;
  height: number;
  encodeMs?: number;
  ktxArgs?: string;
  /** Estimated with the full mip chain: RGBA8 (an uncompressed upload), BC7 / ASTC 4×4
   * (1 B/px), and ETC2 (ETC1S without alpha transcodes to ETC2 RGB, 0.5 B/px) */
  vramBytes: { rgba8: number; bc7Astc: number; etc2: number };
  metrics?: TextureMetrics;
};

type TextureSpec = {
  kind: TexKind;
  /** Channel group names for the metrics, eg. ['ao', 'roughness', 'metalness'] */
  channelNames?: string[];
};

const mipChainBytes = (width: number, height: number, blockSize: number, blockBytes: number) => {
  let total = 0;
  let w = width;
  let h = height;
  for (;;) {
    total += Math.ceil(w / blockSize) * Math.ceil(h / blockSize) * blockBytes;
    if (w === 1 && h === 1) return total;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
};

const estimateVram = (width: number, height: number, codec: string | null, hasAlpha: boolean) => ({
  rgba8: mipChainBytes(width, height, 1, 4),
  bc7Astc: mipChainBytes(width, height, 4, 16),
  etc2: mipChainBytes(width, height, 4, codec === 'etc1s' && !hasAlpha ? 8 : 16),
});

const ktxFormatArgs = (kind: TexKind, channels: number) => {
  const srgb = kind === 'color';
  const format = `${channels === 4 ? 'R8G8B8A8' : 'R8G8B8'}_${srgb ? 'SRGB' : 'UNORM'}`;
  return [
    '--format',
    format,
    '--assign-tf',
    srgb ? 'srgb' : 'linear',
    '--assign-primaries',
    srgb ? 'bt709' : 'none',
  ];
};

const runKtx = (tool: KtxTool, ktxArgs: string[]) => {
  const res = spawnSync(tool.path, ktxArgs, { encoding: 'utf8', env: getKtxEnv(tool) });
  if (res.status !== 0) {
    throw new Error(`ktx ${ktxArgs.join(' ')}\n${res.stderr || res.stdout || res.error}`);
  }
};

const encodeKtx = (
  tool: KtxTool,
  input: string,
  output: string,
  spec: TextureSpec,
  channels: number,
  variant: CodecVariant,
  normalMode: boolean
) => {
  const options = [
    ...ktxFormatArgs(spec.kind, channels),
    '--generate-mipmap',
    ...(spec.kind === 'normal' ? ['--normalize'] : []),
    ...(normalMode ? ['--normal-mode'] : []),
    ...variant.args,
  ];
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const start = performance.now();
  runKtx(tool, ['create', ...options, input, output]);
  return { encodeMs: Math.round(performance.now() - start), ktxArgs: options.join(' ') };
};

/** Transcodes a KTX2 file's base level back to RGBA8 (through a PNG), as raw 0..1 values. */
const decodeKtx = async (tool: KtxTool, file: string) => {
  const png = path.join(TMP_DIR, 'decoded.png');
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.rmSync(png, { force: true });
  runKtx(tool, ['extract', '--transcode', 'rgba8', '--level', '0', file, png]);
  return readImage(png);
};

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/** PSNR and max error over a channel group; `get` returns a texel's value in 0..1. */
const channelError = (
  pixels: number,
  channels: number[],
  getRef: (i: number, c: number) => number,
  getDec: (i: number, c: number) => number
) => {
  let squared = 0;
  let max = 0;
  for (let i = 0; i < pixels; i++) {
    for (const c of channels) {
      const d = getRef(i, c) - getDec(i, c);
      squared += d * d;
      max = Math.max(max, Math.abs(d));
    }
  }
  const mse = squared / (pixels * channels.length);
  return {
    psnr: mse === 0 ? 99 : round(Math.min(99, 10 * Math.log10(1 / mse))),
    maxAbs: round(max * 255, 0),
  };
};

/**
 * The decoded texture against its encoder input. Normal-mode files decode as (X, Y, 0), or with
 * Y in alpha; their Z and LITE's (normalHeight) are reconstructed, as the shader would.
 */
const measure = (ref: Img, dec: Img, spec: TextureSpec, normalMode: boolean): TextureMetrics => {
  if (ref.width !== dec.width || ref.height !== dec.height) {
    throw new Error(`Decoded ${dec.width}×${dec.height}, expected ${ref.width}×${ref.height}`);
  }
  const pixels = ref.width * ref.height;
  const getRef = (i: number, c: number) => ref.data[i * ref.channels + c];
  const getDec = (i: number, c: number) => dec.data[i * dec.channels + c];
  const metrics: TextureMetrics = { psnr: {}, maxAbs: {} };
  const add = (name: string, channels: number[], decode = getDec) => {
    const { psnr, maxAbs } = channelError(pixels, channels, getRef, decode);
    metrics.psnr[name] = psnr;
    metrics.maxAbs[name] = maxAbs;
  };

  if (spec.kind === 'color') {
    add('rgb', [0, 1, 2]);
    if (ref.channels === 4) add(spec.channelNames?.[0] || 'a', [3]);
  } else if (spec.kind === 'data') {
    const names = spec.channelNames || ['r', 'g', 'b', 'a'];
    for (let c = 0; c < ref.channels; c++) add(names[c], [c]);
  } else {
    // Normal-mode: Y is in G when the decode dropped alpha, else in alpha
    const decY = normalMode && dec.channels === 4 ? 3 : 1;
    add('xy', [0, 1], (i, c) => getDec(i, c === 1 ? decY : 0));
    if (spec.kind === 'normalHeight') add('height', [2]);
    const reconstructZ = spec.kind === 'normalHeight' || normalMode;
    const angles = new Float32Array(pixels);
    let sum = 0;
    for (let i = 0; i < pixels; i++) {
      const toNormal = (x: number, y: number, z: number | null) => {
        const nx = x * 2 - 1;
        const ny = y * 2 - 1;
        const nz = z === null ? Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) : z * 2 - 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        return [nx / len, ny / len, nz / len];
      };
      const a = toNormal(getRef(i, 0), getRef(i, 1), reconstructZ ? null : getRef(i, 2));
      const b = toNormal(getDec(i, 0), getDec(i, decY), reconstructZ ? null : getDec(i, 2));
      const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      angles[i] = (Math.acos(dot) * 180) / Math.PI;
      sum += angles[i];
    }
    angles.sort();
    metrics.normalErrorDeg = {
      mean: round(sum / pixels, 3),
      p99: round(angles[Math.floor(pixels * 0.99)], 2),
      max: round(angles[pixels - 1], 2),
    };
  }
  return metrics;
};

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

type ModelReport = {
  group: string;
  model: string;
  variant: string;
  file: string;
  bytes: number;
  /** Vertex + index bytes as uploaded (quantized attributes stay quantized in VRAM) */
  geometryBytes: number;
  textures?: TextureReport[];
  /** Collider nodes' transforms, to check where quantization put the dequantization */
  colliderNodes?: { name: string; colliderType: string; translation: number[]; scale: number[] }[];
};

type Report = {
  generated: string;
  ktxVersion: string;
  sources: Record<string, { provider: string; page: string; license: string; note?: string }>;
  textures: TextureReport[];
  models: ModelReport[];
};

const report: Report = fs.existsSync(REPORT_FILE)
  ? JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
  : { generated: '', ktxVersion: '', sources: {}, textures: [], models: [] };

const rel = (file: string) => path.relative(OUT_DIR, file).split(path.sep).join('/');

const setTextureReport = (entry: TextureReport) => {
  report.textures = report.textures.filter((t) => t.file !== entry.file);
  report.textures.push(entry);
};

const setModelReport = (entry: ModelReport) => {
  report.models = report.models.filter((m) => m.file !== entry.file);
  report.models.push(entry);
};

const fileSize = (file: string) => fs.statSync(file).size;

// ---------------------------------------------------------------------------------------------
// Standalone textures
// ---------------------------------------------------------------------------------------------

type TextureJob = TextureSpec & {
  group: string;
  name: string;
  /** Also encode every codec variant in `--normal-mode` */
  normalMode?: boolean;
  /** Linear colour channels at the output size */
  build: () => Promise<Img>;
};

const runTextureJob = async (tool: KtxTool, job: TextureJob) => {
  const dir = path.join(OUT_DIR, job.group);
  const baseline = path.join(dir, `${job.name}.png`);
  const ktxInput = path.join(TMP_DIR, job.group, `${job.name}_flipped.png`);
  const srgbChannels = job.kind === 'color' ? 3 : 0;

  if (FORCE || !fs.existsSync(baseline) || !fs.existsSync(ktxInput)) {
    console.log(`  ${job.group}/${job.name}: packing`);
    const img = await job.build();
    await writePng(img, baseline, srgbChannels);
    await writePng(flipY(img), ktxInput, srgbChannels);
  }
  const ref = await readImage(ktxInput);
  const hasAlpha = ref.channels === 4;
  setTextureReport({
    group: job.group,
    texture: job.name,
    kind: job.kind,
    variant: 'png',
    file: rel(baseline),
    bytes: fileSize(baseline),
    width: ref.width,
    height: ref.height,
    vramBytes: estimateVram(ref.width, ref.height, null, hasAlpha),
  });

  for (const normalMode of job.normalMode ? [false, true] : [false]) {
    for (const variant of CODEC_VARIANTS) {
      const id = `${normalMode ? 'nm_' : ''}${variant.id}`;
      const output = path.join(dir, `${job.name}_${id}.ktx2`);
      const previous = report.textures.find((t) => t.file === rel(output));
      if (!FORCE && previous?.metrics && fs.existsSync(output)) continue;
      const encoded = encodeKtx(tool, ktxInput, output, job, ref.channels, variant, normalMode);
      const metrics = measure(ref, await decodeKtx(tool, output), job, normalMode);
      setTextureReport({
        group: job.group,
        texture: job.name,
        kind: job.kind,
        variant: id,
        ...(normalMode ? { normalMode } : {}),
        file: rel(output),
        bytes: fileSize(output),
        width: ref.width,
        height: ref.height,
        ...encoded,
        vramBytes: estimateVram(ref.width, ref.height, variant.codec, hasAlpha || normalMode),
        metrics,
      });
      console.log(
        `  ${rel(output)}: ${(fileSize(output) / 1024).toFixed(0)} KB, ${encoded.encodeMs} ms`
      );
    }
  }
};

const rocks01Jobs = async (): Promise<TextureJob[]> => {
  report.sources.rocks01 = {
    provider: 'ambientCG',
    page: 'https://ambientcg.com/view?id=Ground079S',
    license: 'CC0-1.0',
    note: `2K-JPG, packed as p303 LITE at 1K (AO strength ${AO_STRENGTH})`,
  };
  const raw = await fetchAmbientCG('Ground079S', '2K-JPG', {
    color: '_Color.jpg',
    normal: '_NormalGL.jpg',
    roughness: '_Roughness.jpg',
    ao: '_AmbientOcclusion.jpg',
    height: '_Displacement.jpg',
  });
  return [
    {
      group: 'rocks01',
      name: 'albedoRough',
      kind: 'color',
      channelNames: ['roughness'],
      build: async () => {
        const color = await readImage(raw.color, { channels: 3, srgbChannels: 3 });
        const ao = await readImage(raw.ao, { channels: 1 });
        const rough = await readImage(raw.roughness, { channels: 1 });
        const out = createImage(color.width, color.height, 4);
        for (let i = 0; i < color.width * color.height; i++) {
          const occlusion = 1 + (ao.data[i] - 1) * AO_STRENGTH;
          for (let c = 0; c < 3; c++) out.data[i * 4 + c] = color.data[i * 3 + c] * occlusion;
          out.data[i * 4 + 3] = rough.data[i];
        }
        return resizeTo(out, 1024);
      },
    },
    {
      group: 'rocks01',
      name: 'normalHeight',
      kind: 'normalHeight',
      build: async () => {
        const normal = resizeTo(await readImage(raw.normal, { channels: 3 }), 1024, true);
        const height = await readImage(raw.height, { channels: 1 });
        // p303 D2: height remapped to the full 0..1 range
        let min = Infinity;
        let max = -Infinity;
        for (const v of height.data) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        for (let i = 0; i < height.data.length; i++) {
          height.data[i] = (height.data[i] - min) / (max - min || 1);
        }
        const heightSmall = resizeTo(height, 1024);
        for (let i = 0; i < heightSmall.data.length; i++)
          normal.data[i * 3 + 2] = heightSmall.data[i];
        return normal;
      },
    },
  ];
};

const metalRustJobs = (): TextureJob[] => {
  const src = (map: string) =>
    path.join(TEST_ASSETS_DIR, 'testTextures', `Poliigon_MetalRust_7642_${map}`);
  report.sources.metalRust = {
    provider: 'Poliigon',
    page: 'https://www.poliigon.com/texture/7642',
    license: 'Poliigon free asset (already committed in testTextures/)',
    note: 'ORM packed from AO / Roughness / Metallic, 2K → 1K',
  };
  return [
    {
      group: 'metalRust',
      name: 'orm',
      kind: 'data',
      channelNames: ['ao', 'roughness', 'metalness'],
      build: async () => {
        const maps = await Promise.all(
          ['AmbientOcclusion.jpg', 'Roughness.jpg', 'Metallic.jpg'].map((map) =>
            readImage(src(map), { channels: 1 })
          )
        );
        const out = createImage(maps[0].width, maps[0].height, 3);
        for (let i = 0; i < maps[0].data.length; i++) {
          for (let c = 0; c < 3; c++) out.data[i * 3 + c] = maps[c].data[i];
        }
        return resizeTo(out, 1024);
      },
    },
    {
      group: 'metalRust',
      name: 'normal',
      kind: 'normal',
      normalMode: true,
      build: async () => resizeTo(await readImage(src('Normal.png'), { channels: 3 }), 1024, true),
    },
  ];
};

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

const createIO = () =>
  new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

const getGeometryBytes = (doc: Document) => {
  let bytes = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      bytes += prim.getIndices()?.getByteLength() || 0;
      for (const attribute of prim.listAttributes()) bytes += attribute.getByteLength();
    }
  }
  return bytes;
};

const textureKind = (slots: string[]): TexKind => {
  if (slots.includes('normalTexture')) return 'normal';
  if (slots.includes('baseColorTexture') || slots.includes('emissiveTexture')) return 'color';
  return 'data';
};

const runMetalToolbox = async (tool: KtxTool) => {
  report.sources.metalToolbox = {
    provider: 'Poly Haven',
    page: 'https://polyhaven.com/a/metal_toolbox',
    license: 'CC0-1.0',
    note: '2K glTF; the ARM map is glTF ORM (occlusion + metallicRoughness share it)',
  };
  const gltfFile = await fetchPolyHavenGltf('metal_toolbox', '2k');
  const dir = path.join(OUT_DIR, 'metalToolbox');
  const io = createIO();
  await MeshoptEncoder.ready;

  const source = path.join(dir, 'source.glb');
  if (FORCE || !fs.existsSync(source)) {
    fs.mkdirSync(dir, { recursive: true });
    await io.write(source, await io.read(gltfFile));
  }
  const sourceDoc = await io.read(gltfFile);
  setModelReport({
    group: 'metalToolbox',
    model: 'metal_toolbox',
    variant: 'source',
    file: rel(source),
    bytes: fileSize(source),
    geometryBytes: getGeometryBytes(sourceDoc),
  });

  for (const variant of CODEC_VARIANTS) {
    const output = path.join(dir, `${variant.id}.glb`);
    if (!FORCE && fs.existsSync(output) && report.models.some((m) => m.file === rel(output))) {
      continue;
    }
    const doc = await io.read(gltfFile);
    await doc.transform(meshopt({ encoder: MeshoptEncoder }));
    const textures: TextureReport[] = [];
    for (const texture of doc.getRoot().listTextures()) {
      const name = path.basename(texture.getURI(), path.extname(texture.getURI()));
      const spec: TextureSpec = {
        kind: textureKind(listTextureSlots(texture)),
        channelNames: ['ao', 'roughness', 'metalness'],
      };
      const input = path.join(TMP_DIR, 'metalToolbox', `${name}.png`);
      const encodedFile = path.join(TMP_DIR, 'metalToolbox', `${name}_${variant.id}.ktx2`);
      fs.mkdirSync(path.dirname(input), { recursive: true });
      await sharp(texture.getImage()!).png({ compressionLevel: 1 }).toFile(input);
      const ref = await readImage(input);
      const encoded = encodeKtx(tool, input, encodedFile, spec, ref.channels, variant, false);
      const metrics = measure(ref, await decodeKtx(tool, encodedFile), spec, false);
      const bytes = fs.readFileSync(encodedFile);
      texture.setImage(new Uint8Array(bytes)).setMimeType('image/ktx2').setURI(`${name}.ktx2`);
      textures.push({
        group: 'metalToolbox',
        texture: name,
        kind: spec.kind,
        variant: variant.id,
        file: `${rel(output)}#${name}`,
        bytes: bytes.length,
        width: ref.width,
        height: ref.height,
        ...encoded,
        vramBytes: estimateVram(ref.width, ref.height, variant.codec, ref.channels === 4),
        metrics,
      });
    }
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    await io.write(output, doc);
    setModelReport({
      group: 'metalToolbox',
      model: 'metal_toolbox',
      variant: variant.id,
      file: rel(output),
      bytes: fileSize(output),
      geometryBytes: getGeometryBytes(doc),
      textures,
    });
    console.log(`  ${rel(output)}: ${(fileSize(output) / 1024).toFixed(0)} KB`);
  }
};

const COLLIDER_SOURCES = ['stairsStraightTrimesh', 'obstacles', 'terrainSmooth'];

/**
 * Collider copies for DD6: `quantized` (KHR_mesh_quantization only), `meshopt` (gltf-transform's
 * `meshopt()`: reorder + quantize + filters, what the default profile does) and
 * `meshoptLossless` (EXT_meshopt_compression alone: no reorder, no quantization, no filters).
 */
const COLLIDER_VARIANTS: { id: string; apply: (doc: Document) => Promise<unknown> }[] = [
  { id: 'quantized', apply: (doc) => doc.transform(quantize()) },
  { id: 'meshopt', apply: (doc) => doc.transform(meshopt({ encoder: MeshoptEncoder })) },
  {
    id: 'meshoptLossless',
    apply: async (doc) =>
      doc
        .createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE }),
  },
];

const getColliderNodes = (doc: Document) =>
  doc
    .getRoot()
    .listNodes()
    .filter(
      (node) => node.getMesh() && (node.getExtras() as { colliderType?: string }).colliderType
    )
    .map((node) => ({
      name: node.getName(),
      colliderType: String((node.getExtras() as { colliderType: string }).colliderType),
      translation: node.getTranslation().map((v) => round(v, 6)),
      scale: node.getScale().map((v) => Number(v.toPrecision(6))),
    }));

const runColliders = async () => {
  const io = createIO();
  await MeshoptEncoder.ready;
  const dir = path.join(OUT_DIR, 'colliders');
  fs.mkdirSync(dir, { recursive: true });
  for (const model of COLLIDER_SOURCES) {
    const sourceFile = path.join(TEST_ASSETS_DIR, 'testModels', `${model}.glb`);
    const sourceDoc = await io.read(sourceFile);
    setModelReport({
      group: 'colliders',
      model,
      variant: 'source',
      file: path.relative(OUT_DIR, sourceFile).split(path.sep).join('/'),
      bytes: fileSize(sourceFile),
      geometryBytes: getGeometryBytes(sourceDoc),
      colliderNodes: getColliderNodes(sourceDoc),
    });
    for (const variant of COLLIDER_VARIANTS) {
      const output = path.join(dir, `${model}_${variant.id}.glb`);
      const doc = await io.read(sourceFile);
      await variant.apply(doc);
      if (FORCE || !fs.existsSync(output)) await io.write(output, doc);
      setModelReport({
        group: 'colliders',
        model,
        variant: variant.id,
        file: rel(output),
        bytes: fileSize(output),
        geometryBytes: getGeometryBytes(doc),
        colliderNodes: getColliderNodes(doc),
      });
    }
    console.log(`  colliders/${model}: ${COLLIDER_VARIANTS.map((v) => v.id).join(', ')}`);
  }
};

// ---------------------------------------------------------------------------------------------

const GROUPS: Record<string, (tool: KtxTool) => Promise<void>> = {
  rocks01: async (tool) => {
    for (const job of await rocks01Jobs()) await runTextureJob(tool, job);
  },
  metalRust: async (tool) => {
    for (const job of metalRustJobs()) await runTextureJob(tool, job);
  },
  metalToolbox: runMetalToolbox,
  colliders: runColliders,
};

try {
  if (ONLY && !GROUPS[ONLY]) throw new Error(`Unknown group "${ONLY}" (${Object.keys(GROUPS)})`);
  const tool = await ensureKtx({ log: (message) => console.log(`  ${message}`) });
  for (const [group, run] of Object.entries(GROUPS)) {
    if (ONLY && group !== ONLY) continue;
    console.log(`[p300] ${group}`);
    await run(tool);
  }
  report.generated = new Date().toISOString();
  report.ktxVersion = tool.version;
  report.textures.sort((a, b) => a.file.localeCompare(b.file));
  report.models.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\x1b[32m✓ [p300] ${path.relative(ROOT, REPORT_FILE)}\x1b[0m`);
} catch (error) {
  console.error(`\x1b[31m✗ [p300] ${(error as Error).stack || error}\x1b[0m`);
  process.exitCode = 1;
}
