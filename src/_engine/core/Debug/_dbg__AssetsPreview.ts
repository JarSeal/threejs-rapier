import type * as THREE from 'three/webgpu';
import { CMP, type TCMP } from '../../utils/CMP';
import { getTextureArrayInfo } from '../TextureArray';
import { getTextureAtlasInfo, type TextureAtlasInfo } from '../TextureAtlas';
import { getTextureDepth } from './_dbg__AssetStats';
import {
  getTextureLevelCount,
  getTextureLevelSize,
  renderTexturePreviewAsync,
  type TexturePreview,
} from './_dbg__TexturePreview';
import styles from './Assets.module.scss';

/**
 * The Assets tab info window's previews (p299 D6): an array texture's layers as thumbnails, an
 * atlas slot's image with its cells' content and padded rects (the cell's id on hover), at one mip
 * level picked in the window. Rendered on the GPU and read back (_dbg__TexturePreview.ts), since a
 * KTX2 texture can't be drawn into a 2D canvas.
 */

/** A layer thumbnail's largest side, in px */
const THUMB_MAX_SIZE = 128;
/** An atlas slot image's largest side, in px */
const IMAGE_MAX_SIZE = 1024;

type PreviewState = { level: number; showRects: boolean };

/** Per info window, for its session: kept when its content is rebuilt, dropped on its close. */
const previewStates = new Map<string, PreviewState>();

/** Drops a closed info window's picked level and rects toggle. */
export const forgetTexturePreviewState = (windowId: string) => previewStates.delete(windowId);

const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );

const toCanvas = (image: ImageData) => {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.className = styles.assetsPreviewCanvas;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvas;
};

/** The cells' rects over the slot image, in the layout's px (the image at any level covers the
 * whole layout): the padded rect (cyan) around the content rect (magenta), as the scene draws them. */
const getAtlasOverlaySvg = (info: TextureAtlasInfo) => {
  const [layoutW, layoutH] = info.size;
  const pad = info.padding;
  const cells = Object.entries(info.cells).map(([cellId, cell]) => {
    const [u0, v0, u1, v1] = cell.uv;
    // v up: the rect's top is v1
    const x = u0 * layoutW;
    const y = (1 - v1) * layoutH;
    const w = (u1 - u0) * layoutW;
    const h = (v1 - v0) * layoutH;
    return `<g class="${styles.assetsPreviewCell}" data-cell="${esc(cellId)}"><title>${esc(cellId)}</title><rect class="${styles.assetsPreviewPadded}" x="${x - pad}" y="${y - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}" vector-effect="non-scaling-stroke" /><rect class="${styles.assetsPreviewContent}" x="${x}" y="${y}" width="${w}" height="${h}" vector-effect="non-scaling-stroke" /></g>`;
  });
  return `<svg class="${styles.assetsPreviewOverlay}" viewBox="0 0 ${layoutW} ${layoutH}" preserveAspectRatio="none">${cells.join('')}</svg>`;
};

/** "crackA: 64 × 64 px at 16, 16": a hovered cell's content rect in image px from the top left. */
const describeHoveredCell = (info: TextureAtlasInfo, cellId: string) => {
  const cell = info.cells[cellId];
  if (!cell) return '';
  const [u0, , , v1] = cell.uv;
  const x = Math.round(u0 * info.size[0]);
  const y = Math.round((1 - v1) * info.size[1]);
  return `${cellId}: ${cell.size[0]} × ${cell.size[1]} px at ${x}, ${y}`;
};

const HOVER_HINT = 'Hover a cell for its id.';

/** "Level 2: 128 × 128 px, shown at 64 × 64 (sampled down)" */
const describePreview = (preview: TexturePreview, droppedLevels: number) => {
  const { level, levelWidth, levelHeight, width, height } = preview;
  const shown =
    width !== levelWidth || height !== levelHeight
      ? `, shown at ${width} × ${height} (sampled down)`
      : '';
  const layout = droppedLevels ? ` (the layout's level ${level + droppedLevels})` : '';
  return `Level ${level}${layout}: ${levelWidth} × ${levelHeight} px${shown}`;
};

/**
 * The info window's preview of an array texture or an atlas slot, or undefined for other textures.
 * @param windowId the info window's id: its picked level and rects toggle are kept per window
 */
export const createTexturePreviewCmp = (
  texture: THREE.Texture,
  windowId: string
): TCMP | undefined => {
  const atlas = getTextureAtlasInfo(texture);
  const depth = getTextureDepth(texture);
  const isArray = Boolean(getTextureArrayInfo(texture)) || depth > 1;
  if (!atlas && !isArray) return undefined;

  const levelCount = getTextureLevelCount(texture);
  const state = previewStates.get(windowId) ?? { level: 0, showRects: true };
  state.level = Math.min(state.level, levelCount - 1);
  previewStates.set(windowId, state);
  // An atlas slot's file can start below the layout's level 0 (its maxSize dropped the top levels)
  const droppedLevels = atlas ? Math.round(Math.log2(atlas.size[0] / atlas.width)) : 0;
  const members = getTextureArrayInfo(texture)?.members;

  const levelButtons = [...Array(levelCount).keys()]
    .map((level) => {
      const size = getTextureLevelSize(texture, level);
      const title = size ? `Level ${level}: ${size.width} × ${size.height} px` : `Level ${level}`;
      return `<button class="debuggerSmallButton ${styles.assetsPreviewLevel}" data-level="${level}" title="${title}">${level}</button>`;
    })
    .join('');
  const rectsToggle = atlas
    ? `<label class="${styles.assetsPreviewToggle}"><input type="checkbox" data-action="rects"${state.showRects ? ' checked' : ''} /> Cell rects</label>`
    : '';

  let renderToken = 0;
  const query = (role: string) =>
    cmp.elem.querySelector(`[data-role="${role}"]`) as HTMLElement | null;

  const markLevel = () =>
    cmp.elem.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((button) => {
      button.classList.toggle(
        styles.assetsPreviewLevelActive,
        Number(button.dataset.level) === state.level
      );
    });

  const showPreview = (preview: TexturePreview) => {
    const images = query('images');
    if (!images) return;
    images.replaceChildren();
    if (atlas) {
      const frame = document.createElement('div');
      frame.className = styles.assetsPreviewFrame;
      frame.appendChild(toCanvas(preview.tiles[0].image));
      frame.insertAdjacentHTML('beforeend', getAtlasOverlaySvg(atlas));
      const hover = query('hover');
      frame.addEventListener('mouseover', (e) => {
        const cellId = (e.target as Element).closest('[data-cell]')?.getAttribute('data-cell');
        if (hover) hover.textContent = cellId ? describeHoveredCell(atlas, cellId) : HOVER_HINT;
      });
      frame.addEventListener('mouseleave', () => {
        if (hover) hover.textContent = HOVER_HINT;
      });
      images.appendChild(frame);
      return;
    }
    for (const tile of preview.tiles) {
      const figure = document.createElement('figure');
      figure.className = styles.assetsPreviewThumb;
      figure.appendChild(toCanvas(tile.image));
      const caption = document.createElement('figcaption');
      const name = members?.[tile.layer];
      caption.textContent = name !== undefined ? `${tile.layer}: ${name}` : String(tile.layer);
      caption.title = caption.textContent;
      figure.appendChild(caption);
      images.appendChild(figure);
    }
  };

  /** Renders the picked level; a later call wins over one still reading back. */
  const render = async () => {
    const token = ++renderToken;
    const status = query('status');
    if (status) status.textContent = `Rendering level ${state.level}…`;
    try {
      const preview = await renderTexturePreviewAsync(texture, {
        level: state.level,
        maxSize: atlas ? IMAGE_MAX_SIZE : THUMB_MAX_SIZE,
      });
      if (token !== renderToken) return;
      showPreview(preview);
      if (status) status.textContent = describePreview(preview, droppedLevels);
    } catch (err) {
      if (token !== renderToken) return;
      if (status) {
        status.textContent = `The preview failed: ${err instanceof Error ? err.message : String(err)}`;
        status.classList.add('debuggerWarningText');
      }
    }
  };

  const cmp: TCMP = CMP({
    class: [styles.assetsPreview, ...(state.showRects ? [] : [styles.assetsPreviewHideRects])],
    html: `<div>
<div class="${styles.assetsPreviewToolbar}"><span class="winSmallLabel">Level:</span> ${levelButtons}${rectsToggle}</div>
<div class="${styles.assetsTableSub}" data-role="status"></div>
<div class="${atlas ? '' : styles.assetsPreviewThumbs}" data-role="images"></div>
${atlas ? `<div class="${styles.assetsTableSub}" data-role="hover">${HOVER_HINT}</div>` : ''}
</div>`,
    onClick: (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-level]');
      if (!button) return;
      const level = Number(button.dataset.level);
      if (level === state.level) return;
      state.level = level;
      markLevel();
      render();
    },
    onChange: (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.action !== 'rects') return;
      state.showRects = input.checked;
      cmp.elem.classList.toggle(styles.assetsPreviewHideRects, !state.showRects);
    },
  });
  markLevel();
  // A template child gets no onCreateCmp: the render starts now and fills the element when the
  // readback arrives (the window attaches it before that)
  render();
  return cmp;
};
