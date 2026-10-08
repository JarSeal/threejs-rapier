import type * as THREE from 'three/webgpu';
import { addDebugToast } from '../../../debug/DebuggerGUI';
import {
  DevFilesError,
  encodePNG,
  getDevFilesStatus,
  onDevDataGathered,
  readDevFile,
  writeDevFiles,
  type DevDataGatheredEvent,
  type DevFilesCommitBody,
  type DevFileWrite,
} from '../../../debug/DevFiles';
import type { ImpostorAsset } from '../../../schemas/impostorSchema';
import { lerror, lwarn } from '../../../utils/Logger';
import { getConfig } from '../../Config';
import {
  IMPOSTOR_EXPORT_FORMAT_VERSION,
  type ImpostorKind,
} from '../../Lod/Impostors/ImpostorFormat';
import { getImpostorRecord, type ImpostorRecord } from '../../Lod/Impostors/ImpostorRegistry';
import { getImpostorSourceHash } from '../../Lod/Impostors/ImpostorSourceHash';
import {
  bakeOctahedralImpostorAtlases,
  resolveOctahedralImpostorOptions,
} from '../../Lod/Impostors/OctahedralImpostor';
import { bakeCrossQuadsAtlases, resolveCrossQuadsOptions } from '../../Lod/Impostors/CrossQuads';
import { getGeneratedAppData } from '../../Scene';
import { readRenderTargetImageAsync } from '../_dbg__TexturePreview';

// The impostor export (docs/plans/p351_impostor-billboard-lod.md Phase 4 section 3): bakes an
// impostor again from the source its generator got (the registry keeps it), reads the atlases
// back and writes them into the repo through the dev files (_DONE_p342): one PNG per atlas slot,
// a `*.textureAtlas.json` (p299, `image` slots, `mipChain: "FULL"`) and the `*.impostor.json`.
// The gather that follows encodes the atlases as KTX2 (p300). Without the dev files (a LAN device
// without AEK_DEV_FILES_LAN, AEK_DEV_FILES=false, a build) the files are downloaded instead, with
// the repo paths to put them at. Both kinds export (octahedral: albedo and normalDepth slots;
// cross-quads, section 6: albedo, and normal when baked with normals).

/** Where an impostor stands against the export the generated data has of it */
export type ImpostorExportState =
  /** The record has no source (it's kept in the debug env and prod test mode only) */
  | 'NO_SOURCE'
  | 'NOT_EXPORTED'
  /** Exported, from the same source and options, in this format */
  | 'EXPORTED'
  /** Exported from another source or other options: re-export it */
  | 'STALE'
  /** Exported in another format version: re-export it */
  | 'OTHER_FORMAT';

const KINDS_EXPORTED: readonly ImpostorKind[] = ['OCTAHEDRAL', 'CROSS_QUADS'];

/** Block compression works on 4 × 4 texels: an atlas cell's side must be a multiple of 4 */
const BLOCK_SIZE = 4;

const NOTE_KEY = 'AEK_debugImpostorExportNote';

type GeneratedDevData = {
  impostors?: Record<string, ImpostorAsset | undefined>;
  textures?: Record<string, { __sourcePath?: string; __atlas?: unknown } | undefined>;
};

const getDevData = () => getGeneratedAppData() as unknown as GeneratedDevData;

/** The gathered `*.impostor.json` of `id` (dev data only: a production gather keeps only scenes) */
const getGatheredImpostor = (id: string) => getDevData().impostors?.[id];

/** The settings an export writes (and fingerprints), resolved from the record's source */
const resolveSettings = (record: ImpostorRecord) => {
  if (!record.source) return null;
  const { geometry, material, options } = record.source;
  return record.kind === 'OCTAHEDRAL'
    ? resolveOctahedralImpostorOptions(geometry, material, options)
    : resolveCrossQuadsOptions(geometry, material, options);
};

/** Fingerprints by record: a record is replaced, never changed, when its impostor is generated
 * again, and hashing a heavy source takes a while (0.75 ms for 16k triangles) */
const sourceHashes = new WeakMap<ImpostorRecord, string>();

const getSourceHash = (record: ImpostorRecord) => {
  const cached = sourceHashes.get(record);
  if (cached) return cached;
  const settings = resolveSettings(record);
  if (!record.source || !settings) return null;
  const hash = getImpostorSourceHash(record.source.geometry, record.source.material, settings);
  sourceHashes.set(record, hash);
  return hash;
};

/** Whether `record` can be exported, and how it stands against its export (see
 * {@link ImpostorExportState}) */
export const getImpostorExportState = (record: ImpostorRecord): ImpostorExportState => {
  if (!record.source) return 'NO_SOURCE';
  const gathered = getGatheredImpostor(record.id);
  if (!gathered || gathered.kind !== record.kind) return 'NOT_EXPORTED';
  if (gathered.formatVersion !== IMPOSTOR_EXPORT_FORMAT_VERSION) return 'OTHER_FORMAT';
  return gathered.sourceHash === getSourceHash(record) ? 'EXPORTED' : 'STALE';
};

export const isImpostorKindExported = (kind: ImpostorKind) => KINDS_EXPORTED.includes(kind);

const toRepoPath = (path: string) => path.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
const getDir = (path: string) => path.slice(0, path.lastIndexOf('/'));
const getBaseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** `$schema` from a file in `dir` (repo-relative) */
const getSchemaRef = (dir: string, schema: string) =>
  `${'../'.repeat(dir.split('/').length)}.schemas/${schema}.schema.json`;

/**
 * Where `id`'s files go: where its gathered `*.impostor.json` and atlas are (a re-export
 * overwrites them, wherever they were moved), else into `AppConfig.lod.impostorExportDir`. The
 * atlas id is the impostor's, so its slots are the textures the runtime bake registers
 * (`${id}.albedo`, `${id}.normalDepth`). The PNGs go next to the atlas JSON.
 */
const getExportPaths = (id: string) => {
  const data = getDevData();
  const gathered = data.impostors?.[id];
  const dir = toRepoPath(getConfig().lod?.impostorExportDir || 'src/app/impostors');
  const impostor = gathered?.__sourcePath
    ? toRepoPath(gathered.__sourcePath)
    : `${dir}/${id}.impostor.json`;
  const atlasId = gathered?.atlas ?? id;
  const slotTexture = data.textures?.[`${atlasId}.albedo`];
  const atlas =
    slotTexture?.__atlas && slotTexture.__sourcePath
      ? toRepoPath(slotTexture.__sourcePath)
      : `${getDir(impostor)}/${atlasId}.textureAtlas.json`;
  return {
    atlasId,
    impostor,
    atlas,
    /** A slot's PNG: its repo path and the atlas JSON's `image` (relative to it) */
    getImage: (slot: string) => {
      const fileName = `${atlasId}.${slot}.png`;
      return { path: `${getDir(atlas)}/${fileName}`, ref: `./${fileName}` };
    },
  };
};

const DEBUG_DESCRIPTION =
  "Written by the LOD tab's impostor Export (docs/plans/p351_impostor-billboard-lod.md Phase 4): re-export the impostor instead of editing this file.";

/** One impostor's files, ready to write */
type ImpostorExportFiles = {
  id: string;
  paths: ReturnType<typeof getExportPaths>;
  /** The atlas slots written, one PNG each */
  slots: string[];
  images: { path: string; blob: Blob }[];
  atlasJson: Record<string, unknown>;
  impostorJson: Record<string, unknown>;
};

/** The shading as the JSON has it: a colour as a hex string */
const toJsonShading = (shading: { type: string; params: Record<string, unknown> }) => ({
  type: shading.type,
  params: Object.fromEntries(
    Object.entries(shading.params).map(([key, value]) => [
      key,
      (value as THREE.Color | undefined)?.isColor
        ? `#${(value as THREE.Color).getHexString()}`
        : value,
    ])
  ),
});

/** Reads each slot's atlas target back into a PNG at its export path, then disposes the targets
 * (all of them, also on a failure) */
const readAtlasImages = async (
  targets: Record<string, THREE.RenderTarget>,
  paths: ReturnType<typeof getExportPaths>
): Promise<ImpostorExportFiles['images']> => {
  try {
    return await Promise.all(
      Object.entries(targets).map(async ([slot, target]) => ({
        path: paths.getImage(slot).path,
        blob: await encodePNG(await readRenderTargetImageAsync(target)),
      }))
    );
  } finally {
    for (const target of Object.values(targets)) target.dispose();
  }
};

/** Bakes `record` again from its source and builds its files. */
const buildOctahedralExport = async (record: ImpostorRecord): Promise<ImpostorExportFiles> => {
  if (record.kind !== 'OCTAHEDRAL' || !record.source) {
    throw new Error(`'${record.id}' isn't an octahedral impostor with a source.`);
  }
  const { geometry, material, options } = record.source;
  const settings = resolveOctahedralImpostorOptions(geometry, material, options);
  const { frames, frameSize, gutter } = settings;
  const cellSize = frameSize + 2 * gutter;
  if (cellSize % BLOCK_SIZE) {
    throw new Error(
      `'${record.id}': a cell is ${cellSize} texels (frameSize ${frameSize} + 2 × gutter ${gutter}), not a multiple of ${BLOCK_SIZE}, which a compressed atlas needs. Change frameSize or gutter.`
    );
  }
  const paths = getExportPaths(record.id);
  const atlases = bakeOctahedralImpostorAtlases(geometry, material, settings, record.id);
  const { layout } = atlases;
  const images = await readAtlasImages(
    { albedo: atlases.albedo, normalDepth: atlases.normalDepth },
    paths
  );

  const cells: { id: string; rect: [number, number, number, number] }[] = [];
  for (let j = 0; j < frames; j++) {
    for (let i = 0; i < frames; i++) {
      cells.push({ id: `f${i}_${j}`, rect: [i * cellSize, j * cellSize, cellSize, cellSize] });
    }
  }
  const atlasJson = {
    $schema: getSchemaRef(getDir(paths.atlas), 'textureAtlas'),
    id: paths.atlasId,
    size: [layout.atlasSize, layout.atlasSize],
    padding: gutter,
    // The bake composed and dilated the whole atlas, and neighbouring cells are neighbouring
    // views: every level, down to 1 × 1 (decisions 1 and 2)
    mipChain: 'FULL',
    slots: {
      albedo: {
        texOpts: { colorSpace: 'srgb' },
        image: paths.getImage('albedo').ref,
        optimize: { slot: 'baseColor' },
      },
      // The object-space normal and the depth: data, compressed without RDO (decision 3)
      normalDepth: {
        image: paths.getImage('normalDepth').ref,
        optimize: { slot: 'data', textures: { data: { codec: 'uastc', rdo: 0 } } },
      },
    },
    cells,
    debugData: { name: `${record.id} (impostor atlas)`, description: DEBUG_DESCRIPTION },
  };
  const impostorJson = {
    $schema: getSchemaRef(getDir(paths.impostor), 'impostor'),
    id: record.id,
    kind: 'OCTAHEDRAL',
    atlas: paths.atlasId,
    formatVersion: IMPOSTOR_EXPORT_FORMAT_VERSION,
    sourceHash: getSourceHash(record),
    alphaTest: settings.alphaTest,
    shading: toJsonShading(settings.shading),
    layout,
    surfaceDepth: settings.surfaceDepth,
    debugData: { name: `${record.id} (impostor)`, description: DEBUG_DESCRIPTION },
  };
  const slots = ['albedo', 'normalDepth'];
  return { id: record.id, paths, slots, images, atlasJson, impostorJson };
};

/** Bakes `record` again from its source and builds its files: one cell per plane, side by side.
 * The bake sizes cells to whole compression blocks itself. */
const buildCrossQuadsExport = async (record: ImpostorRecord): Promise<ImpostorExportFiles> => {
  if (record.kind !== 'CROSS_QUADS' || !record.source) {
    throw new Error(`'${record.id}' isn't a cross-quad impostor with a source.`);
  }
  const { geometry, material, options } = record.source;
  const settings = resolveCrossQuadsOptions(geometry, material, options);
  const paths = getExportPaths(record.id);
  const atlases = bakeCrossQuadsAtlases(geometry, material, settings, record.id);
  const { layout } = atlases;
  const images = await readAtlasImages(
    atlases.normal
      ? { albedo: atlases.albedo, normal: atlases.normal }
      : { albedo: atlases.albedo },
    paths
  );

  const cellWidth = layout.frameWidth + 2 * layout.gutter;
  const cells = Array.from({ length: layout.planes }, (_, i) => ({
    id: `p${i}`,
    rect: [i * cellWidth, 0, cellWidth, layout.atlasSize[1]] as [number, number, number, number],
  }));
  const atlasJson = {
    $schema: getSchemaRef(getDir(paths.atlas), 'textureAtlas'),
    id: paths.atlasId,
    size: layout.atlasSize,
    padding: layout.gutter,
    // As the runtime bake's mipmaps: every level, the planes' cells mixing past the gutter
    mipChain: 'FULL',
    slots: {
      albedo: {
        texOpts: { colorSpace: 'srgb' },
        image: paths.getImage('albedo').ref,
        optimize: { slot: 'baseColor' },
      },
      // The normal in each plane's own frame: a normal map, resized as unit vectors (decision 3)
      ...(atlases.normal && {
        normal: { image: paths.getImage('normal').ref, optimize: { slot: 'normal' } },
      }),
    },
    cells,
    debugData: { name: `${record.id} (impostor atlas)`, description: DEBUG_DESCRIPTION },
  };
  const impostorJson = {
    $schema: getSchemaRef(getDir(paths.impostor), 'impostor'),
    id: record.id,
    kind: 'CROSS_QUADS',
    atlas: paths.atlasId,
    formatVersion: IMPOSTOR_EXPORT_FORMAT_VERSION,
    sourceHash: getSourceHash(record),
    alphaTest: settings.alphaTest,
    shading: toJsonShading(settings.shading),
    layout,
    normals: settings.normals,
    debugData: { name: `${record.id} (impostor)`, description: DEBUG_DESCRIPTION },
  };
  const slots = settings.normals ? ['albedo', 'normal'] : ['albedo'];
  return { id: record.id, paths, slots, images, atlasJson, impostorJson };
};

const buildExport = async (id: string) => {
  const record = getImpostorRecord(id);
  if (!record) throw new Error(`'${id}' isn't a generated impostor (any more).`);
  if (!record.source) {
    throw new Error(`'${id}' has no source to bake from (kept in the debug env only).`);
  }
  if (!isImpostorKindExported(record.kind)) {
    throw new Error(`'${id}': ${record.kind} impostors can't be exported yet.`);
  }
  return record.kind === 'OCTAHEDRAL'
    ? buildOctahedralExport(record)
    : buildCrossQuadsExport(record);
};

/** Shows `note` as a toast, and again after the page reloads (a gather reloads it) */
const showNote = (
  note: { type: 'info' | 'warning' | 'alert'; title: string; message: string },
  survivesReload: boolean
) => {
  addDebugToast({ ...note, showingTime: note.type === 'info' ? 6000 : 15000 });
  if (!survivesReload) return;
  try {
    sessionStorage.setItem(NOTE_KEY, JSON.stringify(note));
  } catch {
    // Without storage the note just doesn't outlive the reload
  }
};

/** The note an export left before the reload, shown once the debug toaster exists */
const showPendingNote = (triesLeft = 40) => {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(NOTE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let note: { type: 'info' | 'warning' | 'alert'; title: string; message: string };
  try {
    note = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(NOTE_KEY);
    return;
  }
  if (addDebugToast({ ...note, showingTime: note.type === 'info' ? 6000 : 15000 })) {
    sessionStorage.removeItem(NOTE_KEY);
  } else if (triesLeft > 0) {
    setTimeout(() => showPendingNote(triesLeft - 1), 250);
  }
};
showPendingNote();

/** The note for the gather a write set off, or null when the event is another gather's */
const getGatherNote = (event: DevDataGatheredEvent, exports: ImpostorExportFiles[]) => {
  const written = new Set(
    exports.flatMap((e) => [e.paths.atlas, e.paths.impostor, ...e.images.map((i) => i.path)])
  );
  if (!event.files.some((file) => written.has(toRepoPath(file)))) return null;
  const ids = exports.map((e) => e.id).join(', ');
  if (event.status === 'failed') {
    return {
      type: 'alert' as const,
      title: `Impostor export: the gather failed`,
      message: `${ids}: ${event.message ?? 'see the error overlay'}. The files are written; fix them or re-export.`,
    };
  }
  const slotIds = new Set(
    exports.flatMap((e) => e.slots.map((slot) => `${e.paths.atlasId}.${slot}`))
  );
  const errors = event.assetErrors.filter((error) => slotIds.has(error.id));
  if (errors.length) {
    return {
      type: 'warning' as const,
      title: 'Impostor export: an atlas failed to encode',
      message: errors.map(({ id, reason }) => `${id}: ${reason}`).join('\n'),
    };
  }
  return {
    type: 'info' as const,
    title: 'Impostors exported',
    message: `${ids}: written and encoded.`,
  };
};

const downloadBlob = (fileName: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const toJsonBlob = (json: unknown) =>
  new Blob([`${JSON.stringify(json, null, 2)}\n`], { type: 'application/json' });

/** Downloads every file, and lists where each one goes */
const downloadExports = (exports: ImpostorExportFiles[], reason: string) => {
  const files = exports.flatMap((e) => [
    ...e.images,
    { path: e.paths.atlas, blob: toJsonBlob(e.atlasJson) },
    { path: e.paths.impostor, blob: toJsonBlob(e.impostorJson) },
  ]);
  for (const { path, blob } of files) downloadBlob(getBaseName(path), blob);
  const list = files.map(({ path }) => path).join('\n');
  lwarn(`Impostor export (${reason}): downloaded ${files.length} files. Put them at:\n${list}`);
  showNote(
    {
      type: 'warning',
      title: `Impostor export downloaded (${reason})`,
      message: `Put the ${files.length} files at (also in the console; allow multiple downloads if the browser asks):\n${list}`,
    },
    false
  );
};

const writeExports = async (exports: ImpostorExportFiles[]) => {
  // A re-export expects the JSONs as it read them, a first export none there
  const writes: DevFileWrite[] = [];
  for (const e of exports) {
    const [atlasFile, impostorFile] = await Promise.all([
      readDevFile(e.paths.atlas),
      readDevFile(e.paths.impostor),
    ]);
    writes.push(
      ...e.images.map(({ path, blob }) => ({ path, blob })),
      { path: e.paths.atlas, json: e.atlasJson, expectedHash: atlasFile?.sha256 ?? null },
      { path: e.paths.impostor, json: e.impostorJson, expectedHash: impostorFile?.sha256 ?? null }
    );
  }

  // Listening before the write: the gather can be quick
  let removeListener: (() => void) | null = onDevDataGathered((event) => {
    const note = getGatherNote(event, exports);
    if (!note) return;
    removeListener?.();
    removeListener = null;
    showNote(note, event.willReload);
  });
  let result: DevFilesCommitBody;
  try {
    result = await writeDevFiles(writes);
  } catch (err) {
    removeListener?.();
    throw err;
  }
  if (result.results.every(({ status }) => status === 'unchanged')) {
    // Nothing written, so no gather follows
    removeListener?.();
    showNote(
      {
        type: 'info',
        title: 'Impostor export unchanged',
        message: `${exports.map((e) => e.id).join(', ')}: the files are as they were.`,
      },
      false
    );
    return;
  }
  const written = result.results.filter(({ status }) => status !== 'unchanged').length;
  addDebugToast({
    title: 'Impostor export written',
    message: `${written} of ${result.results.length} files; the gather encodes the atlases, then the page reloads.`,
  });
};

let isExporting = false;

/** Whether an export is running (one at a time) */
export const isImpostorExportRunning = () => isExporting;

/**
 * Exports the impostors `ids` in one dev files batch (see the module comment), or downloads their
 * files when the dev files are unavailable. Reports through toasts; never rejects.
 */
export const exportImpostorsAsync = async (ids: string[]) => {
  if (isExporting || !ids.length) return;
  isExporting = true;
  try {
    const exports: ImpostorExportFiles[] = [];
    for (const id of ids) exports.push(await buildExport(id));
    const status = await getDevFilesStatus();
    if (!status.available) {
      downloadExports(exports, status.message);
      return;
    }
    await writeExports(exports);
  } catch (err) {
    const message =
      err instanceof DevFilesError && err.code === 'CONFLICT'
        ? 'A file changed on disk while exporting: export again.'
        : (err as Error).message;
    lerror(`Impostor export failed: ${message}`, err);
    showNote({ type: 'alert', title: 'Impostor export failed', message }, false);
  } finally {
    isExporting = false;
  }
};
