import fs from 'fs';
import path from 'path';
import type { TextureSlot } from '../../src/_engine/schemas/assetsConfigSchema';
import {
  DEFAULT_ATLAS_PADDING,
  type TextureAtlasAsset,
  type TextureAtlasCellInfo,
  type TextureAtlasSlot,
} from '../../src/_engine/schemas/textureAtlasSchema';
import { createImage, flipY, halve, toChannels, type Img } from './images';
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
 * level `L` a texel covers 2^L × 2^L px, so the levels stay apart while every padded rect (and the
 * atlas) is aligned to 2^L and `padding ≥ 2^L`: no texel then mixes two cells, and a bilinear tap
 * at a cell's edge lands in its own padding. The chain stops at the last such level (with box
 * filtered levels; a wider filter, like ktx's default lanczos4, would reach further).
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
  cells: AtlasCellLayout[];
};

/** Block compression's grid: every rect is on it */
const BLOCK_SIZE = 4;

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
 * rounded up to the alignment grid (2^⌊log2 padding⌋, at least 4). Returns each cell's padded rect
 * (null for one that failed), the levels the layout keeps apart, and every problem, each naming
 * its cell.
 */
export const layoutAtlasCells = (
  size: [number, number],
  padding: number,
  cells: AtlasCellInput[]
) => {
  const [width, height] = size;
  const errors: string[] = [];
  const warnings: string[] = [];
  const rects: (AtlasRect | null)[] = cells.map(() => null);
  const paddingLevel = padding >= 1 ? Math.floor(Math.log2(padding)) : 0;
  const grid = Math.max(BLOCK_SIZE, 2 ** paddingLevel);

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

  // The levels: what the padding protects, less what the atlas size or a rect isn't aligned to
  let level = Math.min(paddingLevel, getAlignmentLevel(width), getAlignmentLevel(height));
  const limits: string[] = [];
  if (level < paddingLevel) limits.push(`the atlas size ${width}×${height}`);
  rects.forEach((rect, index) => {
    if (!rect) return;
    const rectLevel = Math.min(...rect.map(getAlignmentLevel));
    if (rectLevel < paddingLevel) limits.push(`${cells[index].label}'s rect ${formatRect(rect)}`);
    level = Math.min(level, rectLevel);
  });
  if (limits.length) {
    warnings.push(
      `the mip chain stops at level ${level} (${2 ** level} px), where the padding (${padding} px) keeps levels 0-${paddingLevel} apart: ${limits.join(', ')} ${limits.length === 1 ? 'is' : 'are'} only aligned to ${2 ** level} px. Align ${limits.length === 1 ? 'it' : 'them'} to ${2 ** paddingLevel} px for the rest.`
    );
  }
  return { rects, levels: level + 1, errors, warnings };
};

/**
 * Resolves an atlas: its cells' sources (see `resolveTextureSourceRef`; a source in an sRGB slot
 * is read as sRGB), their content sizes (a `rect` less its padding, a `size`, else the first
 * source's, in the order of `slots`, from its file header) and the layout (see
 * {@link layoutAtlasCells}). Every problem is in `errors`, each naming its cell; `layout` is null
 * when there is one. `warnings` are worth a look, eg. a rect that shortens the mip chain.
 * @param jsonFile The atlas's JSON, absolute or relative to the repo root
 */
export const resolveTextureAtlas = (
  jsonFile: string,
  data: Pick<TextureAtlasAsset, 'size' | 'padding' | 'slots' | 'cells'>,
  findTexture: TextureLookup
): { layout: TextureAtlasLayout | null; errors: string[]; warnings: string[] } => {
  const padding = data.padding ?? DEFAULT_ATLAS_PADDING;
  const slotNames = Object.keys(data.slots);
  const errors: string[] = [];
  const ids = new Map<string, number>();
  const inputs: AtlasCellInput[] = [];
  const cells: Omit<AtlasCellLayout, 'rect' | 'content'>[] = [];

  data.cells.forEach((cell, index) => {
    const label = `cells[${index}] ("${cell.id}")`;
    const other = ids.get(cell.id);
    if (other !== undefined) errors.push(`${label}: cells[${other}] has the same id`);
    else ids.set(cell.id, index);

    const sources: Record<string, TextureArrayLayer> = {};
    const refs = Object.entries(cell.sources);
    if (!refs.length) errors.push(`${label}: no sources (a cell is an image in one slot or more)`);
    for (const [slot, ref] of refs) {
      if (!data.slots[slot]) {
        errors.push(`${label}: sources.${slot}: no such slot (slots: ${slotNames.join(', ')})`);
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
              `${label}: the size of sources.${slot} ("${cell.sources[slot]}") isn't read without decoding it (only PNG, JPEG and WebP headers are): set the cell's "size"`
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

  const layout = layoutAtlasCells(data.size, padding, inputs);
  if (layout.errors.length) return { layout: null, errors: layout.errors, warnings: [] };
  for (const slot of slotNames) {
    if (!cells.some(({ sources }) => sources[slot])) {
      layout.warnings.push(`slots.${slot}: no cell has a source in it, so it is its fill alone`);
    }
  }
  return {
    layout: {
      size: data.size,
      padding,
      levels: layout.levels,
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
  /** The slot's `fill`, as the JSON has it */
  fill?: TextureAtlasSlot['fill'];
  /** In the JSON's order; `source` unset: the slot's fill */
  cells: { id: string; rect: AtlasRect; content: AtlasRect; source?: TextureArrayLayer }[];
};

export const createAtlasSlotSource = (
  jsonFile: string,
  atlasId: string,
  layout: TextureAtlasLayout,
  slot: string,
  fill?: TextureAtlasSlot['fill']
): AtlasSlotSource => {
  const file = path.resolve(jsonFile);
  return {
    kind: 'atlas',
    jsonFile: file,
    repoPath: toRepoPath(file),
    atlasId,
    slot,
    size: layout.size,
    padding: layout.padding,
    levels: layout.levels,
    ...(fill ? { fill } : {}),
    cells: layout.cells.map(({ id, rect, content, sources }) => ({
      id,
      rect,
      content,
      ...(sources[slot] ? { source: sources[slot] } : {}),
    })),
  };
};

/**
 * Every file a slot's encode reads, cell by cell (a pack's files in its order). A file two cells
 * read is listed twice: the cache key hashes the files in this order.
 */
export const listTextureAtlasFiles = (source: AtlasSlotSource) =>
  source.cells.flatMap((cell) => (cell.source ? listTextureSourceFiles(cell.source) : []));

/**
 * The cache key's inputs (besides the files, the settings and the colour space): the layout as
 * this slot draws it (each cell's rects and what its source is, a file, a pack's recipe or the
 * fill), the fill and the output's name.
 */
export const getTextureAtlasKeyParams = (source: AtlasSlotSource) => ({
  size: source.size,
  padding: source.padding,
  levels: source.levels,
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
 * Encodes an atlas slot (p299 D3): the layout filled with the slot's `fill` (RGB(A), linear;
 * default transparent black, an RGB fill is opaque), each cell's source resized into its content
 * rect and edge-extended over its padding, then box-filtered levels (exact 2×2 halving, as
 * `images.ts` does) down to the last one the layout keeps apart, as one KTX2 with
 * `ktx create --levels`. A source with alpha, or a fill with alpha below 1, makes the slot RGBA.
 * `maxSize` drops the top levels until one fits (the cells stay aligned), with a warning. Warns
 * for a source that is upscaled or stretched into its cell. Throws, naming the cell, for a source
 * that can't be read, and when `maxSize` leaves none of the levels the layout keeps apart.
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
  const hasAlpha = probes.some((probe) => probe?.hasAlpha) || (fill?.length === 4 && fill[3] < 1);
  const channels = hasAlpha ? 4 : 3;

  // The levels stored: from the first that fits maxSize to the last the layout keeps apart
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
  const last = settings.mipmaps ? source.levels - 1 : first;
  const levelCount = last - first + 1;
  if (first) {
    opts.warn(
      `maxSize ${settings.maxSize}: the ${width}×${height} layout is stored from its level ${first} (${topWidth}×${topHeight}), ${levelCount} of the ${source.levels} mip levels it keeps apart`
    );
  }

  const composeLevel0 = async () => {
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

  // One level in memory at a time (and the one it is halved from)
  let level: Img | null = null;
  const bytes = await encodeKtx2Levels(
    levelCount,
    async () => {
      if (!level) {
        level = await composeLevel0();
        for (let i = 0; i < first; i++) level = halve(level, isNormal);
      } else {
        level = halve(level, isNormal);
      }
      // Flipped as stored, like a texture's KTX2
      return flipY(level);
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
