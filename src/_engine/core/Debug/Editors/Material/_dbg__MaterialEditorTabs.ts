/**
 * The material editor's right drawer tabs (docs/plans/p084_material-editor-stage-and-selector.md
 * DD6): **Params** and **Settings**. Here they are read-only: the selected material's info, and
 * the camera with its reset. p085 adds the editable params and settings.
 */
import { CMP } from '../../../../utils/CMP';
import type { AnyDebuggerTabDef } from '../../../../debug/DebuggerGUI';
import type { MaterialAsset } from '../../../../schemas/materialSchema';
import type { ViewCamera, ViewCameraPose } from '../_dbg__ViewCamera';
import styles from './MaterialEditor.module.scss';

export const MATERIAL_EDITOR_PARAMS_TAB_ID = 'matEditorParams';
export const MATERIAL_EDITOR_SETTINGS_TAB_ID = 'matEditorSettings';

export type MaterialEditorTabsCtx = {
  /** The selected material's asset (also while it loads or after it failed), or null. */
  getAsset: () => MaterialAsset | null;
  /** The texture ids the asset uses. */
  getTextureIds: (asset: MaterialAsset) => string[];
  /** Whether a texture is loaded (registered). */
  isTextureLoaded: (id: string) => boolean;
  /** What the editor is doing with the selected material: why it failed, that it is loading, …
   * (null when it is shown). */
  getStatus: () => string | null;
  getViewCamera: () => ViewCamera | null;
  /** Refreshes the drawer's mounted tab. */
  refresh: () => void;
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type InfoRow = [label: string, value: string | undefined, opts?: { mono?: boolean }];

/** A label / value list; rows without a value are left out. */
const infoListHtml = (rows: InfoRow[]) => {
  const items = rows
    .filter(([, value]) => value !== undefined && value !== '')
    .map(
      ([label, value, opts]) =>
        `<dt>${escapeHtml(label)}</dt><dd${opts?.mono ? ` class="${styles.mono}"` : ''}>${escapeHtml(value!)}</dd>`
    )
    .join('');
  return `<dl class="${styles.infoList}">${items}</dl>`;
};

/** A titled info section. A CMP template has one root element. */
const infoSectionHtml = (title: string, bodyHtml: string) =>
  `<div class="${styles.infoSection}"><h4 class="${styles.infoHeading}">${escapeHtml(title)}</h4>${bodyHtml}</div>`;

const getMaterialInfoHtml = (ctx: MaterialEditorTabsCtx) => {
  const asset = ctx.getAsset();
  if (!asset) {
    return infoSectionHtml(
      'Material',
      `<p class="${styles.infoEmpty}">No material selected. Pick one in the materials list.</p>`
    );
  }
  const textureIds = ctx.getTextureIds(asset);
  const textures = textureIds
    .map((id) => (ctx.isTextureLoaded(id) ? id : `${id} (not loaded)`))
    .join('\n');
  const tslFile = 'tslFile' in asset ? asset.tslFile : undefined;
  return infoSectionHtml(
    'Material',
    infoListHtml([
      ['Status', ctx.getStatus() ?? undefined],
      ['Id', asset.id, { mono: true }],
      ['Name', asset.debugData?.name],
      ['Type', asset.type],
      ['Source', asset.__sourcePath, { mono: true }],
      ['Description', asset.debugData?.description],
      ['TSL file', tslFile, { mono: true }],
      ['Textures', textures || 'none', { mono: Boolean(textures) }],
    ])
  );
};

const formatXYZ = (xyz: ViewCameraPose['position']) =>
  [xyz.x, xyz.y, xyz.z].map((n) => n.toFixed(2)).join(', ');

const getCameraInfoHtml = (ctx: MaterialEditorTabsCtx) => {
  const viewCam = ctx.getViewCamera();
  if (!viewCam) return '<div></div>';
  const pose = viewCam.getPose();
  return infoSectionHtml(
    'Camera',
    infoListHtml([
      ['Position', formatXYZ(pose.position), { mono: true }],
      ['Target', formatXYZ(pose.target), { mono: true }],
      ['FOV', `${pose.fov}°`, { mono: true }],
    ])
  );
};

/**
 * The right drawer's tabs, built again for every material (p085 gives them the material's own
 * record as their `lsKey`).
 * @param ctx ({@link MaterialEditorTabsCtx})
 * @returns (AnyDebuggerTabDef[]) Params and Settings, in menu order
 */
export const createMaterialEditorTabs = (ctx: MaterialEditorTabsCtx): AnyDebuggerTabDef[] => [
  {
    id: MATERIAL_EDITOR_PARAMS_TAB_ID,
    title: 'Params',
    icon: 'material',
    content: () => [CMP({ html: () => getMaterialInfoHtml(ctx) })],
  },
  {
    id: MATERIAL_EDITOR_SETTINGS_TAB_ID,
    title: 'Settings',
    icon: 'gear',
    // The pose readout follows the camera (OrbitControls' input, the gizmo, a reset)
    onOpen: () => {
      const controls = ctx.getViewCamera()?.controls;
      if (!controls) return;
      controls.addEventListener('change', ctx.refresh);
      return () => controls.removeEventListener('change', ctx.refresh);
    },
    content: () => [
      CMP({ html: () => getCameraInfoHtml(ctx) }),
      {
        pane: true,
        content: [
          {
            type: 'button',
            title: 'Reset camera to default',
            onClick: () => ctx.getViewCamera()?.resetPose(),
          },
        ],
      },
    ],
  },
];
