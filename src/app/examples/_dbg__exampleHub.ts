import {
  getCurrentSceneId,
  getGeneratedSceneData,
  registerOnAllSceneEnterings,
} from '../../_engine/core/Scene';
import { takeSnapshotAsync } from '../../_engine/core/Snapshot';
import { isRuntimeViewActive } from '../../_engine/core/ViewManager';
import { addDebugToast, createDebuggerTab } from '../../_engine/debug/DebuggerGUI';
import {
  DevFilesError,
  encodePNG,
  getDevFilesStatus,
  writeDevFiles,
} from '../../_engine/debug/DevFiles';
import { lerror, lwarn } from '../../_engine/utils/Logger';

// The example scenes' "Hub" tab (docs/plans/p554_hub-examples-start-scene-and-example-scenes.md
// section 2.4): "Save Hub image" takes a snapshot of what the canvas shows (core/Snapshot.ts: the
// active camera, PostFX, no viewports or debug helpers) at a fixed size and writes it as
// `<sceneId>.hub.png` beside the scene file through the dev files (_DONE_p342). The Hub's
// `::: scene` directive and `aek:image` pick it up by that path (devTools/hub/scenes.ts) and
// convert it to webp. Without the dev files the PNG is downloaded, with the path to put it at.
// Every scene whose file is under `src/app/examples/` gets the tab on enter
// (`registerExampleHubTabs`, called from src/index.ts), so the example scene files hold only the
// example: the Hub pages include them.

const TAB_ID = 'exampleHub';

/** The image sizes: `CARD` for an example page and its card, `HERO` for the Hub's homepage */
export const HUB_IMAGE_SIZES = {
  CARD: { width: 1600, height: 1000 },
  // The homepage hero's image column (hub/pages/index.html): the placeholder's 585 × 360
  HERO: { width: 1560, height: 960 },
} as const;

export type HubImageSize = keyof typeof HUB_IMAGE_SIZES;

/**
 * The scene's Hub image, from the repo root: `<sceneFile's folder>/<sceneId>.hub.png` under
 * `src/app/` (the Hub reads it at the same path, `devTools/hub/scenes.ts`)
 */
export const getHubImagePath = (sceneId: string) => {
  const sceneFile = getGeneratedSceneData(sceneId)?.sceneFile;
  if (!sceneFile) return null;
  const folders = sceneFile.split(/[\\/]/).filter((part) => part && part !== '.');
  folders.pop();
  return ['src/app', ...folders, `${sceneId}.hub.png`].join('/');
};

const downloadBlob = (fileName: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

let isSaving = false;

/**
 * Renders the scene's Hub image and writes it beside the scene file, or downloads it when the dev
 * files can't write (see the module comment). Reports through toasts; never rejects.
 */
export const saveHubImageAsync = async (sceneId: string, size: HubImageSize = 'CARD') => {
  if (isSaving) return;
  isSaving = true;
  const path = getHubImagePath(sceneId);
  try {
    if (!path) throw new Error(`The scene "${sceneId}" isn't in the generated data.`);
    if (!isRuntimeViewActive()) throw new Error('Switch back to the Runtime view first.');
    const { width, height } = HUB_IMAGE_SIZES[size];
    const blob = await encodePNG(await takeSnapshotAsync({ width, height }));
    const status = await getDevFilesStatus();
    if (!status.available) {
      downloadBlob(path.slice(path.lastIndexOf('/') + 1), blob);
      lwarn(`Hub image (${status.message}): downloaded. Put it at:\n${path}`);
      addDebugToast({
        type: 'warning',
        title: `Hub image downloaded (${status.message})`,
        message: `Put it at ${path}`,
        showingTime: 15000,
      });
      return;
    }
    const [result] = (await writeDevFiles([{ path, blob }])).results;
    addDebugToast({
      title: result.status === 'unchanged' ? 'Hub image unchanged' : 'Hub image saved',
      message: `${path} (${width} × ${height})${result.status === 'unchanged' ? ': the same pixels as before' : ''}`,
    });
  } catch (err) {
    const message =
      err instanceof DevFilesError && err.code === 'CONFLICT'
        ? 'The file changed on disk while saving: save again.'
        : (err as Error).message;
    lerror(`Saving the Hub image failed: ${message}`, err);
    addDebugToast({ type: 'alert', title: 'Saving the Hub image failed', message });
  } finally {
    isSaving = false;
  }
};

/**
 * The example scene's "Hub" tab (a scene tab: removed on the scene's exit, created again on every
 * visit). Create it from the scene file, in the debug env only, through a dynamic import.
 * @param sceneId (string) the example scene's id
 * @param size ({@link HubImageSize}) the image's size, default `CARD`
 */
export const createExampleHubTab = (sceneId: string, size: HubImageSize = 'CARD') => {
  const { width, height } = HUB_IMAGE_SIZES[size];
  const info = { file: getHubImagePath(sceneId) ?? '-', size: `${width} × ${height}` };

  createDebuggerTab({
    id: TAB_ID,
    title: 'Hub',
    icon: 'aekasha',
    sceneId,
    content: () => [
      {
        pane: true,
        content: [
          { key: 'file', target: info, label: 'File', readonly: true },
          { key: 'size', target: info, label: 'Size', readonly: true },
          {
            type: 'button',
            title: 'Save Hub image',
            label: 'Active camera, PostFX',
            onClick: () => void saveHubImageAsync(sceneId, size),
          },
        ],
      },
    ],
  });
};

/** Example scenes whose Hub image isn't a card */
const SCENE_IMAGE_SIZES: Record<string, HubImageSize> = { exampleHubHero: 'HERO' };

/** Scenes outside `src/app/examples/` that a Hub page shows (`::: scene`), so they get the tab too */
const OTHER_HUB_SCENES = new Set(['lodShowcase']);

/**
 * Gives every example scene (a scene file under `src/app/examples/`) and the other scenes the Hub
 * shows its "Hub" tab on enter. Call it once before the first scene loads, in the debug env
 * only, through a dynamic import.
 */
export const registerExampleHubTabs = () =>
  registerOnAllSceneEnterings(TAB_ID, () => {
    const sceneId = getCurrentSceneId();
    const sceneFile = sceneId ? getGeneratedSceneData(sceneId)?.sceneFile : undefined;
    if (!sceneId || !sceneFile) return;
    if (!/^(\.\/)?examples\//.test(sceneFile) && !OTHER_HUB_SCENES.has(sceneId)) return;
    createExampleHubTab(sceneId, SCENE_IMAGE_SIZES[sceneId]);
  });
