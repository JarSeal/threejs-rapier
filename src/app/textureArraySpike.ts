import * as THREE from 'three/webgpu';
import { int, texture, uv } from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import type { Node, TextureNode } from 'three/webgpu';
import { createCameraEntity } from '../_engine/core/CameraManager';
import { saveBufferGeometry } from '../_engine/core/Geometry';
import { getKTX2Loader, loadKTX2Texture } from '../_engine/core/Import/KTX2';
import { saveMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getRenderer } from '../_engine/core/Renderer';
import { loadTextureAsync, saveTexture } from '../_engine/core/Texture';
import { llog } from '../_engine/utils/Logger';

/**
 * p299 Phase 0 spike: array textures on both backends. Files from
 * `devTools/assetPipeline/p299ArraySpike.ts`. A grid of unlit quads, columns ETC1S L0, ETC1S L1,
 * UASTC L0, UASTC L1:
 * - row 1: `ktx create --layers 2` arrays, loaded by KTX2Loader (D2's runtime side);
 * - row 2: arrays assembled at runtime from the single files s0 and s1 (D1);
 * - row 3: s0 and s1 as plain textures (the reference rows 1 and 2 must match);
 * - row 4: runtime arrays with one layer swapped through `addLayerUpdate` after the first upload
 *   (ETC1S: layer 1 → s2, so L0 red / L1 blue; UASTC: layer 0 → s3, so L0 yellow / L1 green).
 * `window.__p299Spike` holds the results and `runPerf()` (16 × 1K assembly timings).
 * Throwaway: Phase 1 replaces the assembly with `core/TextureArray.ts`.
 */

const URL_BASE = '/debugger/assets/testOptimized/p299';
/** `?p299Rgba=true`: a loader of the spike's own that transcodes to uncompressed RGBA32, as on a
 * GPU without BC, ETC2 or ASTC. */
const FORCE_RGBA = new URLSearchParams(window.location.search).get('p299Rgba') === 'true';
let rgbaLoader: Promise<{ loadAsync: (url: string) => Promise<unknown> }> | null = null;
const loadKtx = async (url: string) => {
  if (!FORCE_RGBA) return loadKTX2Texture(url);
  rgbaLoader ??= Promise.all([import('three/addons/loaders/KTX2Loader.js'), getKTX2Loader()]).then(
    ([{ KTX2Loader }, shared]) => {
      const loader = new KTX2Loader().setTranscoderPath(
        (shared as unknown as { transcoderPath: string }).transcoderPath
      );
      loader.workerConfig = Object.fromEntries(
        Object.keys(shared.workerConfig).map((key) => [key, false])
      ) as unknown as typeof shared.workerConfig;
      return loader;
    }
  );
  return (await (await rgbaLoader).loadAsync(url)) as THREE.CompressedTexture;
};
const CODECS = ['etc1s', 'uastc'] as const;

// The shim types `texture` and `uv` too: these take the real types
const sampleTexture = texture as unknown as (tex: THREE.Texture, uvNode: Node) => TextureNode;
const meshUv = uv as unknown as () => Node<'vec2'>;

type MipLevel = { data: Uint8Array | Uint16Array; width: number; height: number };

/** D1's KTX2 path: each level's member data concatenated, layer `i` = `members[i]`. */
const concatMembers = (members: THREE.CompressedTexture[]) => {
  const first = members[0];
  const firstMips = first.mipmaps as unknown as MipLevel[];
  for (const member of members) {
    const mips = member.mipmaps as unknown as MipLevel[];
    if (
      member.format !== first.format ||
      member.type !== first.type ||
      mips.length !== firstMips.length ||
      member.image.width !== first.image.width ||
      member.image.height !== first.image.height
    ) {
      throw new Error(`Member "${member.name}" doesn't match "${first.name}"`);
    }
  }
  const mipmaps = firstMips.map(({ data, width, height }, level) => {
    const out = new (data.constructor as Uint8ArrayConstructor)(data.length * members.length);
    members.forEach((member, i) =>
      out.set((member.mipmaps as unknown as MipLevel[])[level].data, i * data.length)
    );
    return { data: out, width, height };
  });
  const array = new THREE.CompressedArrayTexture(
    mipmaps as unknown as ImageData[],
    first.image.width,
    first.image.height,
    members.length,
    first.format as THREE.CompressedPixelFormat,
    first.type
  );
  array.minFilter = first.minFilter;
  array.magFilter = first.magFilter;
  array.colorSpace = first.colorSpace;
  array.premultiplyAlpha = first.premultiplyAlpha;
  array.generateMipmaps = false;
  array.needsUpdate = true;
  return array;
};

/** D1's layer swap: the member's data into the layer's range of every level, one layer upload. */
const setArrayLayer = (
  array: THREE.CompressedArrayTexture,
  layer: number,
  member: THREE.CompressedTexture
) => {
  const mips = array.mipmaps as unknown as MipLevel[];
  const memberMips = member.mipmaps as unknown as MipLevel[];
  mips.forEach((mip, level) => {
    const layerLength = mip.data.length / array.image.depth;
    mip.data.set(memberMips[level].data, layer * layerLength);
  });
  array.addLayerUpdate(layer);
  array.needsUpdate = true;
};

const nextFrames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

type Backend = {
  isWebGPUBackend?: boolean;
  device?: { queue: { onSubmittedWorkDone: () => Promise<void> } };
  get: (texture: THREE.Texture) => {
    textureDescriptorGPU?: { format: string };
    glInternalFormat?: number;
  };
};
const getBackend = () => (getRenderer() as unknown as { backend: Backend }).backend;

/** The GPU format three picked (WebGPU) or the GL internal format (WebGL2). */
const describeUpload = (tex: THREE.Texture) => {
  const data = getBackend().get(tex);
  const memoryMap = (getRenderer()!.info as unknown as { memoryMap: WeakMap<object, number> })
    .memoryMap;
  return {
    gpuFormat: data.textureDescriptorGPU?.format ?? data.glInternalFormat ?? null,
    countedBytes: memoryMap.get(tex) ?? null,
    cpuBytes: (tex.mipmaps as unknown as MipLevel[]).reduce((sum, m) => sum + m.data.byteLength, 0),
  };
};

const spikeState: {
  backend: string;
  textures: Record<string, THREE.Texture>;
  results: Record<string, unknown>;
  runPerf: (rounds?: number) => Promise<unknown>;
} = {
  backend: '',
  textures: {},
  results: {},
  runPerf: (rounds) => runPerf(rounds),
};

const waitForGPU = async () => {
  const backend = getBackend();
  if (backend.isWebGPUBackend) await backend.device!.queue.onSubmittedWorkDone();
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

/**
 * 16 × 1K UASTC members: CPU concatenation + one upload, against uploading every member and
 * `copyTextureToTexture` per layer and level into an array (WebGPU only).
 */
const runPerf = async (rounds = 5) => {
  const renderer = getRenderer()!;
  const urls = Array.from(
    { length: 16 },
    (_, i) => `${URL_BASE}/perf/m${String(i).padStart(2, '0')}_uastc.ktx2`
  );
  const members = await Promise.all(urls.map((url) => loadKtx(url)));
  const timings = {
    cpuConcatMs: [] as number[],
    cpuUploadMs: [] as number[],
    gpuMs: [] as number[],
  };
  const isWebGPU = Boolean(getBackend().isWebGPUBackend);

  for (let round = 0; round < rounds; round++) {
    await waitForGPU();
    let t0 = performance.now();
    const array = concatMembers(members);
    timings.cpuConcatMs.push(performance.now() - t0);
    t0 = performance.now();
    renderer.initTexture(array);
    await waitForGPU();
    timings.cpuUploadMs.push(performance.now() - t0);
    array.dispose();

    if (!isWebGPU) continue;
    await waitForGPU();
    t0 = performance.now();
    // The destination needs data for three to allocate it: zeros, uploaded once
    const first = members[0];
    const zeroMips = (first.mipmaps as unknown as MipLevel[]).map(({ data, width, height }) => ({
      data: new Uint8Array(data.byteLength * members.length),
      width,
      height,
    }));
    const target = new THREE.CompressedArrayTexture(
      zeroMips as unknown as ImageData[],
      first.image.width,
      first.image.height,
      members.length,
      first.format as THREE.CompressedPixelFormat,
      first.type
    );
    target.generateMipmaps = false;
    target.needsUpdate = true;
    const region = new THREE.Box2(new THREE.Vector2(0, 0), new THREE.Vector2());
    const position = new THREE.Vector3();
    members.forEach((member, layer) => {
      const mips = member.mipmaps as unknown as MipLevel[];
      mips.forEach((mip, level) => {
        // Copies of a block-compressed format cover whole 4 × 4 blocks
        region.max.set(Math.ceil(mip.width / 4) * 4, Math.ceil(mip.height / 4) * 4);
        position.set(0, 0, layer);
        renderer.copyTextureToTexture(member, target, region, position, level, level);
      });
    });
    await waitForGPU();
    timings.gpuMs.push(performance.now() - t0);
    target.dispose();
    for (const member of members) member.dispose();
  }
  for (const member of members) member.dispose();

  const result = {
    backend: spikeState.backend,
    format: members[0].format,
    layerBytes: (members[0].mipmaps as unknown as MipLevel[]).reduce(
      (sum, m) => sum + m.data.byteLength,
      0
    ),
    rounds,
    medianMs: {
      cpuConcat: median(timings.cpuConcatMs),
      cpuUpload: median(timings.cpuUploadMs),
      cpuTotal: median(timings.cpuConcatMs) + median(timings.cpuUploadMs),
      gpuAssembly: isWebGPU ? median(timings.gpuMs) : null,
    },
    timings,
  };
  spikeState.results.perf = result;
  llog('[p299 spike] perf', result);
  return result;
};

export const scene = async () => {
  (window as unknown as { __p299Spike: typeof spikeState }).__p299Spike = spikeState;
  spikeState.backend = getBackend().isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  spikeState.results = {};

  createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 45,
      position: { x: 0, y: 0, z: 7.5 },
      lookAtPoint: { x: 0, y: 0, z: 0 },
      active: true,
    },
    { appId: 'textureArraySpikeCam', debugData: { name: 'Texture array spike' } }
  );

  const planeGeo = new THREE.PlaneGeometry(1, 1);
  const geo = saveBufferGeometry(planeGeo, { id: 'textureArraySpikeQuad' });
  if (geo !== planeGeo) planeGeo.dispose();

  const addQuad = (row: number, col: number, colorNode: Node<'vec4'>, name: string) => {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = colorNode;
    saveMaterial(mat, `textureArraySpike/${name}`);
    createMeshEntity(
      { geo, mat, position: { x: -1.8 + col * 1.2, y: 1.8 - row * 1.2, z: 0 } },
      { appId: `textureArraySpike_${name}` }
    );
  };
  const sampleLayer = (tex: THREE.Texture, layer: number) =>
    sampleTexture(tex, meshUv()).depth(int(layer) as unknown as Node);

  for (const [c, codec] of CODECS.entries()) {
    const [built, s0, s1, s2, s3] = await Promise.all([
      FORCE_RGBA
        ? loadKtx(`${URL_BASE}/arr2_${codec}.ktx2`).then((tex) =>
            saveTexture(tex, `p299/arr2_${codec}`)
          )
        : loadTextureAsync({
            id: `p299/arr2_${codec}`,
            fileName: `${URL_BASE}/arr2_${codec}.ktx2`,
            throwOnError: true,
          }),
      ...[0, 1, 2, 3].map((i) => loadKtx(`${URL_BASE}/s${i}_${codec}.ktx2`)),
    ]);
    [s0, s1, s2, s3].forEach((tex, i) => (tex.name = `s${i}_${codec}`));
    const runtime = saveTexture(concatMembers([s0, s1]), `p299/runtime_${codec}`);
    const swapped = saveTexture(concatMembers([s0, s1]), `p299/swapped_${codec}`);
    saveTexture(s0, `p299/s0_${codec}`);
    saveTexture(s1, `p299/s1_${codec}`);
    Object.assign(spikeState.textures, {
      [`built_${codec}`]: built,
      [`runtime_${codec}`]: runtime,
      [`swapped_${codec}`]: swapped,
    });
    spikeState.results[`built_${codec}`] = {
      isCompressedArrayTexture: (built as THREE.CompressedArrayTexture).isCompressedArrayTexture,
      depth: (built.image as { depth?: number }).depth,
      levels: built.mipmaps?.length,
      format: built.format,
      colorSpace: built.colorSpace,
    };

    for (const layer of [0, 1]) {
      const col = c * 2 + layer;
      addQuad(0, col, sampleLayer(built, layer), `built_${codec}_L${layer}`);
      addQuad(1, col, sampleLayer(runtime, layer), `runtime_${codec}_L${layer}`);
      addQuad(2, col, sampleTexture(layer ? s1 : s0, meshUv()), `single_${codec}_s${layer}`);
      addQuad(3, col, sampleLayer(swapped, layer), `swapped_${codec}_L${layer}`);
    }

    // The swap goes through the layer update path only once the array is on the GPU
    void nextFrames(10).then(() => {
      if (codec === 'etc1s') setArrayLayer(swapped, 1, s2);
      else setArrayLayer(swapped, 0, s3);
      spikeState.results[`swapped_${codec}_updateQueued`] = true;
      return nextFrames(5).then(() => {
        spikeState.results[`swapped_${codec}_layerUpdatesLeft`] = (
          swapped as THREE.CompressedArrayTexture
        ).layerUpdates.size;
        for (const key of [`built_${codec}`, `runtime_${codec}`, `swapped_${codec}`]) {
          spikeState.results[`${key}_upload`] = describeUpload(spikeState.textures[key]);
        }
        spikeState.results[`s0_${codec}_upload`] = describeUpload(s0);
      });
    });
  }
};
