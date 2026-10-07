/**
 * A byte-exact RGBA8 PNG encoder (dev files' `encodePNG`, p342). A canvas can't do it: it stores
 * premultiplied alpha, so a fully transparent pixel loses its colour (an impostor atlas's
 * dilated texels). Rows are filtered with libpng's heuristic (per row, the filter whose output
 * has the smallest sum of absolute values) and deflated with `CompressionStream`.
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const BYTES_PER_PIXEL = 4;
const FILTER_COUNT = 5;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** Length, type, data and the CRC of type and data */
const createChunk = (type: string, data: Uint8Array) => {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
};

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** The filtered scanlines: per row its filter type byte and the filtered bytes */
const filterRows = (
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  flipY: boolean
) => {
  const stride = width * BYTES_PER_PIXEL;
  const out = new Uint8Array(height * (stride + 1));
  const candidates = Array.from({ length: FILTER_COUNT }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = (flipY ? height - 1 - y : y) * stride;
    const prev = y === 0 ? -1 : (flipY ? height - y : y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const value = pixels[row + x];
      const a = x >= BYTES_PER_PIXEL ? pixels[row + x - BYTES_PER_PIXEL] : 0;
      const b = prev >= 0 ? pixels[prev + x] : 0;
      const c = prev >= 0 && x >= BYTES_PER_PIXEL ? pixels[prev + x - BYTES_PER_PIXEL] : 0;
      // Uint8Array stores them modulo 256, as PNG's filters are defined
      candidates[0][x] = value;
      candidates[1][x] = value - a;
      candidates[2][x] = value - b;
      candidates[3][x] = value - ((a + b) >> 1);
      candidates[4][x] = value - paeth(a, b, c);
    }
    let bestFilter = 0;
    let bestSum = Infinity;
    for (let filter = 0; filter < FILTER_COUNT; filter++) {
      const candidate = candidates[filter];
      let sum = 0;
      for (let x = 0; x < stride && sum < bestSum; x++) {
        const v = candidate[x];
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestFilter = filter;
      }
    }
    const start = y * (stride + 1);
    out[start] = bestFilter;
    out.set(candidates[bestFilter], start + 1);
  }
  return out;
};

const deflate = async (data: Uint8Array) => {
  // 'deflate' is the zlib format (RFC 1950), which IDAT holds
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Encodes tightly packed RGBA8 rows (top row first, or bottom row first with `flipY`) as a PNG.
 * The caller checks that `pixels` holds `width × height × 4` bytes.
 */
export const encodeRGBA8PNG = async (
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  flipY = false
) => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // Bit depth
  header[9] = 6; // Colour type: RGBA
  // Compression, filter method and interlace: 0
  const compressed = await deflate(filterRows(pixels, width, height, flipY));
  return new Blob(
    [
      new Uint8Array(PNG_SIGNATURE),
      createChunk('IHDR', header),
      createChunk('IDAT', compressed),
      createChunk('IEND', new Uint8Array(0)),
    ],
    { type: 'image/png' }
  );
};
