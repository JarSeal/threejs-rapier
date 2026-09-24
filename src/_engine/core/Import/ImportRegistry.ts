import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../../utils/Logger';
import { deleteGeometry, doesGeoExist, getGeometryRegistry, saveBufferGeometry } from '../Geometry';
import { isTextureUsedByAnyMaterial } from '../Material';
import { deleteTexture, doesTextureExist, getTextureRegistry } from '../Texture';
import { loadGLTFInWorker, recordAssetLoadReport, runAssetTask } from '../Assets/AssetsAPI';
import type { AssetLoadReport } from '../Assets/AssetsAPITypes';
import { recordAssetOwner, retagAssetOwner } from '../Assets/AssetOwners';
import { getDracoWorkerSettings } from './DracoDecoder';
import { deserializeGeometry } from './GeometryTransfer';
import { disposeGLTFLeftovers, extractPrimitives } from './GLTFExtract';
import { loadGLTF, toAbsoluteUrl, validateGLTFFileName } from './GLTFSource';
import { collectGLTFTextures } from './GLTFTextureCollect';
import { registerGLTFTextures, type RegisteredGLTFTextures } from './GLTFTextures';
import { deserializeTexture } from './TextureTransfer';
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

const LOAD_ERROR_MESSAGE = 'loading or parsing the file failed.';

/** The "load + extract" stage of an import: the only part that differs by thread. */
type LoadOutcome =
  | {
      primitives: { geometry: THREE.BufferGeometry; info: ImportedGeometryInfo }[];
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

const loadOnMainThread = async (params: ImportAssetParams, id: string): Promise<LoadOutcome> => {
  const { fileName, meshIndex, importTextures } = params;
  let gltf;
  try {
    gltf = await loadGLTF(fileName);
  } catch (err) {
    return { error: LOAD_ERROR_MESSAGE, cause: err };
  }

  const extracted = extractPrimitives(gltf, { importId: id, meshIndex });
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
const loadInWorker = async (params: ImportAssetParams, id: string): Promise<LoadOutcome> => {
  const response = await loadGLTFInWorker(toAbsoluteUrl(params.fileName), {
    importId: id,
    meshIndex: params.meshIndex,
    importTextures: Boolean(params.importTextures),
    draco: getDracoWorkerSettings(),
  });
  if (response.error !== undefined) return { error: response.error };

  const geometries = response.geometries.map(deserializeGeometry);
  const primitives = response.primitives.map(({ geometryIndex, info }) => ({
    geometry: geometries[geometryIndex],
    info,
  }));

  // One source per image: textures sharing an image share its source, as GLTFLoader's clones do
  const sources = response.images.map((image) => new THREE.Source(image));
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
      const keptSources = new Set<THREE.Source<unknown>>();
      textures?.keep.forEach((texture) => keptSources.add(texture.source));
      for (const texture of rebuiltTextures) {
        if (textures?.keep.has(texture)) continue;
        texture.dispose();
        if (!keptSources.has(texture.source)) (texture.source.data as ImageBitmap).close();
      }
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

  let loaded: LoadOutcome;
  let report: AssetLoadReport;
  try {
    ({ result: loaded, report } = await runAssetTask(
      'GLTF',
      () => loadInWorker(params, id),
      () => loadOnMainThread(params, id)
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
  for (let i = 0; i < primitives.length; i++) {
    const { geometry } = primitives[i];
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
  }
  loaded.disposeLeftovers(keepGeometries);

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
  recordAssetLoadReport(`import:${id}`, report);
  logWarnings(manifest);
  return manifest;
};

/**
 * Imports the assets of a .glb/.gltf file: registers one geometry per mesh primitive in the
 * geometry registry (as `${id}/${nodeName}`, with `userData.importInfo`) and, with importTextures,
 * the textures of their glTF material slots. Returns a manifest describing them (node transforms,
 * parsed Blender custom props, texture slots). Creates no entities and imports no glTF materials.
 *
 * A repeated call with the same id returns the cached manifest while all of its geometries are
 * still registered (re-imports otherwise), and parallel calls share one import.
 * @param params {@link ImportAssetParams}
 * @returns Promise<{@link ImportedAssetManifest} | null> (null on error, unless throwOnError)
 */
export const importAssetAsync = async (
  params: ImportAssetParams
): Promise<ImportedAssetManifest | null> => {
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
  if (pendingImports.has(id)) return importAssetAsync(params);

  const promise = runImport(params, id, sourceKey).finally(() => pendingImports.delete(id));
  pendingImports.set(id, { promise, sourceKey });
  return promise;
};

/**
 * Returns an import's manifest, if it has been imported (and not released).
 * @param id import id
 */
export const getImportedAsset = (id: string): ImportedAssetManifest | undefined =>
  imports[id]?.manifest;

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
