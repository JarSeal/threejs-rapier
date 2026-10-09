import type * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../../utils/Logger';
import { deleteGeometry, doesGeoExist, getGeometryRegistry, saveBufferGeometry } from '../Geometry';
import { isTextureUsedByAnyMaterial } from '../Material';
import { deleteTexture, doesTextureExist, getTextureRegistry } from '../Texture';
import { loadGLTFInWorker, recordAssetLoadReport, runAssetTask } from '../Assets/AssetsAPI';
import type { AssetLoadReport } from '../Assets/AssetsAPITypes';
import { getAssetOwner, recordAssetOwner, retagAssetOwner } from '../Assets/AssetOwners';
import { resolveAssetUrl } from '../Assets/AssetUrl';
import { getDracoWorkerSettings } from './DracoDecoder';
import { deserializeGeometry } from './GeometryTransfer';
import { disposeGLTFLeftovers, extractPrimitives } from './GLTFExtract';
import { loadGLTF, toAbsoluteUrl, validateGLTFFileName } from './GLTFSource';
import { collectGLTFTextures } from './GLTFTextureCollect';
import { registerGLTFTextures, type RegisteredGLTFTextures } from './GLTFTextures';
import { getKTX2WorkerSettings } from './KTX2';
import {
  createTransferredSources,
  deserializeTexture,
  releaseTransferableImage,
} from './TextureTransfer';
import type { LodChainOptions } from '../Lod/LodChainOptions';
import { trackLodChainRequest } from '../Lod/LodChainRequests';
import {
  deserializeLodChain,
  readGLTFLodChains,
  type ExtractedLodChain,
} from '../Lod/LodChainGLTF';
import type { ImportAssetParams, ImportedAssetManifest, ImportedGeometryInfo } from './ImportTypes';

type ImportRecord = {
  manifest: ImportedAssetManifest;
  isPersistent: boolean;
  /** Imported with importTextures (a later call asking for textures re-imports otherwise). */
  hasTextures: boolean;
  /** fileName + meshIndex: an id can only be reused for the same source. */
  sourceKey: string;
};

const imports: { [id: string]: ImportRecord } = {};
const pendingImports = new Map<
  string,
  { promise: Promise<ImportedAssetManifest | null>; sourceKey: string }
>();

const getSourceKey = (params: ImportAssetParams) =>
  `${params.fileName}|${JSON.stringify(params.meshIndex ?? null)}`;

/** Default import id: the file's basename without the extension ('/a/box01.glb' → 'box01'). */
const getDefaultImportId = (fileName: string) =>
  (fileName.split(/[?#]/)[0].split('/').pop() || fileName).replace(/\.(glb|gltf)$/i, '');

const getImportInfo = (geometryId: string) =>
  getGeometryRegistry()[geometryId]?.resource.userData.importInfo as
    | ImportedGeometryInfo
    | undefined;

/** Finds the registry id for an extracted primitive: its preferred id, or the first free
 * `_n`-suffixed one when another geometry already uses it. A geometry this same import and node
 * registered earlier (eg. one still in use when the import was released) is reused. */
const resolveGeometryId = (info: ImportedGeometryInfo) => {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? info.geometryId : `${info.geometryId}_${n}`;
    if (!doesGeoExist(candidate)) return { geometryId: candidate, isReused: false };
    const existing = getImportInfo(candidate);
    if (existing?.importId === info.importId && existing.nodeName === info.nodeName) {
      return { geometryId: candidate, isReused: true };
    }
  }
};

const isManifestValid = (manifest: ImportedAssetManifest) =>
  manifest.geometries.every((info) => doesGeoExist(info.geometryId)) &&
  manifest.textureIds.every((textureId) => doesTextureExist(textureId));

/** Re-tags a cached import to the scene getting it: its record, geometries and textures. */
const retagImportOwner = (record: ImportRecord) => {
  retagAssetOwner(record);
  const geometryRegistry = getGeometryRegistry();
  for (const info of record.manifest.geometries) {
    const entry = geometryRegistry[info.geometryId];
    if (entry) retagAssetOwner(entry.resource);
  }
  const textureRegistry = getTextureRegistry();
  for (const textureId of record.manifest.textureIds) {
    const entry = textureRegistry[textureId];
    if (entry) retagAssetOwner(entry.resource);
  }
};

const logWarnings = (manifest: ImportedAssetManifest) => {
  for (const info of manifest.geometries) {
    for (const warning of info.customProps.warnings) {
      lwarn(`Import "${manifest.id}" (${manifest.fileName}), node "${info.nodeName}": ${warning}`);
    }
  }
};

/** Starts the LOD chains an import asks for (`lodChain`, p347): one per rendered geometry that
 * has no chain yet and none pending. Not awaited by the import. LodChains is loaded on first use,
 * so apps that never ask for a chain don't download it. generateLodChain refuses (and warns about)
 * skinned and morph-target geometry. */
const requestLodChains = (manifest: ImportedAssetManifest, lodChain: true | LodChainOptions) => {
  const geometryIds = new Set<string>();
  for (const { geometryId, customProps } of manifest.geometries) {
    // Collider only: never rendered (spawnImportedAsset gives it no mesh)
    if (customProps.isPhysObj && !customProps.keepMesh) continue;
    geometryIds.add(geometryId);
  }
  if (!geometryIds.size) return;
  const opts = lodChain === true ? undefined : lodChain;
  const ready = import('../Lod/LodChains');
  ready.catch((err) =>
    lerror(`Import "${manifest.id}": could not load the LOD chain module.`, err)
  );
  for (const geometryId of geometryIds) {
    // Tracked from now, so a mesh with `lod: 'AUTO'` created before the module loads waits for it
    const settled = ready.then(({ generateLodChain, getLodChain, isLodChainPending }) => {
      // Released while the module loaded, or already chained (the first options win)
      if (!doesGeoExist(geometryId)) return;
      if (getLodChain(geometryId) || isLodChainPending(geometryId)) return;
      return generateLodChain(geometryId, opts).catch((err) =>
        lerror(`Import "${manifest.id}": LOD chain for geometry "${geometryId}" failed.`, err)
      );
    });
    trackLodChainRequest(geometryId, settled);
  }
};

/** Registers the LOD chains the asset pipeline built into the file (p347 Phase 3), whatever the
 * import's `lodChain` says: the file is shared by every use, and its levels were downloaded
 * anyway. Awaited, so a `lodChain` request right after the import finds them. */
const registerPrebuiltLodChains = async (
  importId: string,
  prebuilt: { geometryId: string; chain: ExtractedLodChain }[]
) => {
  try {
    const { registerPrebuiltLodChain } = await import('../Lod/LodChains');
    for (const { geometryId, chain } of prebuilt) registerPrebuiltLodChain(geometryId, chain);
  } catch (err) {
    lerror(`Import "${importId}": could not load the LOD chain module.`, err);
  }
};

const LOAD_ERROR_MESSAGE = 'loading or parsing the file failed.';

/** The "load + extract" stage of an import: the only part that differs by thread. */
type LoadOutcome =
  | {
      primitives: {
        geometry: THREE.BufferGeometry;
        info: ImportedGeometryInfo;
        lodChain?: ExtractedLodChain;
      }[];
      textures: RegisteredGLTFTextures | null;
      /** Disposes everything the load created except the kept (registered) geometries and the
       * registered textures. */
      disposeLeftovers: (keepGeometries: Set<THREE.BufferGeometry>) => void;
      error?: undefined;
    }
  | { error: string; cause?: unknown };

const getTextureRegistrationOpts = (params: ImportAssetParams, id: string) => {
  const { importTextures } = params;
  return {
    importId: id,
    importName: params.debugData?.name || id,
    fileName: params.fileName,
    texOpts: typeof importTextures === 'object' ? importTextures.texOpts : undefined,
    isPersistent:
      (typeof importTextures === 'object' ? importTextures.isPersistent : undefined) ??
      params.isPersistent,
  };
};

const loadOnMainThread = async (
  params: ImportAssetParams,
  id: string,
  url: string
): Promise<LoadOutcome> => {
  const { meshIndex, importTextures } = params;
  let gltf;
  try {
    gltf = await loadGLTF(url);
  } catch (err) {
    return { error: LOAD_ERROR_MESSAGE, cause: err };
  }

  const lodChains = await readGLTFLodChains(gltf);
  const extracted = extractPrimitives(gltf, { importId: id, meshIndex, lodChains });
  if (extracted.error !== undefined) {
    disposeGLTFLeftovers(gltf, {});
    return { error: extracted.error };
  }

  const textures = importTextures
    ? registerGLTFTextures(
        collectGLTFTextures(gltf, extracted.primitives),
        getTextureRegistrationOpts(params, id)
      )
    : null;

  return {
    primitives: extracted.primitives,
    textures,
    disposeLeftovers: (keepGeometries) =>
      disposeGLTFLeftovers(gltf, { geometries: keepGeometries, textures: textures?.keep }),
  };
};

/** The same stage in the assets worker: it runs the same extractPrimitives() (and
 * collectGLTFTextures()) and sends the geometries (and texture images) back as transferable data,
 * which are wrapped here (nothing is parsed, decoded or copied). */
const loadInWorker = async (
  params: ImportAssetParams,
  id: string,
  url: string
): Promise<LoadOutcome> => {
  const response = await loadGLTFInWorker(url, {
    importId: id,
    meshIndex: params.meshIndex,
    importTextures: Boolean(params.importTextures),
    draco: getDracoWorkerSettings(),
    ktx2: await getKTX2WorkerSettings(),
  });
  if (response.error !== undefined) return { error: response.error };

  const geometries = response.geometries.map(deserializeGeometry);
  const lodChains = new Map(
    response.lodChains.map(({ geometryIndex, chain }) => [
      geometryIndex,
      deserializeLodChain(chain, geometries[geometryIndex]),
    ])
  );
  const primitives = response.primitives.map(({ geometryIndex, info }) => {
    const lodChain = lodChains.get(geometryIndex);
    return { geometry: geometries[geometryIndex], info, ...(lodChain ? { lodChain } : {}) };
  });

  // One source per image: textures sharing an image share its source, as GLTFLoader's clones do
  const sources = createTransferredSources(response.images);
  const rebuiltTextures = response.textures.map(({ texture }) =>
    deserializeTexture(texture, sources[texture.imageIndex])
  );
  const textures = params.importTextures
    ? registerGLTFTextures(
        {
          textures: response.textures.map(({ name, gltfTextureKey }, i) => ({
            texture: rebuiltTextures[i],
            name,
            gltfTextureKey,
          })),
          slotsPerPrimitive: response.textureSlotsPerPrimitive,
        },
        getTextureRegistrationOpts(params, id)
      )
    : null;

  return {
    primitives,
    textures,
    disposeLeftovers: (keepGeometries) => {
      for (const geometry of geometries) if (!keepGeometries.has(geometry)) geometry.dispose();
      // Same rule as disposeGLTFLeftovers(): an unregistered texture (one a re-import reuses) is
      // disposed, and its image closed unless a registered texture shares it
      const keptSources = new Set<THREE.TextureSource<unknown>>();
      textures?.keep.forEach((texture) => keptSources.add(texture.source));
      rebuiltTextures.forEach((texture, i) => {
        if (textures?.keep.has(texture)) return;
        texture.dispose();
        if (!keptSources.has(texture.source)) {
          releaseTransferableImage(response.images[response.textures[i].texture.imageIndex]);
        }
      });
    },
  };
};

const runImport = async (
  params: ImportAssetParams,
  id: string,
  sourceKey: string
): Promise<ImportedAssetManifest | null> => {
  const { fileName, isPersistent } = params;
  const fail = (message: string, err?: unknown) => {
    lerror(`Could not import "${fileName}" (import id "${id}"): ${message}`, ...(err ? [err] : []));
    if (params.throwOnError) throw new Error(`Error while importing "${fileName}": ${message}`);
    return null;
  };

  const fileNameError = validateGLTFFileName(fileName);
  if (fileNameError) return fail(fileNameError);

  // The file to load: the asset pipeline's output when the params come from generated data
  let url: string;
  try {
    url = resolveAssetUrl(params, toAbsoluteUrl);
  } catch (err) {
    return fail((err as Error).message);
  }
  const urlError = validateGLTFFileName(url);
  if (urlError) return fail(urlError);

  let loaded: LoadOutcome;
  let report: AssetLoadReport;
  try {
    ({ result: loaded, report } = await runAssetTask(
      'GLTF',
      () => loadInWorker(params, id, url),
      () => loadOnMainThread(params, id, url)
    ));
  } catch (err) {
    return fail(LOAD_ERROR_MESSAGE, err);
  }
  if (loaded.error !== undefined) return fail(loaded.error, loaded.cause);
  const { primitives, textures } = loaded;

  const keepGeometries = new Set<THREE.BufferGeometry>();
  /** Nodes sharing one glTF mesh share one BufferGeometry: register it once. */
  const idByGeometry = new Map<THREE.BufferGeometry, string>();
  const geometries: ImportedGeometryInfo[] = [];
  /** Only for a geometry registered by this import: a reused one keeps what it has */
  const prebuiltLodChains: { geometryId: string; chain: ExtractedLodChain }[] = [];
  for (let i = 0; i < primitives.length; i++) {
    const { geometry, lodChain } = primitives[i];
    const info = textures
      ? { ...primitives[i].info, textureSlots: textures.slotsPerPrimitive[i] }
      : primitives[i].info;
    const sharedId = idByGeometry.get(geometry);
    if (sharedId) {
      geometries.push({ ...info, geometryId: sharedId });
      continue;
    }

    const { geometryId, isReused } = resolveGeometryId(info);
    idByGeometry.set(geometry, geometryId);
    if (isReused) {
      // Re-import: keep using the registered geometry (with the new info, eg. now with texture
      // slots), the freshly parsed one is disposed
      const reusedInfo = { ...info, geometryId };
      const reused = getGeometryRegistry()[geometryId].resource;
      reused.userData.importInfo = reusedInfo;
      retagAssetOwner(reused);
      geometries.push(reusedInfo);
      continue;
    }
    if (geometryId !== info.geometryId) {
      lwarn(
        `Import "${id}" (${fileName}): geometry id "${info.geometryId}" is already used by another geometry, registered as "${geometryId}" instead.`
      );
    }

    const registeredInfo = { ...info, geometryId };
    geometry.userData.importInfo = registeredInfo;
    saveBufferGeometry(geometry, {
      id: geometryId,
      isImported: true,
      isPersistent,
      debugData: {
        name: `${params.debugData?.name || id} / ${info.nodeName}`,
        ...(params.debugData?.description ? { description: params.debugData.description } : {}),
      },
    });
    keepGeometries.add(geometry);
    geometries.push(registeredInfo);
    if (lodChain) {
      prebuiltLodChains.push({ geometryId, chain: lodChain });
      for (const level of lodChain.levels) keepGeometries.add(level.geometry);
    }
  }
  loaded.disposeLeftovers(keepGeometries);
  if (prebuiltLodChains.length) await registerPrebuiltLodChains(id, prebuiltLodChains);

  const manifest: ImportedAssetManifest = {
    id,
    fileName,
    geometries,
    textureIds: textures?.textureIds || [],
  };
  imports[id] = {
    manifest,
    isPersistent: Boolean(isPersistent),
    hasTextures: Boolean(textures),
    sourceKey,
  };
  recordAssetOwner(imports[id]);
  recordAssetLoadReport(`import:${id}`, { ...report, sourceUrl: url });
  logWarnings(manifest);
  return manifest;
};

/** importAssetAsync without the LOD chain request: a cached, shared or fresh import. */
const resolveImport = async (params: ImportAssetParams): Promise<ImportedAssetManifest | null> => {
  const id = params.id || getDefaultImportId(params.fileName || '');

  const sourceKey = getSourceKey(params);
  const pending = pendingImports.get(id);
  const record = imports[id];
  const usedSourceKey = pending?.sourceKey ?? record?.sourceKey;
  if (usedSourceKey !== undefined && usedSourceKey !== sourceKey) {
    const message = `Import id "${id}" is already used for another source (fileName/meshIndex).`;
    lerror(`Could not import "${params.fileName}": ${message}`);
    if (params.throwOnError) throw new Error(message);
    return null;
  }
  if (pending) {
    const result = await pending.promise;
    if (!params.importTextures || imports[id]?.hasTextures) {
      if (imports[id]) retagImportOwner(imports[id]);
      return result;
    }
    // The pending import had no textures: re-import below (its geometries are reused)
  } else if (
    record &&
    isManifestValid(record.manifest) &&
    (!params.importTextures || record.hasTextures)
  ) {
    retagImportOwner(record);
    return record.manifest;
  }
  if (pendingImports.has(id)) return resolveImport(params);

  const promise = runImport(params, id, sourceKey).finally(() => pendingImports.delete(id));
  pendingImports.set(id, { promise, sourceKey });
  return promise;
};

/**
 * Imports the assets of a .glb/.gltf file: registers one geometry per mesh primitive in the
 * geometry registry (as `${id}/${nodeName}`, with `userData.importInfo`) and, with importTextures,
 * the textures of their glTF material slots. Returns a manifest describing them (node transforms,
 * parsed Blender custom props, texture slots). Creates no entities and imports no glTF materials.
 *
 * A repeated call with the same id returns the cached manifest while all of its geometries are
 * still registered (re-imports otherwise), and parallel calls share one import.
 *
 * With `lodChain`, the rendered geometries that have no LOD chain get one after the import (also
 * when the manifest was cached), without delaying it.
 * @param params {@link ImportAssetParams}
 * @returns Promise<{@link ImportedAssetManifest} | null> (null on error, unless throwOnError)
 */
export const importAssetAsync = async (
  params: ImportAssetParams
): Promise<ImportedAssetManifest | null> => {
  const manifest = await resolveImport(params);
  if (manifest && params.lodChain) requestLodChains(manifest, params.lodChain);
  return manifest;
};

/**
 * Returns an import's manifest, if it has been imported (and not released).
 * @param id import id
 */
export const getImportedAsset = (id: string): ImportedAssetManifest | undefined =>
  imports[id]?.manifest;

/**
 * Re-tags an import (and its geometries and textures) to the scene being loaded, for a scene that
 * references it by id instead of importing it. See AssetOwners.
 * @param id import id
 */
export const retagImportedAsset = (id: string) => {
  if (imports[id]) retagImportOwner(imports[id]);
};

/**
 * Drops the manifests of the non-persistent imports a scene owns (see AssetOwners). Their
 * geometries and textures are left to releaseSceneOwnedAssets, which releases them by owner.
 * @param sceneId owner scene id
 * @returns the released import ids
 */
export const releaseImportsOwnedBy = (sceneId: string) => {
  const released: string[] = [];
  for (const [id, record] of Object.entries(imports)) {
    if (record.isPersistent || getAssetOwner(record) !== sceneId) continue;
    delete imports[id];
    released.push(id);
  }
  return released;
};

/**
 * Releases an import: deletes its registered geometries that are not in use (ref count 0) and its
 * textures that no registered material uses, all unless persistent, and drops the manifest.
 * Assets still in use stay registered (and a later re-import reuses them). A persistent import is skipped unless
 * `includePersistent` is set.
 * @param id import id
 * @param opts.includePersistent also release a persistent import (and its persistent geometries)
 */
export const releaseImportedAsset = (id: string, opts?: { includePersistent?: boolean }) => {
  const record = imports[id];
  if (!record) return;
  if (record.isPersistent && !opts?.includePersistent) return;

  const registry = getGeometryRegistry();
  for (const info of record.manifest.geometries) {
    const entry = registry[info.geometryId];
    if (!entry || getImportInfo(info.geometryId)?.importId !== id) continue;
    if (entry.count > 0) continue;
    if (entry.persistent && !opts?.includePersistent) continue;
    deleteGeometry(info.geometryId);
  }

  const textureRegistry = getTextureRegistry();
  for (const textureId of record.manifest.textureIds) {
    const entry = textureRegistry[textureId];
    if (!entry || entry.resource.userData.importId !== id) continue;
    if (entry.persistent && !opts?.includePersistent) continue;
    if (isTextureUsedByAnyMaterial(entry.resource)) continue;
    deleteTexture(textureId);
  }
  delete imports[id];
};
