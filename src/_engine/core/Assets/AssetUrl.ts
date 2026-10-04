import { lwarn } from '../../utils/Logger';
import type { GeneratedAssetFields } from '../../schemas/assetsConfigSchema';

/**
 * The asset pipeline's URLs (p300), baked into a texture's or an imported asset's generated data
 * by gatherAppData. Scene data carries them; code that loads a file by its name doesn't set them.
 */
export type GeneratedAssetUrls = Pick<GeneratedAssetFields, '__url' | '__sourceUrl'>;

/** Source URLs already warned about, so a source used by many scenes warns once. */
const warnedSourceUrls = new Set<string>();

/** A generated URL is root-absolute (`/aek-assets/…`): resolved against the app's base, like the
 * decoders' paths, so it also works when the app is served from a sub path. */
const toAppUrl = (url: string) =>
  new URL(`${import.meta.env.BASE_URL}${url.replace(/^\/+/, '')}`, document.baseURI).href;

/** A `fileName` relative to its asset JSON (`./`, `../`), which only the asset pipeline reads. */
export const isJsonRelativeFileName = (fileName: string) =>
  fileName.startsWith('./') || fileName.startsWith('../');

/**
 * Returns the absolute URL to load an asset file from:
 * 1. the pipeline's output (`__url`);
 * 2. else its source as the dev server serves it (`__sourceUrl`, dev data only): the pipeline has
 *    no output for it (encoder missing, a failed encode, or not built yet), warned once;
 * 3. else the `fileName` as the loader always resolved it (`legacyUrl`).
 *
 * Throws for a `fileName` relative to its JSON with neither URL: nothing serves it at that path.
 * @param asset the asset's `fileName` and generated URLs
 * @param legacyUrl resolves a `fileName` the way the asset's loader always did
 */
export const resolveAssetUrl = (
  asset: GeneratedAssetUrls & { fileName: string },
  legacyUrl: (fileName: string) => string
) => {
  if (asset.__url) return toAppUrl(asset.__url);
  if (asset.__sourceUrl) {
    if (!warnedSourceUrls.has(asset.__sourceUrl)) {
      warnedSourceUrls.add(asset.__sourceUrl);
      lwarn(
        `Asset "${asset.fileName}" is loaded from its source: the asset pipeline has no output for it (encoder missing, the encode failed, or not built yet; see the dev server's log, or run "yarn assets").`
      );
    }
    return toAppUrl(asset.__sourceUrl);
  }
  if (isJsonRelativeFileName(asset.fileName)) {
    throw new Error(
      `"${asset.fileName}" is relative to its asset JSON, which only loads through the asset pipeline's output, and this asset has none. Run "yarn assets" (or "yarn gatherAppData") and check its output.`
    );
  }
  return legacyUrl(asset.fileName);
};
