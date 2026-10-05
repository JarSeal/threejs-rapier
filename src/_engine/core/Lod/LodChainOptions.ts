// LOD chain options (docs/plans/p347_lod-chain-generation.md §2.2). Import-free: the asset pipeline
// resolves them in Node without loading three.

export type LodChainOptions = {
  /** Target triangle counts, as ratios of the base's, one per level. Default [0.5, 0.25, 0.1]. */
  ratios?: number[];
  /** meshoptimizer's target error cap, relative to the mesh's extent. Default 0.05. */
  maxError?: number;
  /** How much normal and uv deviation count against a collapse. Default 0.5 each (0 ignores it). */
  attributeWeights?: { normal?: number; uv?: number };
  /** Each level gets its own trimmed vertex arrays, instead of sharing the base's (only its index
   * differs). Better for large meshes whose far levels use few vertices. Default false. */
  compactVertices?: boolean;
  /** Keeps the mesh's open borders in place, so tiling geometry (eg. terrain blocks) still meets
   * its neighbours. Default false. */
  lockBorder?: boolean;
  /** Lets collapses cross attribute seams. Flat-shaded geometry (a normal per face) has a seam on
   * every edge and doesn't simplify without it. Default false. */
  permissive?: boolean;
};

export type ResolvedLodChainOptions = {
  ratios: number[];
  maxError: number;
  attributeWeights: { normal: number; uv: number };
  compactVertices: boolean;
  lockBorder: boolean;
  permissive: boolean;
};

/** Where a level's vertex arrays come from: the base's own (`BASE`, only the index differs), the
 * welded copy of a non-indexed base that the levels share (`WELDED`), or its own (`OWN`,
 * `compactVertices`). */
export type LodLevelVertices = 'BASE' | 'WELDED' | 'OWN';

export const DEFAULT_LOD_CHAIN_OPTIONS: ResolvedLodChainOptions = {
  ratios: [0.5, 0.25, 0.1],
  maxError: 0.05,
  attributeWeights: { normal: 0.5, uv: 0.5 },
  compactVertices: false,
  lockBorder: false,
  permissive: false,
};

/**
 * Fills in a chain's defaults. Ratios outside (0, 1) are dropped, the rest sorted from the most
 * detailed level down.
 * @param opts {@link LodChainOptions}
 */
export const resolveLodChainOptions = (opts?: LodChainOptions): ResolvedLodChainOptions => {
  const d = DEFAULT_LOD_CHAIN_OPTIONS;
  return {
    ratios: (opts?.ratios ?? d.ratios).filter((r) => r > 0 && r < 1).sort((a, b) => b - a),
    maxError: opts?.maxError ?? d.maxError,
    attributeWeights: {
      normal: opts?.attributeWeights?.normal ?? d.attributeWeights.normal,
      uv: opts?.attributeWeights?.uv ?? d.attributeWeights.uv,
    },
    compactVertices: opts?.compactVertices ?? d.compactVertices,
    lockBorder: opts?.lockBorder ?? d.lockBorder,
    permissive: opts?.permissive ?? d.permissive,
  };
};
