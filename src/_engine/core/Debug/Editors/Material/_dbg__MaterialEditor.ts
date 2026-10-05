/**
 * The material editor (docs/plans/p084_material-editor-stage-and-selector.md), the first editor
 * view: a preview object on a stage of its own (lights, a studio environment, a grey background),
 * seen through the editor's orbit camera, showing an editor copy of a project material
 * (`*.material.json`), picked in the selector (the bottom drawer).
 *
 * The copy is a separate registered material (`__matEditor__<id>`), so the scene's own instance
 * of the material is never used or changed. It only lives while the view is active: it is
 * created on enter and deleted on exit.
 */
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { registerView } from '../../../ViewManager';
import { getRenderer } from '../../../Renderer';
import { getGeneratedAppData } from '../../../Scene';
import { createMaterial, deleteMaterial, type MatProps } from '../../../Material';
import { getTexture, loadTextureAsync, type TextureProps } from '../../../Texture';
import { getHUDRootCMP, KEEP_IN_VIEWS_CLASS } from '../../../HUD';
import { tslMaterialFileObjects } from '../../../../generatedAppFns';
import type { MaterialAsset } from '../../../../schemas/materialSchema';
import { textureMapKeys } from '../../../../utils/constants';
import { addDebugToast } from '../../../../debug/DebuggerGUI';
import { createViewCamera, type ViewCamera } from '../_dbg__ViewCamera';
import {
  createEditorDrawer,
  type EditorDrawer,
  type EditorDrawerState,
} from '../_dbg__EditorDrawer';
import {
  createMaterialSelector,
  type MaterialSelector,
  type MaterialSelectorEntry,
  type MaterialSelectorState,
} from './_dbg__MaterialEditorSelector';
import { createMaterialEditorTabs } from './_dbg__MaterialEditorTabs';
import {
  createMaterialCameraStore,
  readMaterialEditorUIState,
  writeMaterialEditorUIState,
} from './_dbg__MaterialEditorStore';
import { lerror, lwarn } from '../../../../utils/Logger';
import styles from './MaterialEditor.module.scss';

export const MATERIAL_EDITOR_VIEW_ID = 'materialEditor';
/** The material registry id prefix of the editor's copies (anything that lists the registry can
 * skip them). */
export const MATERIAL_EDITOR_COPY_PREFIX = '__matEditor__';

const BACKGROUND_COLOR = 0x5a5a5a;
const ERROR_COLOR = 0xff00ff;

/** How a material type is previewed: on the ball, as points or lines on a sphere, as a sprite, or
 * not at all (a notice in its place). */
type PreviewKind = 'MESH' | 'POINTS' | 'LINES' | 'SPRITE' | 'NONE';

const getPreviewKind = (type: MaterialAsset['type']): PreviewKind => {
  switch (type) {
    case 'POINTS':
      return 'POINTS';
    case 'LINEBASIC':
    case 'LINEDASHED':
      return 'LINES';
    case 'SPRITE':
      return 'SPRITE';
    // Shadow, depth and distance materials need a scene pass of their own, and ShaderMaterials
    // don't work on WebGPU at all
    case 'SHADOW':
    case 'DEPTH':
    case 'DISTANCE':
    case 'SHADER':
    case 'SHADERRAW':
      return 'NONE';
    default:
      return 'MESH';
  }
};

type PreviewObject = THREE.Mesh | THREE.Points | THREE.LineSegments | THREE.Sprite;

/** The editor's stage: one private scene with the preview objects, its lights and its
 * environment. */
type Stage = {
  scene: THREE.Scene;
  /** Holds the preview objects (the auto-rotation turns it). */
  previewRoot: THREE.Group;
  objects: Record<Exclude<PreviewKind, 'NONE'>, PreviewObject>;
  /** Each object's own material, put back while it isn't showing an editor copy. */
  defaultMaterials: Map<PreviewObject, THREE.Material>;
  /** A flat magenta, on the ball when a material fails to load. */
  errorMaterial: THREE.Material;
};

/** The editor's DOM (created on the first enter): the HUD with the selector, the right drawer and
 * the notice. */
type EditorUI = {
  hud: HTMLElement;
  notice: HTMLElement;
  selector: MaterialSelector;
  drawer: EditorDrawer;
};

let stage: Stage | null = null;
let ui: EditorUI | null = null;
let viewCam: ViewCamera | null = null;
let isEntered = false;
/** The project material picked in the selector (also while it loads or after it failed). */
let selectedMaterialId: string | null = null;
/** The editor copy on the preview object, and the project material it was made from. */
let current: { materialId: string; copyId: string } | null = null;
/** The newest load: a load that finishes after a newer one started (or after the exit) is
 * discarded. */
let loadToken = 0;
let loadingMaterialId: string | null = null;
/** The material the right drawer's tabs were built for (they are rebuilt per material). */
let drawerMaterialId: string | null = null;
/** Why a material failed to load, by material id (cleared by its next successful load). */
const failures = new Map<string, string>();
/** The selector's and the right drawer's UI state, as saved (read at registration, kept in sync
 * by their onStateChange; the UI is created with it on the first enter). */
let selectorState: Partial<MaterialSelectorState> = {};
let drawerState: Partial<EditorDrawerState> = {};
/** The stage's settings (constants here; p085 makes them editable per material). */
const stageSettings = {
  /** Turns per second of the preview object (in `update`, so the view's pause stops it). */
  autoRotateSpeed: 0,
};

const createStage = (): Stage => {
  const scene = new THREE.Scene();
  scene.name = 'materialEditorStage';
  scene.background = new THREE.Color(BACKGROUND_COLOR);

  // Fixed to the stage, not to the camera: orbiting shows the lit and the shadowed side
  const hemi = new THREE.HemisphereLight(0xffffff, 0x606060, 0.7);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-3, 4, 4);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(4, 1, 1);
  scene.add(hemi, key, fill);

  const previewRoot = new THREE.Group();
  previewRoot.name = 'materialEditorPreview';
  scene.add(previewRoot);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 64),
    new THREE.MeshStandardNodeMaterial({ color: 0x808080 })
  );
  ball.name = 'materialEditorBall';
  // Points and lines read better on a coarser sphere
  const coarseSphere = new THREE.SphereGeometry(1, 48, 24);
  const points = new THREE.Points(coarseSphere, new THREE.PointsNodeMaterial());
  points.name = 'materialEditorPoints';
  const lines = new THREE.LineSegments(
    new THREE.WireframeGeometry(coarseSphere),
    new THREE.LineBasicNodeMaterial()
  );
  lines.name = 'materialEditorLines';
  lines.computeLineDistances(); // For LineDashedMaterial
  const sprite = new THREE.Sprite(new THREE.SpriteNodeMaterial());
  sprite.name = 'materialEditorSprite';
  sprite.scale.setScalar(2); // The ball's diameter

  const objects = { MESH: ball, POINTS: points, LINES: lines, SPRITE: sprite };
  const defaultMaterials = new Map<PreviewObject, THREE.Material>();
  for (const object of Object.values(objects)) {
    object.visible = false;
    defaultMaterials.set(object, object.material as THREE.Material);
    previewRoot.add(object);
  }
  ball.visible = true;

  const errorMaterial = new THREE.MeshBasicNodeMaterial({ color: ERROR_COLOR });
  errorMaterial.name = 'materialEditorError';

  return { scene, previewRoot, objects, defaultMaterials, errorMaterial };
};

/** Shows one preview object with `material` (its own material when null), or none ('NONE'). */
const showPreview = (kind: PreviewKind, material: THREE.Material | null) => {
  if (!stage) return;
  for (const [objectKind, object] of Object.entries(stage.objects)) {
    const isShown = objectKind === kind;
    object.visible = isShown;
    // Hidden ones never keep an editor copy, which is deleted on the next load
    (object as THREE.Mesh).material = (isShown && material) || stage.defaultMaterials.get(object)!;
  }
};

/** The studio environment (a PMREM of three's RoomEnvironment). Needs the renderer, so it is
 * baked on the first enter, and kept while the view is registered. */
const ensureEnvironment = (scene: THREE.Scene) => {
  if (scene.environment) return;
  const renderer = getRenderer();
  if (!renderer) return;
  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = generator.fromScene(room, 0.04).texture;
  room.dispose();
  // Its working set would otherwise stay on the GPU (see SkyEnvironment.ts' getPMREMTexture)
  if (renderer.hasInitialized()) generator.dispose();
};

const getViewCamera = () => {
  viewCam ??= createViewCamera({
    viewId: MATERIAL_EDITOR_VIEW_ID,
    defaultPose: { position: { x: 0, y: 0.6, z: 4.8 }, target: { x: 0, y: 0, z: 0 }, fov: 45 },
    near: 0.01,
    far: 100,
    // A material's pose in its record, the view's own (no material) in 'AEK_debugViewCams'
    store: createMaterialCameraStore(MATERIAL_EDITOR_VIEW_ID),
  });
  return viewCam;
};

/** Applies the pose of a material (its saved one, or the default), or the view's own pose (null).
 * The same key keeps the camera where it is (its pose is saved on every move). */
const applyCameraPoseKey = (materialId: string | null) => {
  if (viewCam && viewCam.getPoseKey() !== materialId) viewCam.setPoseKey(materialId);
};

const persistUIState = () =>
  writeMaterialEditorUIState({
    selectedMaterialId,
    selector: selectorState,
    drawer: drawerState,
  });

const setSelectedMaterialId = (materialId: string | null) => {
  if (selectedMaterialId === materialId) return;
  selectedMaterialId = materialId;
  persistUIState();
};

type GeneratedData = {
  materials?: Record<string, MaterialAsset>;
  textures?: Record<string, TextureProps>;
  scenes: Record<
    string,
    { materials?: (string | MaterialAsset)[]; textures?: (string | TextureProps)[] }
  >;
};

const getGeneratedData = () => getGeneratedAppData() as unknown as GeneratedData;

/** The first scene entry with this id (a production-gathered build keeps only the scenes, with
 * their resolved assets). */
const findInScenes = <T extends { id?: string }>(
  kind: 'materials' | 'textures',
  id: string
): T | undefined => {
  for (const scene of Object.values(getGeneratedData().scenes)) {
    const found = (scene[kind] as (string | T)[] | undefined)?.find(
      (entry) => typeof entry !== 'string' && entry.id === id
    );
    if (found && typeof found !== 'string') return found;
  }
  return undefined;
};

let materialAssets: Record<string, MaterialAsset> | null = null;

/** The project materials by id: the dev registry, or in a production-gathered build (no
 * registry) the scenes' entries, with that scene's overrides applied. */
const getMaterialAssets = () => {
  if (materialAssets) return materialAssets;
  const data = getGeneratedData();
  if (data.materials) {
    materialAssets = data.materials;
    return materialAssets;
  }
  materialAssets = {};
  for (const scene of Object.values(data.scenes)) {
    for (const entry of scene.materials || []) {
      if (typeof entry !== 'string' && entry.id && !materialAssets[entry.id]) {
        materialAssets[entry.id] = entry;
      }
    }
  }
  return materialAssets;
};

/** A texture's declaration: the dev registry's, else any scene's entry. */
const findTextureDeclaration = (id: string) =>
  getGeneratedData().textures?.[id] ?? findInScenes<TextureProps>('textures', id);

/** The asset's creation props, without the gatherer's tooling fields. */
const getMaterialProps = (asset: MaterialAsset): MatProps => {
  const props: Record<string, unknown> = { ...asset, params: { ...asset.params } };
  delete props.$schema;
  delete props.__sourcePath;
  delete props.__saveData;
  return props as MatProps;
};

/**
 * The texture ids a material asset uses: its `params` texture slots and its TSL node string
 * inputs (a string not starting with `#` is a texture id, as in createMaterial).
 * @param asset (MaterialAsset)
 * @returns (string[]) the texture ids, without duplicates
 */
export const getMaterialTextureIds = (asset: MaterialAsset) => {
  const ids = new Set<string>();
  const params = asset.params as Record<string, unknown> | undefined;
  if (params) {
    for (const key of textureMapKeys) {
      const value = params[key];
      if (typeof value === 'string') ids.add(value);
    }
  }
  if ('nodes' in asset && asset.nodes) {
    for (const inputs of Object.values(asset.nodes)) {
      for (const [key, value] of Object.entries(inputs)) {
        if (key !== 'staticDefines' && typeof value === 'string' && !value.startsWith('#')) {
          ids.add(value);
        }
      }
    }
  }
  return [...ids];
};

/** Why a material can't be loaded here, if it can't. */
const getUnavailableReason = (asset: MaterialAsset) => {
  if (!('tslFile' in asset) || !asset.tslFile) return undefined;
  if ((tslMaterialFileObjects as Record<string, unknown>)[asset.id]) return undefined;
  return 'its TSL graph is not in this build (a production-gathered build only has the graphs of the materials a scene uses; run yarn dev)';
};

/** Loads the material's textures that aren't loaded yet (like SceneLoader's
 * loadNextSceneAssets). A texture that fails is left out (createMaterial warns about it). */
const loadMissingTextures = async (asset: MaterialAsset) => {
  const missing = getMaterialTextureIds(asset).filter((id) => !getTexture(id));
  await Promise.all(
    missing.map(async (id) => {
      const declaration = findTextureDeclaration(id);
      if (!declaration) {
        lwarn(`Could not find texture "${id}" of material "${asset.id}", in the material editor.`);
        return;
      }
      try {
        await loadTextureAsync(declaration);
      } catch (err) {
        lerror(`Could not load texture "${id}" of material "${asset.id}".`, err);
      }
    })
  );
};

/** A CSS colour of the material's first colour: `params.color`, else the first `#` TSL input. */
const getSwatch = (asset: MaterialAsset) => {
  let value: unknown = (asset.params as Record<string, unknown> | undefined)?.color;
  if (value === undefined && 'nodes' in asset && asset.nodes) {
    for (const inputs of Object.values(asset.nodes)) {
      value = Object.values(inputs).find((v) => typeof v === 'string' && v.startsWith('#'));
      if (value !== undefined) break;
    }
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return `#${new THREE.Color(value).getHexString()}`;
  } catch {
    return null;
  }
};

const getSelectorEntries = (): MaterialSelectorEntry[] =>
  Object.values(getMaterialAssets()).map((asset) => ({
    id: asset.id,
    name: asset.debugData?.name || asset.id,
    type: asset.type,
    isTsl: 'tslFile' in asset && Boolean(asset.tslFile),
    sourcePath: asset.__sourcePath,
    description: asset.debugData?.description,
    swatch: getSwatch(asset),
    unavailableReason: getUnavailableReason(asset),
  }));

const deleteCurrentCopy = () => {
  if (!current) return;
  showPreview('MESH', null);
  deleteMaterial(current.copyId);
  current = null;
};

const setNotice = (text: string) => {
  if (ui) ui.notice.textContent = text;
};

/** Re-reads the selected, loading and failed material into the selector and the right drawer. */
const refreshUI = () => {
  if (!ui) return;
  ui.selector.refresh();
  if (drawerMaterialId === selectedMaterialId) {
    ui.drawer.refresh();
    return;
  }
  drawerMaterialId = selectedMaterialId;
  ui.drawer.rebuild();
};

/** What the editor is doing with the selected material, for the drawer's info (null when its
 * copy is shown). */
const getSelectedStatus = () => {
  const id = selectedMaterialId;
  if (!id) return null;
  if (id === loadingMaterialId) return 'Loading…';
  const failure = failures.get(id);
  if (failure) return `Failed to load: ${failure}`;
  const asset = getMaterialAssets()[id];
  if (asset && getPreviewKind(asset.type) === 'NONE')
    return `Preview not supported for ${asset.type}`;
  return null;
};

const showLoadError = (materialId: string, message: string, err?: unknown) => {
  lerror(`Could not load material "${materialId}" in the material editor: ${message}`, err);
  failures.set(materialId, message);
  deleteCurrentCopy();
  showPreview('MESH', stage?.errorMaterial ?? null);
  addDebugToast({
    type: 'alert',
    title: 'Material editor',
    message: `Could not load material "${materialId}": ${message}`,
  });
};

/**
 * Shows a project material on the preview object: loads its missing textures, creates its editor
 * copy and deletes the previous one, and applies the material's camera pose. A load that a newer
 * one overtakes is discarded. The selection is saved (restored after a refresh).
 * @param materialId (string | null) a `*.material.json` id, null for none
 * @returns (Promise<boolean>) whether this load put its material on the stage
 */
export const loadEditorMaterial = async (materialId: string | null) => {
  const token = ++loadToken;
  setSelectedMaterialId(materialId);
  loadingMaterialId = null;
  setNotice('');
  // Loaded on the next enter: the copy only lives while the view is active
  if (!stage || !isEntered) return false;

  if (!materialId) {
    deleteCurrentCopy();
    showPreview('MESH', null);
    applyCameraPoseKey(null);
    refreshUI();
    return false;
  }

  const asset = getMaterialAssets()[materialId];
  if (!asset) {
    lwarn(`Could not find material "${materialId}", in loadEditorMaterial.`);
    setSelectedMaterialId(null);
    deleteCurrentCopy();
    showPreview('MESH', null);
    applyCameraPoseKey(null);
    refreshUI();
    return false;
  }
  const unavailableReason = getUnavailableReason(asset);
  if (unavailableReason) {
    showLoadError(materialId, unavailableReason);
    applyCameraPoseKey(materialId);
    refreshUI();
    return false;
  }

  const kind = getPreviewKind(asset.type);
  if (kind === 'NONE') {
    deleteCurrentCopy();
    showPreview('NONE', null);
    applyCameraPoseKey(materialId);
    setNotice(`Preview not supported for ${asset.type}`);
    failures.delete(materialId);
    refreshUI();
    return true;
  }

  // The previous copy stays on the stage until this one is ready
  loadingMaterialId = materialId;
  refreshUI();
  await loadMissingTextures(asset);
  if (token !== loadToken) return false;
  loadingMaterialId = null;

  const copyId = MATERIAL_EDITOR_COPY_PREFIX + materialId;
  // Right before creating, in the same task: createMaterial returns a registered id as it is
  deleteCurrentCopy();
  // With the swap (the previous material kept its pose while this one's textures loaded)
  applyCameraPoseKey(materialId);
  try {
    const copy = createMaterial({
      ...getMaterialProps(asset),
      id: copyId,
      tslMaterialId: materialId,
      // A scene loaded while the view is active (app code, HMR) must not release it
      isPersistent: true,
    });
    current = { materialId, copyId };
    showPreview(kind, copy);
    failures.delete(materialId);
  } catch (err) {
    showLoadError(materialId, err instanceof Error ? err.message : String(err), err);
  }
  refreshUI();
  return token === loadToken;
};

const onSelect = (materialId: string) => {
  // Clicking the shown material again only retries a failed load
  if (materialId === selectedMaterialId && !failures.has(materialId)) return;
  void loadEditorMaterial(materialId);
};

const createUI = (): EditorUI => {
  const hud = document.createElement('div');
  hud.className = `${styles.materialEditorHud} ${KEEP_IN_VIEWS_CLASS}`;
  const notice = document.createElement('div');
  notice.className = styles.notice;
  hud.append(notice);
  const selector = createMaterialSelector({
    parent: hud,
    entries: getSelectorEntries(),
    onSelect,
    getSelectedId: () => selectedMaterialId,
    getLoadingId: () => loadingMaterialId,
    getFailure: (id) => failures.get(id),
    initialState: selectorState,
    onStateChange: (state) => {
      selectorState = state;
      persistUIState();
    },
  });
  drawerMaterialId = selectedMaterialId;
  const drawer = createEditorDrawer({
    id: MATERIAL_EDITOR_VIEW_ID,
    parent: hud,
    togglerText: 'Material',
    headingLabel: 'MATERIAL',
    initialState: drawerState,
    onStateChange: (state) => {
      drawerState = state;
      persistUIState();
    },
    getTitle: () => {
      const asset = selectedMaterialId ? getMaterialAssets()[selectedMaterialId] : undefined;
      return asset ? asset.debugData?.name || asset.id : 'No material selected';
    },
    getTabs: () =>
      createMaterialEditorTabs({
        getAsset: () => (selectedMaterialId && getMaterialAssets()[selectedMaterialId]) || null,
        getTextureIds: getMaterialTextureIds,
        isTextureLoaded: (id) => Boolean(getTexture(id)),
        getStatus: getSelectedStatus,
        getViewCamera: () => viewCam,
        refresh: () => ui?.drawer.refresh(),
      }),
  });
  getHUDRootCMP().elem.append(hud);
  return { hud, notice, selector, drawer };
};

const onEnter = () => {
  const s = (stage ??= createStage());
  ensureEnvironment(s.scene);
  getViewCamera().onEnter();
  // Right away, not after the textures: nothing else is on the stage yet (the load keeps it)
  applyCameraPoseKey(selectedMaterialId);
  ui ??= createUI();
  // Before the selector's scroll: an open drawer's debugDrawerOpen narrows the selector, and a
  // scroll restored at full width (fewer rows) would be clamped and saved that way
  ui.drawer.setActive(true);
  // The HUD was hidden outside the view (display: none loses the scroll position)
  ui.selector.restoreScroll();
  isEntered = true;
  // Not awaited: the view shows the stage while the textures load
  void loadEditorMaterial(selectedMaterialId);
};

const onExit = () => {
  isEntered = false;
  viewCam?.onExit();
  // Hands debugDrawerOpen back (the scene drawer sets it again on the switch back)
  ui?.drawer.setActive(false);
  // Discards a load in progress
  loadToken++;
  loadingMaterialId = null;
  // Nothing the editor holds outlives the view (a scene switch can release the copy's textures)
  deleteCurrentCopy();
};

/** Registers the material editor view (once). */
export const _registerMaterialEditorView = () => {
  // The scene is created here (no GPU work); the environment, the camera and the UI need the
  // renderer, the canvas and the HUD, so they are created on the first enter
  stage ??= createStage();
  // Here, not on the first enter: a loadEditorMaterial call before that wins over the saved one
  const saved = readMaterialEditorUIState();
  selectorState = saved.selector;
  drawerState = saved.drawer;
  const savedId = saved.selectedMaterialId;
  if (savedId && getMaterialAssets()[savedId]) selectedMaterialId = savedId;
  // A material that no longer exists is dropped
  else if (savedId) persistUIState();
  registerView({
    id: MATERIAL_EDITOR_VIEW_ID,
    title: 'Material editor',
    icon: 'material',
    orderNr: 0,
    scene: stage.scene,
    getCamera: () => viewCam?.camera ?? null,
    getCameraRig: () => viewCam?.rig ?? null,
    onEnter,
    onExit,
    mainUpdate: () => viewCam?.mainUpdate(),
    toggleDrawer: () => ui?.drawer.toggle(),
    update: (delta) => {
      if (!stageSettings.autoRotateSpeed || !stage) return;
      stage.previewRoot.rotation.y += delta * stageSettings.autoRotateSpeed * Math.PI * 2;
    },
  });
};
