/**
 * The material editor (docs/plans/p084_material-editor-stage-and-selector.md), the first editor
 * view: a ball on a stage of its own (lights, a studio environment, a grey background), seen
 * through the editor's orbit camera, showing an editor copy of a project material
 * (`*.material.json`).
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
import type { MaterialAsset } from '../../../../schemas/materialSchema';
import { createViewCamera, type ViewCamera } from '../_dbg__ViewCamera';
import { lerror, lwarn } from '../../../../utils/Logger';

export const MATERIAL_EDITOR_VIEW_ID = 'materialEditor';
/** The material registry id prefix of the editor's copies (anything that lists the registry can
 * skip them). */
export const MATERIAL_EDITOR_COPY_PREFIX = '__matEditor__';

const BACKGROUND_COLOR = 0x5a5a5a;

/** The editor's stage: one private scene with the preview ball, its lights and its environment. */
type Stage = {
  scene: THREE.Scene;
  ball: THREE.Mesh;
  /** On the ball while no editor copy exists (before the first load and after the exit). */
  placeholderMaterial: THREE.Material;
};

let stage: Stage | null = null;
let viewCam: ViewCamera | null = null;
/** The editor copy on the ball, and the project material it was made from. */
let current: { materialId: string; copyId: string } | null = null;
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

  const placeholderMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x808080 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), placeholderMaterial);
  ball.name = 'materialEditorBall';
  scene.add(ball);

  return { scene, ball, placeholderMaterial };
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
  });
  return viewCam;
};

const getMaterialAssets = () =>
  getGeneratedAppData().materials as unknown as Record<string, MaterialAsset>;

/** The asset's creation props, without the gatherer's tooling fields. */
const getMaterialProps = (asset: MaterialAsset): MatProps => {
  const props: Record<string, unknown> = { ...asset, params: { ...asset.params } };
  delete props.$schema;
  delete props.__sourcePath;
  delete props.__saveData;
  return props as MatProps;
};

const deleteCurrentCopy = () => {
  if (!current) return;
  if (stage) stage.ball.material = stage.placeholderMaterial;
  deleteMaterial(current.copyId);
  current = null;
};

/**
 * Shows a project material on the ball: creates its editor copy and deletes the previous one.
 * @param materialId (string) a `*.material.json` id
 */
export const loadEditorMaterial = (materialId: string) => {
  if (!stage) return;
  const asset = getMaterialAssets()[materialId];
  if (!asset) {
    lwarn(`Could not find material "${materialId}", in loadEditorMaterial.`);
    return;
  }
  const copyId = MATERIAL_EDITOR_COPY_PREFIX + materialId;
  // Before creating: createMaterial returns a registered id as it is
  deleteCurrentCopy();
  try {
    const copy = createMaterial({
      ...getMaterialProps(asset),
      id: copyId,
      tslMaterialId: materialId,
      // A scene loaded while the view is active (app code, HMR) must not release it
      isPersistent: true,
    });
    stage.ball.material = copy;
    current = { materialId, copyId };
  } catch (err) {
    lerror(`Could not create the editor copy of material "${materialId}".`, err);
  }
};

const onEnter = () => {
  const s = (stage ??= createStage());
  ensureEnvironment(s.scene);
  getViewCamera().onEnter();
  const firstId = Object.keys(getMaterialAssets())[0];
  if (firstId) loadEditorMaterial(firstId);
};

const onExit = () => {
  viewCam?.onExit();
  // Nothing the editor holds outlives the view (a scene switch can release the copy's textures)
  deleteCurrentCopy();
};

/** Registers the material editor view (once). */
export const _registerMaterialEditorView = () => {
  // The scene is created here (no GPU work); the environment and the camera need the renderer
  // and the canvas, so they are created on the first enter
  stage ??= createStage();
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
    update: (delta) => {
      if (!stageSettings.autoRotateSpeed || !stage) return;
      stage.ball.rotation.y += delta * stageSettings.autoRotateSpeed * Math.PI * 2;
    },
  });
};
