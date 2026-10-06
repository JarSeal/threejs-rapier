/**
 * The material editor's right drawer tabs (docs/plans/p084_material-editor-stage-and-selector.md
 * DD6, docs/plans/p085_material-editor-params-and-persistence.md): **Params** (the selected
 * material's info and its editable params) and **Settings** (the camera with its reset).
 *
 * Both tabs have the material's record as their `lsKey`, for the heading's clear button (this
 * material only), and no `persistKeys`: the editor module owns the record, and every binding has
 * an explicit `target` whose `onChange` applies and saves the value.
 */
import type * as THREE from 'three/webgpu';
import { CMP } from '../../../../utils/CMP';
import type { AnyDebuggerTabDef, DebuggerTabSection } from '../../../../debug/DebuggerGUI';
import type { MaterialAsset } from '../../../../schemas/materialSchema';
import type { ViewCamera, ViewCameraPose } from '../_dbg__ViewCamera';
import { getMaterialRecordKey, MATERIAL_EDITOR_TABS_UI_LS_KEY } from './_dbg__MaterialEditorStore';
import {
  getMaterialParamPaneItems,
  readMaterialParams,
  type MaterialParamDef,
} from './_dbg__MaterialEditorParams';
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
  /** The selected material's editor copy, when it is on the stage. */
  getCopy: () => THREE.Material | null;
  /** Sets a param on the copy, and saves it to the record when `persist` (a drag's last change). */
  setParam: (def: MaterialParamDef, value: unknown, persist: boolean) => void;
  /** After a heading's clear button removed the material's record. */
  onRecordCleared: (materialId: string) => void;
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

/** The heading's clear button and the folder states: the material's record (none without a
 * material: a disabled clear button, like every tab's without data). */
type RecordProps = Pick<AnyDebuggerTabDef, 'lsKey' | 'uiLsKey' | 'clearLSButton' | 'onClearLS'>;

const getRecordProps = (
  ctx: MaterialEditorTabsCtx,
  materialId: string | undefined
): RecordProps => ({
  lsKey: materialId ? getMaterialRecordKey(materialId) : undefined,
  uiLsKey: MATERIAL_EDITOR_TABS_UI_LS_KEY,
  clearLSButton: true,
  onClearLS: () => {
    if (materialId) ctx.onRecordCleared(materialId);
  },
});

const getParamsTab = (ctx: MaterialEditorTabsCtx, recordProps: RecordProps): AnyDebuggerTabDef => {
  // What the param bindings bind to, read from the copy before every build and refresh (an undo
  // or a reset changes the copy, not this)
  const paramTarget: Record<string, unknown> = {};
  return {
    id: MATERIAL_EDITOR_PARAMS_TAB_ID,
    title: 'Params',
    icon: 'material',
    ...recordProps,
    onRefresh: () => {
      const copy = ctx.getCopy();
      if (copy) Object.assign(paramTarget, readMaterialParams(copy));
    },
    content: () => {
      const sections: DebuggerTabSection<Record<string, unknown>>[] = [
        CMP({ html: () => getMaterialInfoHtml(ctx) }),
      ];
      const copy = ctx.getCopy();
      if (copy) {
        sections.push({
          pane: true,
          content: getMaterialParamPaneItems(copy, paramTarget, ctx.setParam),
        });
      }
      return sections;
    },
  };
};

const getSettingsTab = (
  ctx: MaterialEditorTabsCtx,
  recordProps: RecordProps
): AnyDebuggerTabDef => ({
  id: MATERIAL_EDITOR_SETTINGS_TAB_ID,
  title: 'Settings',
  icon: 'gear',
  ...recordProps,
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
});

/**
 * The right drawer's tabs, built again for every material and every copy of it (the bindings are
 * made from the copy).
 * @param ctx ({@link MaterialEditorTabsCtx})
 * @returns (AnyDebuggerTabDef[]) Params and Settings, in menu order
 */
export const createMaterialEditorTabs = (ctx: MaterialEditorTabsCtx): AnyDebuggerTabDef[] => {
  const recordProps = getRecordProps(ctx, ctx.getAsset()?.id);
  return [getParamsTab(ctx, recordProps), getSettingsTab(ctx, recordProps)];
};
