// `lod: 'AUTO'` (docs/plans/p348_ecs-lod-selection.md §5): a mesh's levels read from its
// geometry's LOD chain (p347). Loaded by setMeshLod (MeshManager.ts) on first use, like LodChains.
//
// A chain level's error is relative to the chain's `extent`, so its world-space error is
// `error × extent × scale`. Projected, it covers `error × extent × H × s / (2 × radius)` pixels of a
// viewport H pixels high, for screen size `s` (the selection's metric, LodSystem.ts) and the LOD
// radius. So level k is fine while `s ≤ 2 × radius × maxPixelError / (error × extent × H)`, for
// perspective and orthographic cameras alike.
//
// An InstancedMesh (a static instance cell, §4.3) selects by its bounds over all its instances, and
// an instance's error scales with its matrix: its radius here is the bounds' over the largest
// instance scale. The pixel error is then the one at the cell's centre; instances nearer the camera
// show more.
import type * as THREE from 'three/webgpu';
import { lwarn } from '../../utils/Logger';
import { getConservativeGeometryRadius } from '../Spatial/SpatialIndexSystem';
import { getInstancedLodBounds } from './LodBounds';
import { getLodChain, getPendingLodChain, type LodChain } from './LodChains';
import { getLodChainRequest } from './LodChainRequests';
import type { LodAutoDef, LodDef, LodLevelDef } from './LodTypes';

/** The viewport height `maxPixelError` is measured at. */
export const LOD_AUTO_REFERENCE_HEIGHT = 1080;
const DEFAULT_MAX_PIXEL_ERROR = 1;
// A level simplified without error is fine at any size (a huge but finite bound)
const MIN_ERROR = 1e-9;

/**
 * Builds a mesh's levels from a LOD chain: each level is used down to the screen size where the
 * next one's error projects to `maxPixelError` pixels at a viewport height of 1080. A level the
 * next one is never worse than (its error isn't below the next one's) is left out.
 * @param chain the geometry's chain
 * @param radius the LOD radius (the base's `|center| + radius`, as the LOD component caches it)
 * @param auto `maxPixelError`, and the `cullScreenSize`, `hysteresis` and `bias` passed through
 * @returns the definition, level 0 being the mesh's own geometry
 */
export const lodDefFromChain = (
  chain: Pick<LodChain, 'levels' | 'extent'>,
  radius: number,
  auto: LodAutoDef
): LodDef => {
  const maxPixelError = auto.maxPixelError ?? DEFAULT_MAX_PIXEL_ERROR;
  const scale = (2 * radius * maxPixelError) / (chain.extent * LOD_AUTO_REFERENCE_HEIGHT);

  // Chain levels kept, each with the largest screen size it is fine at (level 0: any)
  const kept: { index: number; maxScreenSize: number }[] = [{ index: 0, maxScreenSize: Infinity }];
  if (scale > 0 && Number.isFinite(scale)) {
    for (let i = 1; i < chain.levels.length; i++) {
      const maxScreenSize = scale / Math.max(chain.levels[i].error, MIN_ERROR);
      // Wherever the last kept level would be used, this coarser one is fine too
      while (kept.length > 1 && maxScreenSize >= kept[kept.length - 1].maxScreenSize) kept.pop();
      kept.push({ index: i, maxScreenSize });
    }
  }

  const levels: LodLevelDef[] = kept.map(({ index }, i) => ({
    // A level is used down to where the next one becomes fine (the last one: below everything)
    screenSize: i + 1 < kept.length ? kept[i + 1].maxScreenSize : 0,
    ...(index > 0 ? { geo: chain.levels[index].geometryId } : {}),
  }));
  const def: LodDef = { levels };
  if (auto.cullScreenSize !== undefined) def.cullScreenSize = auto.cullScreenSize;
  if (auto.hysteresis !== undefined) def.hysteresis = auto.hysteresis;
  if (auto.bias !== undefined) def.bias = auto.bias;
  return def;
};

/** The radius `lodDefFromChain` takes for the mesh showing `geometry` as level 0. */
const getAutoLodRadius = (geometry: THREE.BufferGeometry, mesh?: THREE.Mesh) => {
  if (!(mesh as THREE.InstancedMesh | undefined)?.isInstancedMesh) {
    return getConservativeGeometryRadius(geometry);
  }
  const bounds = getInstancedLodBounds(mesh as THREE.InstancedMesh, geometry);
  return bounds.radius / bounds.maxInstanceScale;
};

/**
 * Resolves a mesh's `AUTO` LOD: waits for a chain its geometry's import requested or one being
 * generated, then builds the levels from it ({@link lodDefFromChain}). Warns when the geometry has
 * no chain: chains come from the asset (`lodChain` in its `*.importedAsset.json`, or
 * `generateLodChain` in code), never from a mesh.
 * @param geometry the mesh's geometry (level 0)
 * @param auto `'AUTO'` or its options
 * @param label names the mesh in the warnings
 * @param mesh the mesh, read once the chain is there: an InstancedMesh's thresholds come from its
 *   instances' bounds
 * @returns the definition, or null when there is nothing to select (warned)
 */
export const resolveAutoLod = async (
  geometry: THREE.BufferGeometry,
  auto: LodAutoDef | 'AUTO',
  label: string,
  mesh?: THREE.Mesh
): Promise<LodDef | null> => {
  const opts: LodAutoDef = auto === 'AUTO' ? { auto: true } : auto;
  const geometryId = geometry.userData.id as string | undefined;
  if (!geometryId) {
    lwarn(`[LOD] Mesh "${label}": lod AUTO needs a registered geometry (it has no id).`);
    return null;
  }

  await getLodChainRequest(geometryId);
  await getPendingLodChain(geometryId)?.catch(() => null);

  const chain = getLodChain(geometryId);
  if (!chain) {
    lwarn(
      `[LOD] Mesh "${label}": lod AUTO, but geometry "${geometryId}" has no LOD chain, so it stays on level 0. Give its *.importedAsset.json a lodChain, or call generateLodChain("${geometryId}") before the mesh's LOD is set.`
    );
    return null;
  }
  const def = lodDefFromChain(chain, getAutoLodRadius(geometry, mesh), opts);
  if (def.levels.length === 1 && (def.cullScreenSize ?? 0) <= 0) {
    lwarn(
      `[LOD] Mesh "${label}": lod AUTO, but the LOD chain of geometry "${geometryId}" has no simplified levels, so it stays on level 0.`
    );
    return null;
  }
  return def;
};
