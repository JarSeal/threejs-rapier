import path from 'path';
import { Logger, NodeIO, type Accessor, type Document, type Texture } from '@gltf-transform/core';
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRTextureBasisu,
} from '@gltf-transform/extensions';
import {
  draco,
  listTextureSlots,
  meshopt,
  quantize,
  simplify,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import type { ResolvedLodChainOptions } from '../../src/_engine/core/Lod/LodChainOptions';
import type { TextureSlot } from '../../src/_engine/schemas/assetsConfigSchema';
import { readImageFile, resizeImage } from './images';
import type { KtxProvider } from './ktxEncode';
import { buildLodChains, type BuiltLodChain } from './lodChains';
import { getLogicalPath, writeOutput, type PipelineOutput } from './outputs';
import type { ResolvedAssetSettings, ResolvedMeshSettings } from './settings';
import type { AssetSource } from './sources';
import {
  describeEncodedTexture,
  encodeTextureImage,
  fitTextureSize,
  type EncodedTexture,
} from './textures';

/**
 * The GLB / glTF step (p300 Phase 2 step 5, §8): gltf-transform reads the source, compresses
 * the geometry (DD6) and encodes each texture with the settings of the material slot that uses
 * it, then writes a .glb. The order (geometry, then textures, then KHR_texture_basisu) is Phase
 * 1's (`phase1Variants.ts`), so the same settings reproduce its files.
 */

let ioPromise: Promise<NodeIO> | null = null;

/** One NodeIO with every extension and codec, set up once (the codecs are WASM). */
const getIO = () =>
  (ioPromise ??= (async () => {
    const draco3d = (await import('draco3dgltf')).default;
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
    const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN));
    return io.registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
  })());

/** gltf-transform's warnings go into the asset's; its info and debug lines are dropped. */
class WarningLogger extends Logger {
  constructor(private readonly onWarn: (message: string) => void) {
    super(Logger.Verbosity.WARN);
  }
  warn(text: string) {
    this.onWarn(text);
  }
}

/**
 * Vertex and index bytes as uploaded (quantized attributes stay quantized in VRAM). An accessor
 * that several primitives share (LOD levels over their base's vertices) is uploaded once.
 */
export const getGeometryBytes = (doc: Document) => {
  const accessors = new Set<Accessor>();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      if (indices) accessors.add(indices);
      for (const attribute of prim.listAttributes()) accessors.add(attribute);
    }
  }
  let bytes = 0;
  for (const accessor of accessors) bytes += accessor.getByteLength();
  return bytes;
};

const COMPRESSION_EXTENSIONS: [string, ResolvedMeshSettings['codec']][] = [
  ['EXT_meshopt_compression', 'meshopt'],
  ['KHR_draco_mesh_compression', 'draco'],
];

/**
 * Compresses the geometry (DD6):
 * - meshopt, quantized: gltf-transform's `meshopt()` (reorder, quantize, filters). Texcoords are
 *   quantized only inside [0, 1], as normalized integers (no KHR_texture_transform).
 * - meshopt, `quantize: false`: lossless, EXT_meshopt_compression alone (no reorder, no
 *   quantization, no filters: `QUANTIZE` means "no filters"), the collider default.
 * - draco: always quantized.
 * - none: `quantize()` alone (KHR_mesh_quantization), or the geometry as it is.
 * `simplify` (a triangle ratio) welds and simplifies first.
 */
const compressGeometry = async (
  doc: Document,
  mesh: ResolvedMeshSettings,
  warn: (message: string) => void
) => {
  // A compressed source keeps its extension when read: only the chosen codec's may stay
  for (const extension of doc.getRoot().listExtensionsUsed()) {
    const { extensionName } = extension;
    if (extensionName === 'KHR_mesh_quantization' && !mesh.quantize) {
      warn(
        'the source is already quantized (KHR_mesh_quantization), which "quantize: false" keeps'
      );
    }
    const codec = COMPRESSION_EXTENSIONS.find(([name]) => name === extensionName)?.[1];
    if (codec && codec !== mesh.codec) extension.dispose();
  }
  if (mesh.simplify) {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: mesh.simplify }));
  }
  if (mesh.codec === 'meshopt') {
    if (mesh.quantize) {
      await doc.transform(meshopt({ encoder: MeshoptEncoder }));
    } else {
      doc
        .createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    }
  } else if (mesh.codec === 'draco') {
    if (!mesh.quantize) {
      warn('Draco always quantizes, so "quantize: false" has no effect: use meshopt for lossless');
    }
    await doc.transform(draco());
  } else if (mesh.quantize) {
    await doc.transform(quantize());
  }
};

const GLTF_SLOTS: Record<string, TextureSlot> = {
  baseColorTexture: 'baseColor',
  normalTexture: 'normal',
  metallicRoughnessTexture: 'metallicRoughness',
  occlusionTexture: 'occlusion',
  emissiveTexture: 'emissive',
};

/** glTF's colour textures (sRGB, core and extensions); every other slot holds linear data */
const SRGB_GLTF_SLOTS = [
  'baseColorTexture',
  'emissiveTexture',
  'sheenColorTexture',
  'specularColorTexture',
  'diffuseTexture',
  'specularGlossinessTexture',
];

/**
 * A texture's slot (§4: classified by the material slots that reference it) and colour space.
 * A normal map is `normal` (also an extension's, eg. clearcoatNormalTexture); occlusion together
 * with metallicRoughness is `orm`; any other mix, an extension slot, or no use is `default`.
 */
const classifyTexture = (texture: Texture, warn: (message: string) => void) => {
  const gltfSlots = listTextureSlots(texture);
  const srgbSlots = gltfSlots.filter((slot) => SRGB_GLTF_SLOTS.includes(slot));
  const isSrgb = srgbSlots.length > 0;
  const isNormal = gltfSlots.some((slot) => /normalTexture$/i.test(slot));
  if (isSrgb && srgbSlots.length < gltfSlots.length) {
    warn(
      `is used as colour and as data (${gltfSlots.join(', ')}): encoded as ${isNormal ? 'a linear normal map' : 'sRGB colour'}`
    );
  }
  let slot: TextureSlot = 'default';
  if (isNormal) {
    slot = 'normal';
  } else if (
    gltfSlots.includes('occlusionTexture') &&
    gltfSlots.includes('metallicRoughnessTexture')
  ) {
    slot = 'orm';
  } else {
    const known = [...new Set(gltfSlots.map((name) => GLTF_SLOTS[name]))];
    if (known.length === 1 && known[0]) slot = known[0];
  }
  return { slot, isSrgb: isSrgb && !isNormal, isNormal };
};

/** Image formats sharp can't decode stay as they are */
const KEEP_MIME_TYPES = ['image/ktx2'];

/** An image format's extension is dropped when no texture of its format is left */
const IMAGE_FORMAT_EXTENSIONS: [string, string][] = [
  ['KHR_texture_basisu', 'image/ktx2'],
  ['EXT_texture_webp', 'image/webp'],
  ['EXT_texture_avif', 'image/avif'],
];

const dropUnusedImageFormats = (doc: Document) => {
  const root = doc.getRoot();
  for (const [name, mimeType] of IMAGE_FORMAT_EXTENSIONS) {
    if (root.listTextures().some((texture) => texture.getMimeType() === mimeType)) continue;
    root
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === name)
      ?.dispose();
  }
};

/**
 * Without `importTextures` the runtime registers none of a file's textures (ImportRegistry.ts),
 * but GLTFLoader would still download and decode them: they are dropped, not encoded. The
 * materials stay (the importer discards them anyway), without their texture references.
 * Returns how many were dropped.
 */
const dropTextures = (doc: Document) => {
  const textures = doc.getRoot().listTextures();
  for (const texture of textures) texture.dispose();
  return textures.length;
};

const encodeTextures = async (
  doc: Document,
  textures: Exclude<ResolvedAssetSettings['textures'], false>,
  opts: { getKtx: KtxProvider; warn: (message: string) => void }
) => {
  const root = doc.getRoot();
  const encoded: EncodedTexture[] = [];
  let hasKtx2 = false;
  for (const [index, texture] of root.listTextures().entries()) {
    const image = texture.getImage();
    const label = texture.getName() || texture.getURI() || `#${index}`;
    const warn = (message: string) => opts.warn(`texture "${label}" ${message}`);
    if (!image) continue;
    if (KEEP_MIME_TYPES.includes(texture.getMimeType())) {
      warn(`is already ${texture.getMimeType()}: kept as it is`);
      continue;
    }
    const { slot, isSrgb, isNormal } = classifyTexture(texture, warn);
    const settings = textures[slot];
    const sourceImg = await readImageFile(Buffer.from(image), { isSrgb, rgbOnly: isNormal });
    const source = { width: sourceImg.width, height: sourceImg.height, bytes: image.byteLength };
    const size = fitTextureSize(sourceImg.width, sourceImg.height, settings, warn);
    if (
      settings.codec === 'none' &&
      size.width === sourceImg.width &&
      size.height === sourceImg.height
    ) {
      encoded.push(
        describeEncodedTexture(sourceImg, settings, {
          name: label,
          slot,
          bytes: source.bytes,
          source,
        })
      );
      continue;
    }
    const img = resizeImage(sourceImg, size.width, size.height, isNormal);
    const { bytes, ext } = await encodeTextureImage(img, settings, {
      isSrgb,
      isNormal,
      flip: false,
      getKtx: opts.getKtx,
    });
    const uri = texture.getURI();
    texture
      .setImage(bytes)
      .setMimeType(ext === '.ktx2' ? 'image/ktx2' : 'image/png')
      .setURI(`${path.basename(uri, path.extname(uri))}${ext}`);
    hasKtx2 ||= ext === '.ktx2';
    encoded.push(
      describeEncodedTexture(img, settings, { name: label, slot, bytes: bytes.byteLength, source })
    );
  }
  if (hasKtx2) doc.createExtension(KHRTextureBasisu).setRequired(true);
  return encoded;
};

/**
 * Optimizes a GLB / glTF source into a .glb.
 * @param settings The asset's settings, with the collider default (DD6) for a collider source
 * (`hasColliderNodes`)
 * @param opts.importTextures The runtime registers the file's textures: else they are dropped,
 * whatever the textures settings say
 * @param opts.lodChain Build LOD chains into the file (p347 Phase 3), after the geometry's
 * compression. Only with the mesh side on: a geometry kept as it is gets its chain at runtime.
 */
export const encodeGLTFAsset = async (
  source: Extract<AssetSource, { file: string }>,
  settings: ResolvedAssetSettings,
  opts: {
    importTextures: boolean;
    lodChain?: ResolvedLodChainOptions;
    getKtx: KtxProvider;
    warn: (message: string) => void;
  }
): Promise<{
  output: PipelineOutput;
  textures: EncodedTexture[];
  droppedTextures: number;
  geometryBytes: { in: number; out: number };
  lodChains?: BuiltLodChain[];
}> => {
  const io = await getIO();
  const doc = await io.read(source.file);
  doc.setLogger(new WarningLogger(opts.warn));
  const droppedTextures = opts.importTextures ? 0 : dropTextures(doc);
  const geometryIn = getGeometryBytes(doc);
  if (settings.mesh) await compressGeometry(doc, settings.mesh, opts.warn);
  let lodChains: BuiltLodChain[] | undefined;
  if (opts.lodChain && settings.mesh) {
    let { lodChain } = opts;
    if (settings.mesh.codec === 'draco' && !lodChain.compactVertices) {
      opts.warn(
        'Draco primitives share all of their accessors or none: the LOD levels get their own vertices (compactVertices)'
      );
      lodChain = { ...lodChain, compactVertices: true };
    }
    lodChains = await buildLodChains(doc, lodChain, opts.warn);
  }
  const textures =
    settings.textures && opts.importTextures
      ? await encodeTextures(doc, settings.textures, opts)
      : [];
  dropUnusedImageFormats(doc);
  const output = writeOutput(getLogicalPath(source), '.glb', await io.writeBinary(doc));
  return {
    output,
    textures,
    droppedTextures,
    geometryBytes: { in: geometryIn, out: getGeometryBytes(doc) },
    ...(lodChains?.length ? { lodChains } : {}),
  };
};
