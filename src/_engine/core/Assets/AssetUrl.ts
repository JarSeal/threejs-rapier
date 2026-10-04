import { llog, lwarn } from '../../utils/Logger';
import { lsGetItem } from '../../utils/LocalAndSessionStorage';
import { DEBUG_ASSETS_BOOT_LS_KEY, isDebugEnvironment } from '../Config';
import type { GeneratedAssetFields } from '../../schemas/assetsConfigSchema';

/**
 * The asset pipeline's URLs (p300), baked into a texture's or an imported asset's generated data
 * by gatherAppData. Scene data carries them; code that loads a file by its name doesn't set them.
 */
export type GeneratedAssetUrls = Pick<GeneratedAssetFields, '__url' | '__sourceUrl'>;

/** Source URLs already warned about, so a source used by many scenes warns once. */
const warnedSourceUrls = new Set<string>();
/** Packed textures already logged by the "Load source files" override. */
const loggedPackedAssets = new Set<string>();

/** A generated URL is root-absolute (`/aek-assets/…`): resolved against the app's base, like the
 * decoders' paths, so it also works when the app is served from a sub path. */
export const toAppUrl = (url: string) =>
  new URL(`${import.meta.env.BASE_URL}${url.replace(/^\/+/, '')}`, document.baseURI).href;

/** A `fileName` relative to its asset JSON (`./`, `../`), which only the asset pipeline reads. */
export const isJsonRelativeFileName = (fileName: string) =>
  fileName.startsWith('./') || fileName.startsWith('../');

let loadSourceFiles: boolean | undefined;

/**
 * Whether this page load loads the pipeline's source files instead of its outputs: the Assets
 * debug tab's "Load source files" boot override (p300 DD8 level 3, `AEK_debugAssetsBoot`), debug
 * env only. Read once, on the first call. A production build ships no sources, so there it's
 * always false (warned once when the override is saved).
 */
export const isLoadingSourceFiles = () => {
  if (loadSourceFiles !== undefined) return loadSourceFiles;
  const isSaved =
    isDebugEnvironment() &&
    (lsGetItem(DEBUG_ASSETS_BOOT_LS_KEY, {}) as { loadSourceFiles?: boolean }).loadSourceFiles ===
      true;
  loadSourceFiles = isSaved && import.meta.env.DEV;
  if (isSaved && !loadSourceFiles) {
    lwarn(
      `The Assets tab's "Load source files" override is ignored: a production build ships no source files, only the asset pipeline's outputs.`
    );
  } else if (loadSourceFiles) {
    llog(
      `Loading the asset pipeline's source files instead of its outputs (the Assets tab's "Load source files" override).`
    );
  }
  return loadSourceFiles;
};

/**
 * Returns the absolute URL to load an asset file from:
 * 1. the pipeline's output (`__url`), unless the "Load source files" override (see
 *    isLoadingSourceFiles) loads its source (`__sourceUrl`) instead. A packed texture has no
 *    source file, so it loads its output either way (logged once);
 * 2. else its source as the dev server serves it (`__sourceUrl`, dev data only): the pipeline has
 *    no output for it (encoder missing, a failed encode, or not built yet), warned once;
 * 3. else the `fileName` as the loader always resolved it (`legacyUrl`).
 *
 * Throws for a `fileName` relative to its JSON with neither URL: nothing serves it at that path.
 * @param asset the asset's id, `fileName` (none for a packed texture) and generated URLs
 * @param legacyUrl resolves a `fileName` the way the asset's loader always did
 */
export const resolveAssetUrl = (
  asset: GeneratedAssetUrls & { id?: string; fileName?: string },
  legacyUrl: (fileName: string) => string
) => {
  const name = asset.fileName ?? asset.id ?? '(no file name)';
  if (asset.__url) {
    if (isLoadingSourceFiles()) {
      if (asset.__sourceUrl) return toAppUrl(asset.__sourceUrl);
      if (!loggedPackedAssets.has(asset.__url)) {
        loggedPackedAssets.add(asset.__url);
        llog(
          `Asset "${name}" is packed by the asset pipeline and has no source file: it loads its output despite the "Load source files" override.`
        );
      }
    }
    return toAppUrl(asset.__url);
  }
  if (asset.__sourceUrl) {
    if (!warnedSourceUrls.has(asset.__sourceUrl)) {
      warnedSourceUrls.add(asset.__sourceUrl);
      lwarn(
        `Asset "${name}" is loaded from its source: the asset pipeline has no output for it (encoder missing, the encode failed, or not built yet; see the dev server's log, or run "yarn assets").`
      );
    }
    return toAppUrl(asset.__sourceUrl);
  }
  if (!asset.fileName) {
    throw new Error(
      `Asset "${name}" has neither a file name nor an asset pipeline output. A packed texture loads only through its output: run "yarn assets" (or "yarn gatherAppData") and check its output.`
    );
  }
  if (isJsonRelativeFileName(asset.fileName)) {
    throw new Error(
      `"${asset.fileName}" is relative to its asset JSON, which only loads through the asset pipeline's output, and this asset has none. Run "yarn assets" (or "yarn gatherAppData") and check its output.`
    );
  }
  return legacyUrl(asset.fileName);
};
