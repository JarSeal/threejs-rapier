import fs from 'fs';
import path from 'path';
import { NON_COVERAGE_SLOTS, type TextureSlot } from '../../src/_engine/schemas/assetsConfigSchema';
import {
  DEFAULT_ATLAS_PADDING,
  getFullMipLevelCount,
  type AtlasMipChain,
  type TextureAtlasAsset,
  type TextureAtlasCellInfo,
  type TextureAtlasSlot,
} from '../../src/_engine/schemas/textureAtlasSchema';
import {
  ALPHA_COVERAGE_VERSION,
  measureAlphaCoverage,
  scaleAlphaForCoverage,
  type CoverageRegion,
} from './alphaCoverage';
import { createImage, flipY, halve, resizeImage, toChannels, type Img } from './images';
import { encodeKtx2Levels, type KtxProvider, type KtxSettings } from './ktxEncode';
import { getAtlasLogicalPath, writeOutput, type PipelineOutput } from './outputs';
import { toRepoPath } from './sources';
import {
  getTextureSourceKeyParam,
  listTextureSourceFiles,
  probeTextureSource,
  readTextureSource,
  readTextureSourceSizeSync,
  resolveTextureSourceRef,
  type TextureArrayLayer,
  type TextureLookup,
} from './textureArrays';
import { describeEncodedTexture, type EncodedTexture } from './textures';

/**
 * Build-time 2D atlases (p299 D3): a `*.textureAtlas.json`'s cells resolved to what the pipeline
 * reads (each source like an array layer: a texture asset's source or pack, or a file of the
 * JSON's own) and laid out. The layout is shared by every slot, and decides the cell table and
 * the mip levels the slots keep.
 *
 * Mip bleeding: a cell's content is surrounded by `padding` px of its own edge, extended. At mip
 * level `L` a texel covers 2^L × 2^L px and a 4 × 4 compression block 4·2^L px, so the levels stay
 * apart while `padding ≥ 2^L`, every padded rect is aligned to 4·2^L and the atlas to 2^L: no texel
 * and no block then holds two cells (a block's shared endpoints pull its texels toward each other),
 * and a bilinear tap at a cell's edge lands in its own padding. The chain stops at the last such
 * level (with box filtered levels; a wider filter, like ktx's default lanczos4, would reach
 * further), unless the atlas asks for the full chain (`mipChain: "FULL"`, p351 Phase 4: cells whose
 * neighbours are near-identical, which may mix at the smallest levels).
 *
 * A slot with an `image` (p351 Phase 4) is a ready-made image of the whole layout, eg. an exported
 * impostor's atlas: it isn't composed, so its cells are where their `rect`s say.
 */

/** x, y, width, height in px, top-left origin */
export type AtlasRect = [number, number, number, number];

export type AtlasCellLayout = {
  id: string;
  /** The padded rect */
  rect: AtlasRect;
  /** The content inside it */
  content: AtlasRect;
  /** By slot; a slot left out gets its fill */
  sources: Record<string, TextureArrayLayer>;
  data?: Record<string, unknown>;
};

export type TextureAtlasLayout = {
  size: [number, number];
  padding: number;
  /** Mip levels the layout keeps apart, level 0 included */
  levels: number;
  mipChain: AtlasMipChain;
  cells: AtlasCellLayout[];
  /** The slots with a ready-made image (`slots.<name>.image`), by slot */
  images: Record<string, TextureArrayLayer>;
};

/** Block compression's grid: every rect is on it */
const BLOCK_SIZE = 4;
/** log2(BLOCK_SIZE): a rect aligned to 2^a keeps whole blocks up to level a - BLOCK_LEVELS */
const BLOCK_LEVELS = 2;

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step;

/** The exponent of the largest power of two dividing a px value (0: any) */
const getAlignmentLevel = (value: number) => (value === 0 ? Infinity : Math.log2(value & -value));

const overlaps = (a: AtlasRect, b: AtlasRect) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

const formatRect = (rect: AtlasRect) => `[${rect.join(', ')}]`;

export type AtlasCellInput = {
  /** Names the cell in messages, eg. 'cells[2] ("crackA")' */
  label: string;
  /** Explicit, the padding included */
  rect?: AtlasRect;
  /** The content's size (with `rect`: the rect less its padding) */
  contentSize: [number, number];
};

/**
 * Places the cells: those with a `rect` where it says (multiples of 4, inside the atlas, larger
 * than their padding, not overlapping), the rest by a shelf packer, tallest first, each padded and
 * rounded up to the alignment grid (4·2^⌊log2 padding⌋: whole blocks at every level the padding
 * protects). Returns each cell's padded rect (null for one that failed), the levels the layout
 * keeps apart, and every problem, each naming its cell.
 * @param opts.mipChain 'FULL' stores every level whatever the layout keeps apart, so it doesn't
 * warn about what shortens the protected chain
 */
export const layoutAtlasCells = (
  size: [number, number],
  padding: number,
  cells: AtlasCellInput[],
  opts: { mipChain?: AtlasMipChain } = {}
) => {
  const [width, height] = size;
  const errors: string[] = [];
  const warnings: string[] = [];
  const rects: (AtlasRect | null)[] = cells.map(() => null);
  const paddingLevel = padding >= 1 ? Math.floor(Math.log2(padding)) : 0;
  const grid = BLOCK_SIZE * 2 ** paddingLevel;

  cells.forEach(({ label, rect }, index) => {
    if (!rect) return;
    const [x, y, w, h] = rect;
    if (rect.some((value) => value % BLOCK_SIZE)) {
      errors.push(
        `${label}: rect ${formatRect(rect)} isn't on the 4 px block grid (multiples of 4)`
      );
    } else if (x + w > width || y + h > height) {
      errors.push(`${label}: rect ${formatRect(rect)} reaches out of the ${width}×${height} atlas`);
    } else if (w <= padding * 2 || h <= padding * 2) {
      errors.push(
        `${label}: rect ${formatRect(rect)} has no room for content inside its padding (${padding} px a side)`
      );
    } else {
      const other = rects.findIndex((placed) => placed && overlaps(placed, rect));
      if (other >= 0) {
        errors.push(`${label}: rect ${formatRect(rect)} overlaps ${cells[other].label}'s`);
      } else {
        rects[index] = rect;
      }
    }
  });

  const occupied = rects.filter((rect): rect is AtlasRect => !!rect);
  const padded = cells.map(({ contentSize }) => [
    roundUp(contentSize[0] + padding * 2, grid),
    roundUp(contentSize[1] + padding * 2, grid),
  ]);
  const order = cells
    .map((_cell, index) => index)
    .filter((index) => !cells[index].rect)
    .sort((a, b) => padded[b][1] - padded[a][1] || padded[b][0] - padded[a][0] || a - b);
  let shelfY = 0;
  let shelfHeight = 0;
  let x = 0;
  for (const index of order) {
    const [w, h] = padded[index];
    let placed: AtlasRect | null = null;
    while (!placed && w <= width) {
      if (x + w > width) {
        // An empty shelf (explicit rects in the way) steps down by one grid row
        shelfY += shelfHeight || grid;
        shelfHeight = 0;
        x = 0;
      }
      if (shelfY + h > height) break;
      const candidate: AtlasRect = [x, shelfY, w, h];
      const hit = occupied.find((rect) => overlaps(candidate, rect));
      if (hit) x = roundUp(hit[0] + hit[2], grid);
      else placed = candidate;
    }
    if (!placed) {
      const [cw, ch] = cells[index].contentSize;
      errors.push(
        `${cells[index].label}: ${w}×${h} px (its ${cw}×${ch} content, ${padding} px of padding a side, on the ${grid} px grid) doesn't fit in the ${width}×${height} atlas next to the cells placed before it: enlarge "size", lower "padding" or the cell's "size", or place cells with "rect"`
      );
      continue;
    }
    rects[index] = placed;
    occupied.push(placed);
    x += w;
    shelfHeight = Math.max(shelfHeight, h);
  }

  // The levels: what the padding protects, less what the atlas size isn't aligned to (texels:
  // 2^L) or a rect isn't (blocks: 4·2^L)
  const sizeLevel = Math.min(getAlignmentLevel(width), getAlignmentLevel(height));
  let level = Math.min(paddingLevel, sizeLevel);
  const limits: string[] = [];
  if (sizeLevel < paddingLevel) {
    limits.push(
      `the atlas size ${width}×${height} is only aligned to ${2 ** sizeLevel} px (it needs ${2 ** paddingLevel})`
    );
  }
  rects.forEach((rect, index) => {
    if (!rect) return;
    const alignLevel = Math.min(...rect.map(getAlignmentLevel));
    const rectLevel = alignLevel - BLOCK_LEVELS;
    if (rectLevel < paddingLevel) {
      limits.push(
        `${cells[index].label}'s rect ${formatRect(rect)} is only aligned to ${2 ** alignLevel} px (it needs ${grid}: the ${BLOCK_SIZE}×${BLOCK_SIZE} compression blocks at level ${paddingLevel} cover ${grid} px)`
      );
    }
    level = Math.min(level, rectLevel);
  });
  if (limits.length && opts.mipChain !== 'FULL') {
    warnings.push(
      `the mip chain stops at level ${level} (${2 ** level} px), where the padding (${padding} px) keeps levels 0-${paddingLevel} apart: ${limits.join('; ')}`
    );
  }
  return { rects, levels: level + 1, errors, warnings };
};

/**
 * Resolves an atlas: the slots' ready-made images (`image`, resolved like a cell source; their
 * size must be the layout's, from the file header), its cells' sources (see
 * `resolveTextureSourceRef`; a source in an sRGB slot is read as sRGB), their content sizes (a
 * `rect` less its padding, a `size`, else the first source's, in the order of `slots`, from its
 * file header) and the layout (see {@link layoutAtlasCells}). With an image slot every cell needs
 * a `rect` (where it is in the image) and none has a source in that slot. Every problem is in
 * `errors`, each naming its cell or slot; `layout` is null when there is one. `warnings` are worth
 * a look, eg. a rect that shortens the mip chain.
 * @param jsonFile The atlas's JSON, absolute or relative to the repo root
 */
export const resolveTextureAtlas = (
  jsonFile: string,
  data: Pick<TextureAtlasAsset, 'size' | 'padding' | 'mipChain' | 'slots' | 'cells'>,
  findTexture: TextureLookup
): { layout: TextureAtlasLayout | null; errors: string[]; warnings: string[] } => {
  const padding = data.padding ?? DEFAULT_ATLAS_PADDING;
  const mipChain = data.mipChain ?? 'PROTECTED';
  const slotNames = Object.keys(data.slots);
  const errors: string[] = [];
  const ids = new Map<string, number>();
  const inputs: AtlasCellInput[] = [];
  const cells: Omit<AtlasCellLayout, 'rect' | 'content'>[] = [];

  const images: Record<string, TextureArrayLayer> = {};
  for (const [slot, { image, texOpts }] of Object.entries(data.slots)) {
    if (!image) continue;
    const label = `slots.${slot}.image ("${image}")`;
    const source = resolveTextureSourceRef(jsonFile, image, findTexture, {
      isSrgb: texOpts?.colorSpace === 'srgb',
      target: `the slot "${slot}"`,
    });
    if (typeof source === 'string') {
      errors.push(`${label}: ${source}`);
      continue;
    }
    try {
      const size = readTextureSourceSizeSync(source);
      if (!size) {
        errors.push(
          `${label}: its size isn't read without decoding it (only PNG, JPEG and WebP headers are), and it must be the atlas's ${data.size.join('×')}`
        );
      } else if (size.width !== data.size[0] || size.height !== data.size[1]) {
        errors.push(
          `${label}: it is ${size.width}×${size.height} and the atlas ${data.size.join('×')} ("size"): a slot's image is the whole layout, never resized`
        );
      } else {
        images[slot] = source;
      }
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`);
    }
  }
  const imageSlots = slotNames.filter((slot) => data.slots[slot].image);
  const composedSlots = slotNames.filter((slot) => !data.slots[slot].image);

  data.cells.forEach((cell, index) => {
    const label = `cells[${index}] ("${cell.id}")`;
    const other = ids.get(cell.id);
    if (other !== undefined) errors.push(`${label}: cells[${other}] has the same id`);
    else ids.set(cell.id, index);
    if (imageSlots.length && !cell.rect) {
      errors.push(
        `${label}: no "rect", and slots.${imageSlots[0]} is a ready-made image: every cell needs its rect in it`
      );
    }

    const sources: Record<string, TextureArrayLayer> = {};
    const refs = Object.entries(cell.sources ?? {});
    // A cell is in every image slot already
    if (!refs.length && !imageSlots.length) {
      errors.push(`${label}: no sources (a cell is an image in one slot or more)`);
    }
    for (const [slot, ref] of refs) {
      if (!data.slots[slot]) {
        errors.push(`${label}: sources.${slot}: no such slot (slots: ${slotNames.join(', ')})`);
        continue;
      }
      if (data.slots[slot].image) {
        errors.push(
          `${label}: sources.${slot}: the slot is a ready-made image (slots.${slot}.image), so the cell is already in it`
        );
        continue;
      }
      const source = resolveTextureSourceRef(jsonFile, ref, findTexture, {
        isSrgb: data.slots[slot].texOpts?.colorSpace === 'srgb',
        target: `the slot "${slot}"`,
      });
      if (typeof source === 'string')
        errors.push(`${label}: sources.${slot} ("${ref}"): ${source}`);
      else sources[slot] = source;
    }

    let contentSize: [number, number] | null = null;
    if (cell.rect) {
      contentSize = [cell.rect[2] - padding * 2, cell.rect[3] - padding * 2];
    } else if (cell.size) {
      contentSize = cell.size;
    } else {
      const slot = slotNames.find((name) => sources[name]);
      if (slot) {
        try {
          const size = readTextureSourceSizeSync(sources[slot]);
          if (size) {
            contentSize = [size.width, size.height];
          } else {
            errors.push(
              `${label}: the size of sources.${slot} ("${cell.sources?.[slot]}") isn't read without decoding it (only PNG, JPEG and WebP headers are): set the cell's "size"`
            );
          }
        } catch (error) {
          errors.push(`${label}: sources.${slot}: ${(error as Error).message}`);
        }
      }
    }
    inputs.push({ label, rect: cell.rect, contentSize: contentSize ?? [1, 1] });
    cells.push({ id: cell.id, sources, ...(cell.data ? { data: cell.data } : {}) });
  });
  if (errors.length) return { layout: null, errors, warnings: [] };

  const layout = layoutAtlasCells(data.size, padding, inputs, { mipChain });
  if (layout.errors.length) return { layout: null, errors: layout.errors, warnings: [] };
  for (const slot of composedSlots) {
    if (!cells.some(({ sources }) => sources[slot])) {
      layout.warnings.push(`slots.${slot}: no cell has a source in it, so it is its fill alone`);
    }
  }
  return {
    layout: {
      size: data.size,
      padding,
      levels: layout.levels,
      mipChain,
      images,
      cells: cells.map((cell, index) => {
        const rect = layout.rects[index]!;
        const [cw, ch] = inputs[index].contentSize;
        return { ...cell, rect, content: [rect[0] + padding, rect[1] + padding, cw, ch] };
      }),
    },
    errors: [],
    warnings: layout.warnings,
  };
};

/**
 * The cell table (`__atlas.cells`): each cell's content rect as UVs with v up (three's: a KTX2
 * output is stored flipped, like every standalone texture), its size in px and its `data`.
 */
export const getAtlasCellTable = (layout: TextureAtlasLayout) => {
  const [width, height] = layout.size;
  return Object.fromEntries(
    layout.cells.map(({ id, content: [x, y, w, h], data }): [string, TextureAtlasCellInfo] => [
      id,
      {
        uv: [x / width, 1 - (y + h) / height, (x + w) / width, 1 - y / height],
        size: [w, h],
        ...(data ? { data } : {}),
      },
    ])
  );
};

/**
 * One slot of an atlas as the pipeline builds it: like an array, it has no single source file, so
 * its rules match, and its output is named after, the atlas's JSON. Each slot is its own pipeline
 * asset (its own `optimize`, output, cache entry and budget), all sharing the layout.
 */
export type AtlasSlotSource = {
  kind: 'atlas';
  /** The atlas's JSON, absolute */
  jsonFile: string;
  /** The atlas's JSON, '/'-separated, relative to the repo root */
  repoPath: string;
  atlasId: string;
  /** The slot's name in the JSON */
  slot: string;
  size: [number, number];
  padding: number;
  /** Mip levels the layout keeps apart (level 0 included) */
  levels: number;
  /** Set when the file stores every level down to 1 × 1, past `levels` */
  mipChain?: 'FULL';
  /** The slot's `fill`, as the JSON has it */
  fill?: TextureAtlasSlot['fill'];
  /** The slot's ready-made image of the whole layout: then no cell has a `source` */
  image?: TextureArrayLayer;
  /** The slot's `optimize.alphaCoverage` (p341): the cut each level's coverage is kept at */
  alphaCoverage?: number;
  /** In the JSON's order; `source` unset: the slot's fill (or its image) */
  cells: { id: string; rect: AtlasRect; content: AtlasRect; source?: TextureArrayLayer }[];
};

export const createAtlasSlotSource = (
  jsonFile: string,
  atlasId: string,
  layout: TextureAtlasLayout,
  slot: string,
  opts: { fill?: TextureAtlasSlot['fill']; alphaCoverage?: number } = {}
): AtlasSlotSource => {
  const file = path.resolve(jsonFile);
  const { fill, alphaCoverage } = opts;
  return {
    kind: 'atlas',
    jsonFile: file,
    repoPath: toRepoPath(file),
    atlasId,
    slot,
    size: layout.size,
    padding: layout.padding,
    levels: layout.levels,
    ...(layout.mipChain === 'FULL' ? { mipChain: 'FULL' as const } : {}),
    ...(fill ? { fill } : {}),
    ...(layout.images[slot] ? { image: layout.images[slot] } : {}),
    ...(alphaCoverage !== undefined ? { alphaCoverage } : {}),
    cells: layout.cells.map(({ id, rect, content, sources }) => ({
      id,
      rect,
      content,
      ...(sources[slot] ? { source: sources[slot] } : {}),
    })),
  };
};

/**
 * Every file a slot's encode reads: its image, else cell by cell (a pack's files in its order). A
 * file two cells read is listed twice: the cache key hashes the files in this order.
 */
export const listTextureAtlasFiles = (source: AtlasSlotSource) =>
  source.image
    ? listTextureSourceFiles(source.image)
    : source.cells.flatMap((cell) => (cell.source ? listTextureSourceFiles(cell.source) : []));

/**
 * The cache key's inputs (besides the files, the settings and the colour space): the layout as
 * this slot draws it (each cell's rects and what its source is, a file, a pack's recipe or the
 * fill), the fill, the image, the full chain, the alpha coverage (with its maths' version) and
 * the output's name. The full chain, the image and the alpha coverage only when set, so the keys
 * of the atlases without them didn't change.
 */
export const getTextureAtlasKeyParams = (source: AtlasSlotSource) => ({
  size: source.size,
  padding: source.padding,
  levels: source.levels,
  ...(source.mipChain ? { mipChain: source.mipChain } : {}),
  ...(source.alphaCoverage !== undefined
    ? { alphaCoverage: { cut: source.alphaCoverage, version: ALPHA_COVERAGE_VERSION } }
    : {}),
  ...(source.image ? { image: getTextureSourceKeyParam(source.image) } : {}),
  fill: source.fill ?? null,
  cells: source.cells.map(({ rect, content, source: cellSource }) => ({
    rect,
    content,
    source: cellSource ? getTextureSourceKeyParam(cellSource) : null,
  })),
  output: getAtlasLogicalPath(source.jsonFile, source.slot),
});

const getCellLabel = (source: AtlasSlotSource, index: number) =>
  `cells[${index}] ("${source.cells[index].id}")`;

/**
 * Draws `img` (the atlas's channel count, at the content's size) into the cell's content rect and
 * extends its edges over the rest of the padded rect: each padding texel takes the nearest content
 * texel's value, so a level's texels that a bilinear tap at the cell's edge reaches are its own.
 */
const drawCell = (atlas: Img, img: Img, rect: AtlasRect, content: AtlasRect) => {
  const channels = atlas.channels;
  const [rx, ry, rw, rh] = rect;
  const [cx, cy, cw, ch] = content;
  for (let y = ry; y < ry + rh; y++) {
    const sy = Math.min(Math.max(y - cy, 0), ch - 1);
    for (let x = rx; x < rx + rw; x++) {
      const sx = Math.min(Math.max(x - cx, 0), cw - 1);
      const from = (sy * cw + sx) * channels;
      const to = (y * atlas.width + x) * channels;
      for (let c = 0; c < channels; c++) atlas.data[to + c] = img.data[from + c];
    }
  }
};

/**
 * The cut a slot's levels keep their coverage at (p341), or undefined. Checked against what the
 * slot resolves to, which the schema only sees when the JSON names it: throws for a slot whose
 * alpha isn't coverage (a normal map's, data, `normalMode`'s Y), and warns that it does nothing
 * without alpha or mipmaps.
 */
const getCoverageCut = (
  source: AtlasSlotSource,
  slot: TextureSlot,
  settings: KtxSettings,
  hasAlpha: boolean,
  warn: (message: string) => void
) => {
  const cut = source.alphaCoverage;
  if (cut === undefined) return undefined;
  const label = `slots.${source.slot}.optimize.alphaCoverage`;
  if (NON_COVERAGE_SLOTS.includes(slot) || settings.normalMode) {
    const what = settings.normalMode ? 'normalMode, whose alpha is Y' : `the slot "${slot}"`;
    throw new Error(
      `${label}: the slot resolves to ${what}: its alpha isn't coverage, and scaling it would change its data`
    );
  }
  if (!hasAlpha) {
    warn(`${label}: the slot has no alpha channel, so there is no coverage to keep`);
    return undefined;
  }
  if (!settings.mipmaps) {
    warn(`${label}: mipmaps are off, so there are no levels to scale`);
    return undefined;
  }
  return cut;
};

/**
 * Encodes an atlas slot (p299 D3): the layout filled with the slot's `fill` (RGB(A), linear;
 * default transparent black, an RGB fill is opaque), each cell's source resized into its content
 * rect and edge-extended over its padding (or the slot's ready-made `image`, as it is), then
 * box-filtered levels (exact 2×2 halving, as `images.ts` does) down to the last one the layout
 * keeps apart, or with the full chain down to 1×1 (an odd size area-filtered), as one KTX2 with
 * `ktx create --levels`. A source with alpha, or a fill with alpha below 1, makes the slot RGBA.
 * With `alphaCoverage` (p341) each stored level past 0 has its alpha scaled to level 0's coverage
 * at that cut: cell by cell while the layout keeps them apart, the whole image past that.
 * `maxSize` drops the top levels until one fits (the cells stay aligned), with a warning. Warns
 * for a source that is upscaled or stretched into its cell. Throws, naming the cell, for a source
 * that can't be read, for an image that isn't the layout's size, and when `maxSize` leaves none of
 * the levels the layout keeps apart.
 */
export const encodeTextureAtlasSlot = async (
  source: AtlasSlotSource,
  slot: TextureSlot,
  settings: KtxSettings,
  opts: { isSrgb: boolean; getKtx: KtxProvider; warn: (message: string) => void }
): Promise<{ output: PipelineOutput; texture: EncodedTexture }> => {
  const isNormal = slot === 'normal';
  const [width, height] = source.size;
  const withLabel = async <T>(index: number, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      const label = `${getCellLabel(source, index)}: sources.${source.slot}`;
      throw new Error(`${label}: ${(error as Error).message}`);
    }
  };

  const { image } = source;
  const imageProbe = image
    ? await (async () => {
        try {
          return await probeTextureSource(image, isNormal);
        } catch (error) {
          throw new Error(`slots.${source.slot}.image: ${(error as Error).message}`);
        }
      })()
    : null;
  if (imageProbe && (imageProbe.width !== width || imageProbe.height !== height)) {
    throw new Error(
      `slots.${source.slot}.image is ${imageProbe.width}×${imageProbe.height} and the atlas ${width}×${height}: a slot's image is the whole layout, never resized`
    );
  }

  const probes: (Awaited<ReturnType<typeof probeTextureSource>> | null)[] = [];
  for (let index = 0; index < source.cells.length; index++) {
    const cellSource = source.cells[index].source;
    probes.push(
      cellSource ? await withLabel(index, () => probeTextureSource(cellSource, isNormal)) : null
    );
  }
  probes.forEach((probe, index) => {
    if (!probe) return;
    const [, , cw, ch] = source.cells[index].content;
    const changes: string[] = [];
    if (probe.width < cw || probe.height < ch) changes.push('upscaled');
    const stretch = Math.abs(probe.width / probe.height / (cw / ch) - 1);
    if (stretch > 1e-6) {
      changes.push(`stretched (its aspect ratio changes by ${(stretch * 100).toFixed(2)}%)`);
    }
    if (changes.length) {
      opts.warn(
        `${getCellLabel(source, index)}: sources.${source.slot} ${probe.width}×${probe.height} is ${changes.join(' and ')} to the cell's ${cw}×${ch}`
      );
    }
  });
  const { fill } = source;
  const hasAlpha = imageProbe
    ? imageProbe.hasAlpha
    : probes.some((probe) => probe?.hasAlpha) || (fill?.length === 4 && fill[3] < 1);
  const channels = hasAlpha ? 4 : 3;
  const coverageCut = getCoverageCut(source, slot, settings, hasAlpha, opts.warn);

  // The levels stored: from the first that fits maxSize to the last the layout keeps apart (or
  // to 1×1 with the full chain)
  const isFullChain = source.mipChain === 'FULL';
  const chainLevels = isFullChain ? getFullMipLevelCount(width, height) : source.levels;
  let first = 0;
  if (settings.maxSize) {
    while (Math.max(width, height) >> first > settings.maxSize) first++;
  }
  if (first >= source.levels) {
    const last = source.levels - 1;
    throw new Error(
      `maxSize ${settings.maxSize} leaves none of the ${source.levels} mip level(s) the layout keeps apart (the smallest is ${width >> last}×${height >> last}), so the cells would bleed into each other: raise maxSize, lower the atlas's "size", or raise its "padding" (it keeps 2^level ≤ padding apart)`
    );
  }
  const topWidth = width >> first;
  const topHeight = height >> first;
  if (topWidth % 4 || topHeight % 4) {
    throw new Error(
      `maxSize ${settings.maxSize} stores the ${width}×${height} atlas from its level ${first}, ${topWidth}×${topHeight}, which isn't a multiple of 4 (a block-compressed texture's size): make "size" a multiple of ${4 << first}, or raise maxSize`
    );
  }
  const last = settings.mipmaps ? chainLevels - 1 : first;
  const levelCount = last - first + 1;
  if (first) {
    opts.warn(
      `maxSize ${settings.maxSize}: the ${width}×${height} layout is stored from its level ${first} (${topWidth}×${topHeight}), ${levelCount} of the ${chainLevels} mip levels ${isFullChain ? 'of its full chain' : 'it keeps apart'}`
    );
  }
  // Exact halving while the layout keeps the cells apart (its size is aligned to 2^levels); the
  // full chain's levels past that can have an odd size, area-filtered to the GPU's floor(size / 2)
  const nextLevel = (img: Img) =>
    img.width % 2 || img.height % 2
      ? resizeImage(img, Math.max(1, img.width >> 1), Math.max(1, img.height >> 1), isNormal)
      : halve(img, isNormal);

  const composeLevel0 = async () => {
    if (image) {
      const img = await readTextureSource(
        image,
        { width, height },
        { isSrgb: opts.isSrgb, isNormal }
      );
      return toChannels(img, channels);
    }
    const atlas = createImage(width, height, channels);
    const fillValues = [...(fill ?? [0, 0, 0, 0])];
    if (fillValues.length === 3) fillValues.push(1);
    for (let i = 0; i < atlas.data.length; i += channels) {
      for (let c = 0; c < channels; c++) atlas.data[i + c] = fillValues[c];
    }
    for (let index = 0; index < source.cells.length; index++) {
      const { rect, content, source: cellSource } = source.cells[index];
      if (!cellSource) continue;
      const size = { width: content[2], height: content[3] };
      const img = await withLabel(index, () =>
        readTextureSource(cellSource, size, { isSrgb: opts.isSrgb, isNormal })
      );
      drawCell(atlas, toChannels(img, channels), rect, content);
    }
    return atlas;
  };

  // p341: level 0's coverage, per cell for the levels the layout keeps apart and of the whole
  // image for a full chain's levels past them (which mix the cells)
  const getCellRegions = (levelIndex: number) =>
    source.cells.map(({ rect }) => rect.map((px) => px >> levelIndex) as CoverageRegion);
  let coverageTargets: { cells: number[]; whole: number | null } | null = null;
  const measureCoverageTargets = (level0: Img, cut: number) => ({
    cells: getCellRegions(0).map((region) => measureAlphaCoverage(level0, cut, region)),
    whole: last >= source.levels ? measureAlphaCoverage(level0, cut) : null,
  });
  // A scaled copy: the next level is halved from the unscaled one, so the scales don't compound
  const scaleCoverage = (img: Img, levelIndex: number) => {
    if (coverageCut === undefined || !coverageTargets || levelIndex === 0) return img;
    const { cells, whole } = coverageTargets;
    return levelIndex < source.levels
      ? scaleAlphaForCoverage(img, coverageCut, cells, getCellRegions(levelIndex)).image
      : scaleAlphaForCoverage(img, coverageCut, [whole!]).image;
  };

  // One level in memory at a time (and the one it is halved from)
  let level: Img | null = null;
  const bytes = await encodeKtx2Levels(
    levelCount,
    async (index) => {
      if (!level) {
        level = await composeLevel0();
        if (coverageCut !== undefined) {
          coverageTargets = measureCoverageTargets(level, coverageCut);
        }
        for (let i = 0; i < first; i++) level = nextLevel(level);
      } else {
        level = nextLevel(level);
      }
      // Flipped as stored, like a texture's KTX2
      return flipY(scaleCoverage(level, first + index));
    },
    settings,
    { channels, isSrgb: opts.isSrgb, isNormal, getKtx: opts.getKtx }
  );
  const output = writeOutput(getAtlasLogicalPath(source.jsonFile, source.slot), '.ktx2', bytes);
  const sourceBytes = [...new Set(listTextureAtlasFiles(source))].reduce(
    (sum, file) => sum + fs.statSync(file).size,
    0
  );
  const texture: EncodedTexture = {
    ...describeEncodedTexture({ width: topWidth, height: topHeight, channels }, settings, {
      slot,
      bytes: output.bytes,
      source: { width, height, bytes: sourceBytes },
    }),
    levels: levelCount,
  };
  return { output, texture };
};
