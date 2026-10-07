import fs from 'fs';

/**
 * Image I/O and resizing for the pipeline (p300 DD5, §4). sharp only reads and writes files; the
 * maths runs in plain JS on floats (0..1), colour channels linear, and is quantized to 8 bits
 * once, when written. The arithmetic matches Phase 1's (`phase1Variants.ts`), so the same source
 * and settings give the same encoder input, byte for byte.
 */

/** sharp is a native module: loaded on first use, so importing the pipeline (the gatherer, the
 * Vite config) doesn't load it. */
const loadSharp = async () => (await import('sharp')).default;

/** Interleaved float channels, 0..1 */
export type Img = { width: number; height: number; channels: number; data: Float32Array };

/** A decoded file: its integer samples as they are (8 or 16 bits), decoded per channel on demand */
export type SourceImage = {
  width: number;
  height: number;
  channels: number;
  samples: Uint8Array | Uint16Array;
  max: number;
};

export const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

export const createImage = (width: number, height: number, channels: number): Img => ({
  width,
  height,
  channels,
  data: new Float32Array(width * height * channels),
});

/** Reads an image file at its own bit depth (sharp returns 8-bit sRGB unless told otherwise). */
export const readSourceImage = async (input: string | Buffer): Promise<SourceImage> => {
  const sharp = await loadSharp();
  const meta = await sharp(input).metadata();
  const is16 = meta.depth === 'ushort';
  const image = is16
    ? sharp(input)
        .toColourspace(meta.channels < 3 ? 'grey16' : 'rgb16')
        .raw({ depth: 'ushort' })
    : sharp(input).raw();
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  const samples = is16
    ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    samples,
    max: is16 ? 65535 : 255,
  };
};

/** An image file's size and channel count, from its header (no pixels are decoded) */
export const readImageInfo = async (input: string | Buffer) => {
  const sharp = await loadSharp();
  const { width, height, channels } = await sharp(input).metadata();
  return { width, height, channels };
};

const readBytes = (fd: number, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
};

/** JPEG start-of-frame markers (C0-CF but DHT C4, JPG C8 and DAC CC): they hold the size */
const isJpegFrameMarker = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * An image file's size from its header, synchronously (the gatherer is synchronous, sharp isn't):
 * PNG, JPEG and WebP. The size sharp decodes (no EXIF orientation applied). Null for another
 * format, or a header it can't read.
 */
export const readImageSizeSync = (file: string): { width: number; height: number } | null => {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readBytes(fd, 0, 30);
    if (
      head.length >= 24 &&
      head.readUInt32BE(0) === 0x89504e47 &&
      head.readUInt32BE(4) === 0x0d0a1a0a
    ) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (
      head.length >= 30 &&
      head.toString('ascii', 0, 4) === 'RIFF' &&
      head.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const chunk = head.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') {
        return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = head.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
      }
      return null;
    }
    if (head.length < 2 || head[0] !== 0xff || head[1] !== 0xd8) return null;
    // JPEG: walk the segments to the frame header
    let position = 2;
    for (;;) {
      const marker = readBytes(fd, position, 4);
      if (marker.length < 4 || marker[0] !== 0xff) return null;
      if (marker[1] === 0xff) {
        position++; // Fill byte
        continue;
      }
      if (isJpegFrameMarker(marker[1])) {
        const frame = readBytes(fd, position + 5, 4);
        return frame.length < 4
          ? null
          : { width: frame.readUInt16BE(2), height: frame.readUInt16BE(0) };
      }
      position += 2 + marker.readUInt16BE(2);
    }
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Where a channel letter is in an image's samples: grey (+ alpha) images have their grey in r, g
 * and b. Returns -1 for alpha in an image without one.
 */
export const getSampleIndex = (image: { channels: number }, letter: string) => {
  const hasAlpha = image.channels === 2 || image.channels === 4;
  if (letter === 'a') return hasAlpha ? image.channels - 1 : -1;
  const index = 'rgb'.indexOf(letter);
  return image.channels < 3 ? 0 : index;
};

/** One channel as floats, decoded from sRGB to linear when asked */
export const extractChannel = (image: SourceImage, sampleIndex: number, isSrgb: boolean): Img => {
  const out = createImage(image.width, image.height, 1);
  const { samples, channels, max } = image;
  for (let i = 0; i < out.data.length; i++) {
    const v = samples[i * channels + sampleIndex] / max;
    out.data[i] = isSrgb ? srgbToLinear(v) : v;
  }
  return out;
};

/** The first `count` channels, interleaved, as raw (linear) floats */
export const extractChannels = (image: SourceImage, count: number): Img => {
  const out = createImage(image.width, image.height, count);
  const { samples, channels, max } = image;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < count; c++) {
      out.data[i * count + c] = samples[i * channels + Math.min(c, channels - 1)] / max;
    }
  }
  return out;
};

/**
 * A whole image file as floats for the encoder: grey becomes RGB (grey + alpha RGBA), as a
 * browser decodes it, and the colour channels are decoded from sRGB to linear when `isSrgb`.
 * @param opts.rgbOnly drop the alpha (a normal map's XYZ)
 */
export const readImageFile = async (
  input: string | Buffer,
  opts: { isSrgb: boolean; rgbOnly?: boolean }
): Promise<Img> => {
  const image = await readSourceImage(input);
  const hasAlpha = !opts.rgbOnly && getSampleIndex(image, 'a') >= 0;
  const indices = [...(hasAlpha ? 'rgba' : 'rgb')].map((letter) => getSampleIndex(image, letter));
  const out = createImage(image.width, image.height, indices.length);
  const { samples, channels, max } = image;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < indices.length; c++) {
      const v = samples[i * channels + indices[c]] / max;
      out.data[i * indices.length + c] = opts.isSrgb && c < 3 ? srgbToLinear(v) : v;
    }
  }
  return out;
};

/** Normalizes each texel's first three channels as a tangent-space normal (0..1 encoded). */
const renormalize = (img: Img, o: number) => {
  const nx = img.data[o] * 2 - 1;
  const ny = img.data[o + 1] * 2 - 1;
  const nz = img.data[o + 2] * 2 - 1;
  const len = Math.hypot(nx, ny, nz) || 1;
  img.data[o] = (nx / len + 1) / 2;
  img.data[o + 1] = (ny / len + 1) / 2;
  img.data[o + 2] = (nz / len + 1) / 2;
};

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
      if (isNormal) renormalize(out, o);
    }
  }
  return out;
};

/** Each output texel covers a span of source texels: their overlap is its weight. */
const getAreaWeights = (srcSize: number, dstSize: number) => {
  const scale = srcSize / dstSize;
  return Array.from({ length: dstSize }, (_, i) => {
    const start = i * scale;
    const end = start + scale;
    const taps: { index: number; weight: number }[] = [];
    for (let s = Math.floor(start); s < Math.min(srcSize, Math.ceil(end)); s++) {
      const weight = Math.min(end, s + 1) - Math.max(start, s);
      if (weight > 0) taps.push({ index: s, weight: weight / scale });
    }
    return taps;
  });
};

/** An area (box) filter for any ratio, separable; up-scaling repeats texels. */
const resampleArea = (img: Img, width: number, height: number, isNormal: boolean): Img => {
  const { channels: ch } = img;
  const xTaps = getAreaWeights(img.width, width);
  const yTaps = getAreaWeights(img.height, height);
  const rows = createImage(width, img.height, ch);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (const tap of xTaps[x])
          sum += img.data[(y * img.width + tap.index) * ch + c] * tap.weight;
        rows.data[(y * width + x) * ch + c] = sum;
      }
    }
  }
  const out = createImage(width, height, ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (const tap of yTaps[y]) sum += rows.data[(tap.index * width + x) * ch + c] * tap.weight;
        out.data[o + c] = sum;
      }
      if (isNormal) renormalize(out, o);
    }
  }
  return out;
};

/**
 * Resizes linear values: exact 2:1 box steps while both sides can halve, then an area filter for
 * what's left. Normal maps (`isNormal`, the first three channels) are renormalized at each step.
 */
export const resizeImage = (img: Img, width: number, height: number, isNormal = false): Img => {
  let out = img;
  while (
    out.width >= width * 2 &&
    out.height >= height * 2 &&
    out.width % 2 === 0 &&
    out.height % 2 === 0
  ) {
    out = halve(out, isNormal);
  }
  if (out.width !== width || out.height !== height) {
    out = resampleArea(out, width, height, isNormal);
  }
  return out;
};

/**
 * The encoded size of a `width`×`height` image: fit into `maxSize` (never up), then, for a
 * block-compressed codec, rounded to multiples of 4. `stretch` is how far that rounding moved
 * the aspect ratio (0.01 = 1%), for a warning.
 */
export const getOutputSize = (
  width: number,
  height: number,
  opts: { maxSize: number | null; isBlockCompressed: boolean }
) => {
  const scale = opts.maxSize ? Math.min(1, opts.maxSize / Math.max(width, height)) : 1;
  let outWidth = Math.max(1, Math.round(width * scale));
  let outHeight = Math.max(1, Math.round(height * scale));
  if (opts.isBlockCompressed) {
    outWidth = Math.max(4, Math.round(outWidth / 4) * 4);
    outHeight = Math.max(4, Math.round(outHeight / 4) * 4);
  }
  const stretch = Math.abs(outWidth / outHeight / (width / height) - 1);
  return { width: outWidth, height: outHeight, stretch };
};

export const flipY = (img: Img): Img => {
  const out = createImage(img.width, img.height, img.channels);
  const row = img.width * img.channels;
  for (let y = 0; y < img.height; y++) {
    out.data.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
  }
  return out;
};

/**
 * Encodes an 8-bit PNG, the colour channels (r, g, b; never alpha) from linear to sRGB when
 * `isSrgb`. A PNG's two-channel form is grey + alpha, so two channels are written as RGB, B = 0.
 */
export const encodePng = async (img: Img, isSrgb: boolean) => {
  const channels = img.channels === 2 ? 3 : img.channels;
  const srgbChannels = isSrgb ? Math.min(channels, 3) : 0;
  const sharp = await loadSharp();
  const pixels = img.width * img.height;
  const bytes = new Uint8Array(pixels * channels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < channels; c++) {
      const value = c < img.channels ? img.data[i * img.channels + c] : 0;
      const v = c < srgbChannels ? linearToSrgb(value) : value;
      bytes[i * channels + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return sharp(bytes, {
    raw: { width: img.width, height: img.height, channels: channels as 1 | 3 | 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
};
