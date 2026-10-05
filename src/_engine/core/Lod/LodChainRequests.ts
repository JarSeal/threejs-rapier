// LOD chains requested but maybe not started yet (docs/plans/_DONE_p348_ecs-lod-selection.md §5).
// Import-free: an import's `lodChain` generation starts only once LodChains has loaded, so
// ImportRegistry records the request here synchronously, and a mesh with `lod: 'AUTO'` created
// right after the import waits for it instead of finding no chain.

const requests = new Map<string, Promise<unknown>>();

/**
 * Records a requested LOD chain until `settled` settles (resolved or rejected).
 * @param geometryId the base geometry
 * @param settled settles once the chain is registered, refused or skipped
 */
export const trackLodChainRequest = (geometryId: string, settled: Promise<unknown>) => {
  const tracked: Promise<unknown> = settled
    .catch(() => undefined)
    .finally(() => {
      if (requests.get(geometryId) === tracked) requests.delete(geometryId);
    });
  requests.set(geometryId, tracked);
};

/** A requested LOD chain's settle promise (never rejects), or undefined without a request. */
export const getLodChainRequest = (geometryId: string) => requests.get(geometryId);
