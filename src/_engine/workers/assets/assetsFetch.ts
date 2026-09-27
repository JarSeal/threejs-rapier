/// <reference lib="webworker" />

/** The file itself could not be fetched: the main thread would fail the same way, so the
 * request is answered with `isSourceError` and not re-run there. */
export class AssetsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetsSourceError';
  }
}

/**
 * Fetches an asset file (with the same checks as GLTFSource.ts's main-thread fetch).
 * @param url absolute URL
 */
export const fetchAsset = async (url: string) => {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new AssetsSourceError(
      `Fetch failed for "${url}" (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!response.ok) {
    throw new AssetsSourceError(`HTTP ${response.status} ${response.statusText} for "${url}"`);
  }
  // SPA-style servers (incl. the Vite dev server) answer a missing file with index.html
  if (response.headers.get('content-type')?.includes('text/html')) {
    throw new AssetsSourceError(`File not found (the server returned an HTML page) for "${url}"`);
  }
  return response;
};
