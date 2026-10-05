// LOD chains (docs/plans/p347_lod-chain-generation.md): simplified levels of a registered geometry,
// generated in the assets worker (AppConfig.assets.simplifyWorkerTarget) and registered as ordinary
// geometries. Nothing selects a level yet (p348).
//
// Memory and lifetime: a level shares the base's vertex attributes (the same BufferAttribute
// objects) and only has its own index, unless the chain was generated with `compactVertices`. The
// chain holds one ref on each level and releases them when the base geometry is deleted. Disposing
// any geometry of a chain frees the shared vertex buffers on the GPU (three r186 deletes a disposed
// geometry's attributes), so a geometry of the chain still drawn after that re-uploads them on its
// next render.
import * as THREE from 'three/webgpu';
import { llog, lwarn } from '../../utils/Logger';
import { isDebugEnvironment } from '../Config';
import {
  decGeometryRef,
  getGeometryRegistry,
  incGeometryRef,
  onGeometryDeleted,
  saveBufferGeometry,
} from '../Geometry';
import { copyAssetOwner } from '../Assets/AssetOwners';
import {
  getAssetsWorkerTarget,
  recordAssetLoadReport,
  runAssetTask,
  simplifyGeometryInWorker,
} from '../Assets/AssetsAPI';
import type { AssetLoadReport } from '../Assets/AssetsAPITypes';
import { serializeGeometry, type TransferableAttribute } from '../Import/GeometryTransfer';
import {
  resolveLodChainOptions,
  simplifyLodChain,
  type LodChainOptions,
  type ResolvedLodChainOptions,
  type SimplifiedLodChain,
} from './LodSimplify';

export type { LodChainOptions, ResolvedLodChainOptions } from './LodSimplify';

/** Where a level's vertex arrays come from: the base's own (`BASE`, only the index differs), the
 * welded copy of a non-indexed base that the levels share (`WELDED`), or its own (`OWN`,
 * `compactVertices`). */
export type LodLevelVertices = 'BASE' | 'WELDED' | 'OWN';

export type LodChainLevel = {
  /** Level 0 is the base geometry's id, level n is `${baseId}#lod${n}`. */
  geometryId: string;
  triangles: number;
  /** meshoptimizer's error, relative to the chain's `extent` (0 for the base). It includes the
   * normal and uv deviation, so `error × extent` overestimates the world-space deviation. */
  error: number;
  vertices: LodLevelVertices;
};

export type LodChain = {
  baseId: string;
  /** The base's bounding sphere radius. */
  radius: number;
  /** The base's largest bounding box side: the scale the levels' `error` is relative to. */
  extent: number;
  options: ResolvedLodChainOptions;
  /** levels[0] is the base. Can be shorter than the requested ratios, or just the base. */
  levels: LodChainLevel[];
  /** Where it was generated and how long it took. `mainThreadMs` is the main thread's own work
   * (copying the input, registering the levels), not the simplifier's. */
  report: AssetLoadReport & { mainThreadMs: number };
};

const chains = new Map<string, LodChain>();
const baseIdOfLevel = new Map<string, string>();
const pending = new Map<string, Promise<LodChain | null>>();
let warnedMainThread = false;

/** The arrays the simplifier needs, as copies (the base stays usable after the transfer): all
 * attributes when they're welded or compacted, else only the weighted ones. */
const serializeInput = (base: THREE.BufferGeometry, options: ResolvedLodChainOptions) => {
  const needsAll = !base.index || options.compactVertices;
  const input = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(base.attributes)) {
    if (needsAll || name === 'position' || name === 'normal' || name === 'uv') {
      input.setAttribute(name, attr);
    }
  }
  input.setIndex(base.index);
  for (const { start, count, materialIndex } of base.groups) {
    input.addGroup(start, count, materialIndex);
  }
  const transfer = new Set<ArrayBuffer>();
  return { data: serializeGeometry(input, transfer, { copy: true }), transfer };
};

const toBufferAttributes = (attributes: Record<string, TransferableAttribute>) => {
  const out: Record<string, THREE.BufferAttribute> = {};
  for (const [name, { array, itemSize, normalized }] of Object.entries(attributes)) {
    out[name] = new THREE.BufferAttribute(array, itemSize, normalized);
    out[name].name = name;
  }
  return out;
};

/** Registers the simplified levels as geometries (ids `${baseId}#lod${n}`), each with one ref. */
const registerLevels = (baseId: string, base: THREE.BufferGeometry, result: SimplifiedLodChain) => {
  if (!base.boundingBox) base.computeBoundingBox();
  if (!base.boundingSphere) base.computeBoundingSphere();
  const baseName = getGeometryRegistry()[baseId]?.debugData?.name || baseId;
  const welded = result.welded ? toBufferAttributes(result.welded) : null;
  const levels: LodChainLevel[] = [
    { geometryId: baseId, triangles: result.baseTriangles, error: 0, vertices: 'BASE' },
  ];

  result.levels.forEach((level, i) => {
    const n = i + 1;
    const levelId = `${baseId}#lod${n}`;
    if (getGeometryRegistry()[levelId]) {
      // An earlier chain's level that something else still holds
      lwarn(`LOD chain: "${levelId}" is still registered (in use), so this level is left out.`);
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.name = base.name ? `${base.name}#lod${n}` : '';
    const attributes = level.attributes
      ? toBufferAttributes(level.attributes)
      : welded ?? base.attributes;
    for (const [name, attr] of Object.entries(attributes)) geometry.setAttribute(name, attr);
    geometry.setIndex(new THREE.BufferAttribute(level.index, 1));
    for (const { start, count, materialIndex } of level.groups) {
      geometry.addGroup(start, count, materialIndex);
    }
    // The base's bounds: a level stays within them (near enough for culling)
    geometry.boundingBox = base.boundingBox!.clone();
    geometry.boundingSphere = base.boundingSphere!.clone();
    geometry.userData.lodOf = baseId;
    geometry.userData.lodLevel = n;
    saveBufferGeometry(geometry, {
      id: levelId,
      debugData: {
        name: `${baseName} · LOD${n}`,
        description: `LOD${n} of "${baseId}": ${level.triangles} triangles, error ${level.error.toFixed(4)}`,
      },
    });
    copyAssetOwner(base, geometry);
    incGeometryRef(levelId);
    baseIdOfLevel.set(levelId, baseId);
    levels.push({
      geometryId: levelId,
      triangles: level.triangles,
      error: level.error,
      vertices: level.attributes ? 'OWN' : welded ? 'WELDED' : 'BASE',
    });
  });
  return levels;
};

/** Why a geometry can't get a chain, or undefined. */
const getRefusal = (geometryId: string, options: ResolvedLodChainOptions) => {
  const entry = getGeometryRegistry()[geometryId];
  if (!entry) return 'it is not registered';
  if (baseIdOfLevel.has(geometryId)) return 'it is a LOD level itself';
  const geometry = entry.resource;
  if (!geometry.getAttribute('position')) return 'it has no position attribute';
  // p347 §5: simplification breaks skin weights and morph targets
  if (geometry.getAttribute('skinIndex') || Object.keys(geometry.morphAttributes).length) {
    return 'skinned and morph-target geometry is not supported';
  }
  if (!options.ratios.length) return 'no ratio between 0 and 1 was given';
  return undefined;
};

const runGeneration = async (geometryId: string, options: ResolvedLodChainOptions) => {
  const refusal = getRefusal(geometryId, options);
  if (refusal) {
    lwarn(`LOD chain for geometry "${geometryId}" refused: ${refusal}.`);
    return null;
  }
  const base = getGeometryRegistry()[geometryId].resource;
  if (getAssetsWorkerTarget('SIMPLIFY') === 'MAIN_THREAD' && !warnedMainThread) {
    warnedMainThread = true;
    lwarn(
      'LOD chains are generated on the main thread (AppConfig.assets.simplifyWorkerTarget): a large mesh takes tens of ms (warned once).'
    );
  }

  let mainThreadMs = 0;
  const timedSerialize = () => {
    const startedAt = performance.now();
    const input = serializeInput(base, options);
    mainThreadMs += performance.now() - startedAt;
    return input;
  };
  const { result, report } = await runAssetTask(
    'SIMPLIFY',
    () => {
      const { data, transfer } = timedSerialize();
      return simplifyGeometryInWorker(data, options, transfer);
    },
    () => {
      const { data, transfer } = timedSerialize();
      return simplifyLodChain(data, options, transfer);
    }
  );

  // Deleted (or replaced) while it was simplified: nothing to attach the levels to
  if (getGeometryRegistry()[geometryId]?.resource !== base) return null;

  const startedAt = performance.now();
  releaseLodChain(geometryId);
  const levels = registerLevels(geometryId, base, result);
  mainThreadMs += performance.now() - startedAt;

  const chain: LodChain = {
    baseId: geometryId,
    radius: base.boundingSphere!.radius,
    extent: result.extent,
    options,
    levels,
    report: { ...report, mainThreadMs },
  };
  chains.set(geometryId, chain);
  recordAssetLoadReport(`lod:${geometryId}`, report);

  if (levels.length === 1) {
    lwarn(
      `LOD chain for geometry "${geometryId}": no level simplified within maxError ${options.maxError}.${
        options.permissive
          ? ''
          : ' Flat-shaded geometry (a normal per face) needs `permissive: true`.'
      } A very low-poly mesh has nothing to remove.`
    );
  } else if (isDebugEnvironment()) {
    llog(
      `[LOD] Chain for geometry "${geometryId}": ${levels.map((l) => l.triangles).join(' → ')} triangles, on the ${report.loadedOn === 'MAIN_THREAD' ? 'main thread' : 'worker'} in ${report.durationMs.toFixed(1)} ms (main thread's own work ${mainThreadMs.toFixed(2)} ms).`
    );
  }
  return chain;
};

/**
 * Generates a registered geometry's LOD chain: simplified levels (LOD1, LOD2, …) registered as
 * geometries `${geometryId}#lod${n}`, with their triangle counts and errors (p347 §2.2). Runs where
 * AppConfig.assets.simplifyWorkerTarget says (the assets worker by default through workerTarget),
 * falling back like an asset load. A chain the geometry already has is replaced. A call while one
 * is pending for the same geometry returns that one.
 * @param geometryId a registered geometry (not a LOD level, not skinned or with morph targets)
 * @param opts {@link LodChainOptions}
 * @returns the chain, or null when it was refused (warned) or the geometry was deleted meanwhile
 */
export const generateLodChain = (
  geometryId: string,
  opts?: LodChainOptions
): Promise<LodChain | null> => {
  const inFlight = pending.get(geometryId);
  if (inFlight) return inFlight;
  const promise = runGeneration(geometryId, resolveLodChainOptions(opts)).finally(() =>
    pending.delete(geometryId)
  );
  pending.set(geometryId, promise);
  return promise;
};

/** Returns a base geometry's LOD chain, if it has one. */
export const getLodChain = (baseId: string) => chains.get(baseId);

/** Returns every LOD chain, by base geometry id (read-only). */
export const getLodChains = (): ReadonlyMap<string, LodChain> => chains;

/** Returns the chain a LOD level geometry belongs to and its level number, if it is one. */
export const getLodChainOfLevel = (levelId: string) => {
  const chain = chains.get(baseIdOfLevel.get(levelId) ?? '');
  const level = chain?.levels.findIndex((l) => l.geometryId === levelId) ?? -1;
  return chain && level > 0 ? { chain, level } : undefined;
};

/** Whether a LOD chain is being generated for the geometry. */
export const isLodChainPending = (baseId: string) => pending.has(baseId);

/**
 * Releases a base geometry's LOD chain: its refs on the levels, which are then disposed unless
 * something else holds them. Deleting the base does this too.
 * @param baseId base geometry id
 */
export const releaseLodChain = (baseId: string) => {
  const chain = chains.get(baseId);
  if (!chain) return;
  chains.delete(baseId);
  for (const { geometryId } of chain.levels.slice(1)) {
    baseIdOfLevel.delete(geometryId);
    decGeometryRef(geometryId);
  }
};

onGeometryDeleted((id) => {
  if (chains.has(id)) releaseLodChain(id);
  const baseId = baseIdOfLevel.get(id);
  if (baseId === undefined) return;
  // A level deleted on its own (deleteGeometry): the chain goes on without it
  baseIdOfLevel.delete(id);
  const chain = chains.get(baseId);
  if (chain) chain.levels = chain.levels.filter((level) => level.geometryId !== id);
});
