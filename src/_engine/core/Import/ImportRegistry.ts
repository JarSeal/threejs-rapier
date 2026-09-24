import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../../utils/Logger';
import { deleteGeometry, doesGeoExist, getGeometryRegistry, saveBufferGeometry } from '../Geometry';
import { isTextureUsedByAnyMaterial } from '../Material';
import { deleteTexture, doesTextureExist, getTextureRegistry } from '../Texture';
import { disposeGLTFLeftovers, extractPrimitives } from './GLTFExtract';
import { loadGLTF, validateGLTFFileName } from './GLTFSource';
import { registerGLTFTextures } from './GLTFTextures';
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

const logWarnings = (manifest: ImportedAssetManifest) => {
  for (const info of manifest.geometries) {
    for (const warning of info.customProps.warnings) {
      lwarn(`Import "${manifest.id}" (${manifest.fileName}), node "${info.nodeName}": ${warning}`);
    }
  }
};

const runImport = async (
  params: ImportAssetParams,
  id: string,
  sourceKey: string
): Promise<ImportedAssetManifest | null> => {
  const { fileName, meshIndex, isPersistent, importTextures } = params;
  const fail = (message: string, err?: unknown) => {
    lerror(`Could not import "${fileName}" (import id "${id}"): ${message}`, ...(err ? [err] : []));
    if (params.throwOnError) throw new Error(`Error while importing "${fileName}": ${message}`);
    return null;
  };

  const fileNameError = validateGLTFFileName(fileName);
  if (fileNameError) return fail(fileNameError);

  let gltf;
  try {
    gltf = await loadGLTF(fileName);
  } catch (err) {
    return fail('loading or parsing the file failed.', err);
  }

  const extracted = extractPrimitives(gltf, { importId: id, meshIndex });
  if (extracted.error !== undefined) {
    disposeGLTFLeftovers(gltf, {});
    return fail(extracted.error);
  }

  const textures = importTextures
    ? registerGLTFTextures(gltf, extracted.primitives, {
        importId: id,
        importName: params.debugData?.name || id,
        fileName,
        texOpts: typeof importTextures === 'object' ? importTextures.texOpts : undefined,
        isPersistent:
          (typeof importTextures === 'object' ? importTextures.isPersistent : undefined) ??
          isPersistent,
      })
    : null;

  const keepGeometries = new Set<THREE.BufferGeometry>();
  /** Nodes sharing one glTF mesh share one BufferGeometry: register it once. */
  const idByGeometry = new Map<THREE.BufferGeometry, string>();
  const geometries: ImportedGeometryInfo[] = [];
  for (let i = 0; i < extracted.primitives.length; i++) {
    const { geometry } = extracted.primitives[i];
    const info = textures
      ? { ...extracted.primitives[i].info, textureSlots: textures.slotsPerPrimitive[i] }
      : extracted.primitives[i].info;
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
      getGeometryRegistry()[geometryId].resource.userData.importInfo = reusedInfo;
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
  disposeGLTFLeftovers(gltf, { geometries: keepGeometries, textures: textures?.keep });

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
    if (!params.importTextures || imports[id]?.hasTextures) return result;
    // The pending import had no textures: re-import below (its geometries are reused)
  } else if (
    record &&
    isManifestValid(record.manifest) &&
    (!params.importTextures || record.hasTextures)
  ) {
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
