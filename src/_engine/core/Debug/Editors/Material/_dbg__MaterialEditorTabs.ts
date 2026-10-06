/**
 * The material editor's right drawer tabs (docs/plans/p084_material-editor-stage-and-selector.md
 * DD6, docs/plans/p085_material-editor-params-and-persistence.md): **Params** (the selected
 * material's info, its editable params and TSL inputs, the rest of its params read-only, and a
 * "Reset params" heading button) and **Settings** (the material's stage and preview settings, the
 * camera's fov, pose and reset, and "Clear editor data of all materials").
 *
 * Both tabs have the material's record as their `lsKey`, for the heading's clear button (this
 * material only), and no `persistKeys`: the editor module owns the record, and every binding has
 * an explicit `target` whose `onChange` applies and saves the value.
 */
import type * as THREE from 'three/webgpu';
import { CMP } from '../../../../utils/CMP';
import type {
  AnyDebuggerTabDef,
  DebuggerPaneItem,
  DebuggerTabSection,
} from '../../../../debug/DebuggerGUI';
import type { MaterialAsset } from '../../../../schemas/materialSchema';
import type { ViewCamera, ViewCameraPose } from '../_dbg__ViewCamera';
import { confirmClearLS, createClearLSButton } from '../../_dbg__ClearLSButtons';
import {
  getMaterialRecordIds,
  getMaterialRecordKey,
  MATERIAL_EDITOR_TABS_UI_LS_KEY,
  readMaterialRecord,
} from './_dbg__MaterialEditorStore';
import {
  getSettingsPaneItems,
  type MaterialEditorSettingKey,
  type MaterialEditorSettings,
} from './_dbg__MaterialEditorSettings';
import {
  getAssetNodeInputs,
  getAssetStaticDefines,
  getMaterialParamPaneItems,
  getNodeInputPaneItems,
  getOtherAssetParamPaneItems,
  readMaterialParams,
  readNodeInputs,
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
  /** Sets a TSL input on the copy, saved like `setParam`. */
  setNodeInput: (socket: string, input: string, value: unknown, persist: boolean) => void;
  /** Removes the material's overrides from its record and makes its copy again. */
  resetParams: (materialId: string) => void;
  /** After a heading's clear button removed the material's record. */
  onRecordCleared: (materialId: string) => void;
  /** The selected material's settings, once they are on the stage (null before, or without a
   * selected material). */
  getSettings: () => MaterialEditorSettings | null;
  /** Sets a setting of the selected material on the stage, saved like `setParam`. */
  setSetting: (key: MaterialEditorSettingKey, value: unknown, persist: boolean) => void;
  /** Removes every material's record (after the confirm). */
  clearAllRecords: () => void;
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

/** "Reset params": removes the material's overrides only (its settings and camera stay), disabled
 * while it has none. */
const createResetParamsButton = (ctx: MaterialEditorTabsCtx, materialId: string | undefined) =>
  createClearLSButton({
    icon: 'arrowCounterClockwise',
    title: 'Reset params (removes the edited params and TSL inputs of this material)',
    hasData: () => Boolean(materialId && readMaterialRecord(materialId).overrides),
    watchKey: materialId ? getMaterialRecordKey(materialId) : undefined,
    onClear: () => {
      if (materialId) ctx.resetParams(materialId);
    },
  });

const getParamsTab = (ctx: MaterialEditorTabsCtx, recordProps: RecordProps): AnyDebuggerTabDef => {
  const asset = ctx.getAsset();
  const assetNodes = asset ? getAssetNodeInputs(asset) : undefined;
  // What the bindings bind to, read from the copy before every build and refresh (an undo or a
  // reset changes the copy, not these): the params, and the TSL inputs per socket
  const paramTarget: Record<string, unknown> = {};
  const nodeTargets: Record<string, Record<string, unknown>> = {};
  const getNodeTarget = (socket: string) => (nodeTargets[socket] ??= {});
  return {
    id: MATERIAL_EDITOR_PARAMS_TAB_ID,
    title: 'Params',
    icon: 'material',
    ...recordProps,
    headerButtons: () => [createResetParamsButton(ctx, asset?.id)],
    onRefresh: () => {
      const copy = ctx.getCopy();
      if (!copy) return;
      Object.assign(paramTarget, readMaterialParams(copy));
      for (const [socket, inputs] of Object.entries(readNodeInputs(copy, assetNodes))) {
        Object.assign(getNodeTarget(socket), inputs);
      }
    },
    content: () => {
      const sections: DebuggerTabSection<Record<string, unknown>>[] = [
        CMP({ html: () => getMaterialInfoHtml(ctx) }),
      ];
      const copy = ctx.getCopy();
      if (copy && asset) {
        sections.push({
          pane: true,
          content: [
            ...getMaterialParamPaneItems(copy, paramTarget, ctx.setParam),
            ...getNodeInputPaneItems(
              copy,
              assetNodes,
              getAssetStaticDefines(asset),
              getNodeTarget,
              ctx.setNodeInput
            ),
            ...getOtherAssetParamPaneItems(copy, asset.params),
          ],
        });
      }
      return sections;
    },
  };
};

/** The Settings tab's Camera folder: the fov (part of the pose, saved with it), the pose
 * read-only and the reset. */
const getCameraPaneItems = (
  ctx: MaterialEditorTabsCtx,
  target: { fov: number; position: string; target: string }
): DebuggerPaneItem[] => [
  {
    type: 'folder',
    id: 'settings/Camera',
    title: 'Camera',
    content: [
      {
        key: 'fov',
        target,
        label: 'FOV',
        min: 10,
        max: 120,
        step: 1,
        onChange: (value, e) => {
          ctx.getViewCamera()?.setFov(value as number, e.last);
          if (e.last) ctx.refresh();
        },
      },
      { key: 'position', target, label: 'Position', readonly: true },
      { key: 'target', target, label: 'Target', readonly: true },
      {
        type: 'button',
        title: 'Reset camera to default',
        onClick: () => {
          ctx.getViewCamera()?.resetPose();
          ctx.refresh();
        },
      },
    ],
  },
];

const getSettingsTab = (
  ctx: MaterialEditorTabsCtx,
  recordProps: RecordProps
): AnyDebuggerTabDef => {
  const asset = ctx.getAsset();
  // What the bindings bind to, read before every build and refresh (a clear or the camera's
  // controls change what they show)
  const settingsTarget: Record<string, unknown> = {};
  const cameraTarget = { fov: 0, position: '', target: '' };
  return {
    id: MATERIAL_EDITOR_SETTINGS_TAB_ID,
    title: 'Settings',
    icon: 'gear',
    ...recordProps,
    onRefresh: () => {
      const settings = ctx.getSettings();
      if (settings) Object.assign(settingsTarget, settings);
      const viewCam = ctx.getViewCamera();
      if (!viewCam) return;
      const pose = viewCam.getPose();
      cameraTarget.fov = pose.fov;
      cameraTarget.position = formatXYZ(pose.position);
      cameraTarget.target = formatXYZ(pose.target);
    },
    // The pose follows the camera (OrbitControls' input, the gizmo, a reset), and the clear-all
    // button the record its move end writes
    onOpen: () => {
      const controls = ctx.getViewCamera()?.controls;
      if (!controls) return;
      controls.addEventListener('change', ctx.refresh);
      controls.addEventListener('end', ctx.refresh);
      return () => {
        controls.removeEventListener('change', ctx.refresh);
        controls.removeEventListener('end', ctx.refresh);
      };
    },
    content: () => {
      const sections: DebuggerTabSection<Record<string, unknown>>[] = [];
      const hasSettings = Boolean(ctx.getSettings());
      if (!asset) {
        sections.push(
          CMP({
            html: () =>
              infoSectionHtml(
                'Settings',
                `<p class="${styles.infoEmpty}">No material selected: the stage has the default settings.</p>`
              ),
          })
        );
      }
      const content: DebuggerPaneItem[] = [
        ...(hasSettings
          ? getSettingsPaneItems(settingsTarget, (key, value, last) => {
              ctx.setSetting(key, value, last);
              // The clear-all button's disabled state follows the record
              if (last) ctx.refresh();
            })
          : []),
      ];
      if (ctx.getViewCamera()) content.push(...getCameraPaneItems(ctx, cameraTarget));
      content.push(
        { type: 'separator' },
        {
          type: 'button',
          title: 'Clear editor data of all materials',
          disabled: () => !getMaterialRecordIds().length,
          onClick: () =>
            confirmClearLS({
              message: 'Clear the material editor data of all materials?',
              note: 'Their edited params, TSL inputs, settings and camera poses are removed. The editor UI state and the folder states stay.',
              confirmText: 'Clear all materials',
              onConfirm: ctx.clearAllRecords,
            }),
        }
      );
      sections.push({ pane: true, content });
      return sections;
    },
  };
};

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
