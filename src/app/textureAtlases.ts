import * as THREE from 'three/webgpu';
import { float, fwidth, max, mix, step, texture, uv, vec3, vec4 } from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import type { Node, TextureNode } from 'three/webgpu';
import { createCameraEntity, getActiveCamera } from '../_engine/core/CameraManager';
import { getGeometryRegistry, saveBufferGeometry } from '../_engine/core/Geometry';
import { createLightEntity } from '../_engine/core/LightManager';
import { saveMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getRenderer } from '../_engine/core/Renderer';
import { getGeneratedSceneData } from '../_engine/core/Scene';
import { loadScene, type ScenePrimitiveAssets } from '../_engine/core/SceneLoader';
import {
  getAllTextures,
  getTexture,
  loadTextureAsync,
  type TextureProps,
} from '../_engine/core/Texture';
import {
  getAtlasCell,
  getTextureAtlasInfo,
  remapUVsToAtlasCell,
  sampleAtlasCell,
  type TextureAtlasInfo,
} from '../_engine/core/TextureAtlas';
import { lerror } from '../_engine/utils/Logger';

/**
 * The p299 atlas verification scene: the `p299TestAtlas` asset (`*.textureAtlas.json`, listed by
 * its atlas id, so the scene loader loads both slots). Unlit quads in a grid 1.2 apart, the albedo
 * slot in columns 0-5, the mask slot in columns 7-12:
 * - row 0: the whole slot at each mip level its file has (`.level(n)`), the cells' content rects
 *   outlined in magenta and their padded rects in cyan.
 * - rows 1…levels: each cell (a column per cell, in the cell table's order) sampled through its
 *   UV rect at level 0…levels-1, bilinear (`sampleAtlasCell`, clamped to the cell). The last of
 *   them is Phase 3's exit: no neighbour at the cell's edges.
 * - row levels + 1: each cell's source file in that slot (empty: the cell has none, its fill).
 * - rows levels + 2 and + 3: each cell at level 0 with the UVs overscanned to -0.25..1.25, clamped
 *   to the cell (its edge texels stretched out) and not (its padding, then its neighbours).
 * - column 6 (between the slots), lit: a sphere remapped into the checker cell
 *   (`remapUVsToAtlasCell`, a clone) with the albedo slot as its `map`, the same sphere with the
 *   cell's source file, and a box remapped in place into the metal cell.
 * A cell's quads have its content's aspect. `window.__textureAtlases` holds the checks' results
 * and `screenRect(name)` for the harness.
 */

const ATLAS_ID = 'p299TestAtlas';
const SLOTS = ['albedo', 'mask'] as const;
const CELL = 1.2;
const SLOT_COLUMNS = 7;
/** The gap between the slots: the lit remapped meshes */
const LIT_COLUMN = 6;
const X0 = -CELL * 6;
const Y0 = CELL * 3.5;
/** In front of the debug helpers at the world origin */
const Z = 2;

/** A file next to this module as a file name loadTextureAsync resolves against the page (`./`
 * plus the name, so no leading slash) */
const local = (url: URL) => url.pathname.slice(1);

/** Each cell's source per slot (the atlas JSON's `sources`), as the dev server serves it */
const CELL_SOURCES: Record<(typeof SLOTS)[number], Record<string, string>> = {
  albedo: {
    red: local(new URL('./textures/source/p299Atlas/red.png', import.meta.url)),
    green: local(new URL('./textures/source/p299Atlas/green.png', import.meta.url)),
    checker: 'debugger/assets/testTextures/UVMaps/UVCheckerMap-orange-white-512.png',
    metal: 'debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
    blue: local(new URL('./textures/source/p299Atlas/blue.png', import.meta.url)),
    yellow: local(new URL('./textures/source/p299Atlas/yellow.png', import.meta.url)),
  },
  mask: {
    red: local(new URL('./textures/source/p299Atlas/maskRings.png', import.meta.url)),
    green: local(new URL('./textures/source/p299Atlas/maskGradient.png', import.meta.url)),
    blue: local(new URL('./textures/source/p299Atlas/maskGradient.png', import.meta.url)),
    yellow: local(new URL('./textures/source/p299Atlas/maskRings.png', import.meta.url)),
  },
};

const sampleTexture = texture as unknown as (tex: THREE.Texture, uvNode: Node) => TextureNode;
const meshUv = uv as unknown as () => Node<'vec2'>;

type Quad = { x: number; y: number; halfW: number; halfH: number };

const state: {
  results: Record<string, unknown>;
  quads: Record<string, Quad>;
  project: (x: number, y: number) => { x: number; y: number };
  /** A quad's screen rect in CSS px, by its name (`<slot>_atlas_L<n>`, `<slot>_<cell>_L<n>`,
   * `<slot>_<cell>_source`) */
  screenRect: (name: string) => { left: number; top: number; w: number; h: number };
  /** The registered textures' ids (the harness checks what a scene exit released) */
  getTextureIds: () => string[];
  leaveTo: (sceneId: string) => Promise<unknown>;
} = {
  getTextureIds: () => Object.keys(getAllTextures()),
  leaveTo: (sceneId) => loadScene({ sceneId }),
  results: {},
  quads: {},
  project: (x, y) => {
    const camera = getActiveCamera()!;
    const canvas = getRenderer()!.domElement;
    const v = new THREE.Vector3(x, y, Z).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  },
  screenRect: (name) => {
    const { x, y, halfW, halfH } = state.quads[name];
    const a = state.project(x - halfW, y + halfH);
    const b = state.project(x + halfW, y - halfH);
    return { left: a.x, top: a.y, w: b.x - a.x, h: b.y - a.y };
  },
};

let quadGeo: THREE.BufferGeometry;

/** A quad of `aspect` (width / height) fit into a 1 × 1 cell of the grid */
const addQuad = (name: string, colorNode: Node<'vec4'>, row: number, col: number, aspect = 1) => {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = colorNode;
  saveMaterial(mat, `textureAtlases/${name}`);
  const scale = aspect >= 1 ? { x: 1, y: 1 / aspect } : { x: aspect, y: 1 };
  const x = X0 + col * CELL;
  const y = Y0 - row * CELL;
  state.quads[name] = { x, y, halfW: scale.x / 2, halfH: scale.y / 2 };
  createMeshEntity(
    { geo: quadGeo, mat, position: { x, y, z: Z }, scale: { ...scale, z: 1 } },
    { appId: `textureAtlases_${name}` }
  );
};

/** 1 where `p` is inside `rect` ([u0, v0, u1, v1]) grown by `grow` (negative: shrunk) */
const insideRect = (p: Node<'vec2'>, rect: number[], grow: Node<'vec2'>) =>
  step(float(rect[0]).sub(grow.x), p.x)
    .mul(step(p.x, float(rect[2]).add(grow.x)))
    .mul(step(float(rect[1]).sub(grow.y), p.y))
    .mul(step(p.y, float(rect[3]).add(grow.y)));

/** 1 on a line about two px wide along `rect`'s edges */
const rectOutline = (p: Node<'vec2'>, rect: number[], px: Node<'vec2'>) =>
  insideRect(p, rect, px).sub(insideRect(p, rect, px.negate()));

/** The whole slot at mip `level`, with the cell rects outlined */
const atlasLevelNode = (tex: THREE.Texture, info: TextureAtlasInfo, level: number) => {
  const p = meshUv();
  const px = fwidth(p) as unknown as Node<'vec2'>;
  const pad = [info.padding / info.size[0], info.padding / info.size[1]];
  let content: Node<'float'> = float(0);
  let padded: Node<'float'> = float(0);
  for (const { uv: rect } of Object.values(info.cells)) {
    content = max(content, rectOutline(p, rect, px)) as unknown as Node<'float'>;
    const paddedRect = [rect[0] - pad[0], rect[1] - pad[1], rect[2] + pad[0], rect[3] + pad[1]];
    padded = max(padded, rectOutline(p, paddedRect, px)) as unknown as Node<'float'>;
  }
  const sampled = sampleTexture(tex, p).level(float(level) as unknown as Node).rgb;
  // The quad's own edge in grey: the slot's fill can be the background's black
  const framed = mix(sampled, vec3(0.4), rectOutline(p, [0, 0, 1, 1], px));
  const withPadded = mix(framed, vec3(0, 1, 1), padded.mul(0.7));
  return vec4(mix(withPadded, vec3(1, 0, 1), content), 1) as unknown as Node<'vec4'>;
};

/** One cell at mip `level`, sampled by `sampleAtlasCell` with the mesh UV scaled by `overscan`
 * around the cell's centre (1: the cell, 1.5: a quarter of it more on each side) */
const cellLevelNode = (
  tex: THREE.Texture,
  cellId: string,
  level: number,
  { overscan = 1, clampToCell = true } = {}
) => {
  const cellUv = meshUv().sub(0.5).mul(overscan).add(0.5) as unknown as Node<'vec2'>;
  return vec4(
    sampleAtlasCell(tex, cellUv, cellId, { clampToCell }).level(float(level) as unknown as Node)
      .rgb,
    1
  ) as unknown as Node<'vec4'>;
};

const nextFrames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

/** Runs `fn`, expecting it to throw: the message, or a failure note when it didn't. */
const expectError = async (fn: () => unknown) => {
  try {
    await fn();
    return 'FAILED: did not throw';
  } catch (error) {
    return (error as Error).message;
  }
};

const describeSlot = (tex: THREE.Texture) => {
  const info = getTextureAtlasInfo(tex)!;
  const mipmaps = (tex as THREE.CompressedTexture).mipmaps as unknown as {
    data: Uint8Array;
    width: number;
    height: number;
  }[];
  const { cells, ...layout } = info;
  return {
    textureId: tex.userData.id,
    type: tex.constructor.name,
    isRegistered: getTexture(tex.userData.id) === tex,
    format: tex.format,
    colorSpace: tex.colorSpace,
    minFilter: tex.minFilter,
    ...layout,
    cellIds: Object.keys(cells),
    mipSizes: mipmaps.map(({ width, height }) => `${width}×${height}`),
    cpuBytes: mipmaps.reduce((sum, m) => sum + m.data.byteLength, 0),
    gpuCountedBytes:
      (getRenderer()!.info as unknown as { memoryMap: WeakMap<object, number> }).memoryMap.get(
        tex
      ) ?? null,
  };
};

const loadSource = (name: string, fileName: string, colorSpace: THREE.ColorSpace) =>
  loadTextureAsync({
    id: `textureAtlases/${name}`,
    fileName,
    texOpts: { colorSpace },
    throwOnError: true,
  });

const buildSlot = async (tex: THREE.Texture, slotIndex: number) => {
  const info = getTextureAtlasInfo(tex)!;
  const slot = info.slot as (typeof SLOTS)[number];
  const col0 = slotIndex * SLOT_COLUMNS;
  const atlasAspect = info.size[0] / info.size[1];
  for (let level = 0; level < info.storedLevels; level++) {
    addQuad(
      `${slot}_atlas_L${level}`,
      atlasLevelNode(tex, info, level),
      0,
      col0 + level,
      atlasAspect
    );
  }
  for (const [c, [cellId, cell]] of Object.entries(info.cells).entries()) {
    const aspect = cell.size[0] / cell.size[1];
    for (let level = 0; level < info.storedLevels; level++) {
      addQuad(
        `${slot}_${cellId}_L${level}`,
        cellLevelNode(tex, cellId, level),
        1 + level,
        col0 + c,
        aspect
      );
    }
    for (const [i, clampToCell] of [true, false].entries()) {
      addQuad(
        `${slot}_${cellId}_overscan${clampToCell ? 'Clamped' : 'Unclamped'}`,
        cellLevelNode(tex, cellId, 0, { overscan: 1.5, clampToCell }),
        2 + info.storedLevels + i,
        col0 + c,
        aspect
      );
    }
    const sourceFile = CELL_SOURCES[slot]?.[cellId];
    if (!sourceFile) continue;
    const source = await loadSource(
      `${slot}_${cellId}`,
      sourceFile,
      tex.colorSpace as THREE.ColorSpace
    );
    addQuad(
      `${slot}_${cellId}_source`,
      vec4(sampleTexture(source, meshUv()).rgb, 1) as unknown as Node<'vec4'>,
      1 + info.storedLevels,
      col0 + c,
      aspect
    );
  }
};

/** A UV attribute's range, `[minU, minV, maxU, maxV]` */
const uvRange = (geometry: THREE.BufferGeometry) => {
  const attr = geometry.getAttribute('uv');
  const range = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < attr.count; i++) {
    range[0] = Math.min(range[0], attr.getX(i));
    range[1] = Math.min(range[1], attr.getY(i));
    range[2] = Math.max(range[2], attr.getX(i));
    range[3] = Math.max(range[3], attr.getY(i));
  }
  return range;
};

const addLitMesh = (name: string, geo: THREE.BufferGeometry, map: THREE.Texture, row: number) => {
  const mat = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.6, metalness: 0 });
  saveMaterial(mat, `textureAtlases/${name}`);
  const x = X0 + LIT_COLUMN * CELL;
  const y = Y0 - row * CELL;
  state.quads[name] = { x, y, halfW: 0.5, halfH: 0.5 };
  createMeshEntity(
    { geo, mat, position: { x, y, z: Z }, rotation: { x: 0.35, y: -0.6, z: 0 } },
    { appId: `textureAtlases_${name}` }
  );
};

/** Phase 4's exit: lit meshes with their UVs remapped into albedo cells (`remapUVsToAtlasCell`),
 * drawn with the slot as a plain `map`, next to the cell's source file on the same geometry. */
const buildRemappedMeshes = (albedo: THREE.Texture) => {
  const { results } = state;
  const sphere = saveBufferGeometry(new THREE.SphereGeometry(0.45, 48, 24), {
    id: 'textureAtlasesSphere',
  });
  const remapped = remapUVsToAtlasCell(sphere, ATLAS_ID, 'checker');
  addLitMesh('lit_checker_remapped', remapped, albedo, 1);
  addLitMesh('lit_checker_source', sphere, getTexture('textureAtlases/albedo_checker')!, 2);

  const box = saveBufferGeometry(new THREE.BoxGeometry(0.6, 0.6, 0.6), {
    id: 'textureAtlasesBox',
  });
  const inPlace = remapUVsToAtlasCell(box, `${ATLAS_ID}.albedo`, 'metal', { inPlace: true });
  addLitMesh('lit_metal_inPlace', box, albedo, 3);

  // UVs tiled twice: remapped with a warning (they reach the cell's neighbours)
  const tiled = new THREE.PlaneGeometry(1, 1);
  const tiledUv = tiled.getAttribute('uv');
  for (let i = 0; i < tiledUv.count; i++) {
    tiledUv.setXY(i, tiledUv.getX(i) * 2, tiledUv.getY(i) * 2);
  }
  const tiledRemapped = remapUVsToAtlasCell(saveBufferGeometry(tiled), albedo, 'red');

  const sharedAttributes = Object.entries(remapped.attributes)
    .filter(([key, attr]) => {
      const sourceAttr = sphere.attributes[key] as THREE.BufferAttribute | undefined;
      return sourceAttr === attr || sourceAttr?.array === (attr as THREE.BufferAttribute).array;
    })
    .map(([key]) => key);
  const expectSync = (fn: () => unknown) => {
    try {
      fn();
      return 'FAILED: did not throw';
    } catch (error) {
      return (error as Error).message;
    }
  };
  results.remap = {
    cellUv: {
      checker: getAtlasCell(ATLAS_ID, 'checker')!.uv,
      metal: getAtlasCell(albedo, 'metal')!.uv,
    },
    clone: {
      id: remapped.userData.id,
      isRegistered: getGeometryRegistry()[remapped.userData.id]?.resource === remapped,
      isSource: remapped === sphere,
      atlasCell: remapped.userData.atlasCell,
      uvRange: uvRange(remapped),
      uvType: remapped.getAttribute('uv').array.constructor.name,
      sharedAttributes,
      sharedIndex: remapped.index === sphere.index || remapped.index?.array === sphere.index?.array,
      // A second call for the same geometry and cell returns the registered clone
      sharedByCall: remapUVsToAtlasCell(sphere, ATLAS_ID, 'checker') === remapped,
    },
    source: {
      id: sphere.userData.id,
      uvRange: uvRange(sphere),
      atlasCell: sphere.userData.atlasCell ?? null,
    },
    inPlace: {
      isSource: inPlace === box,
      id: box.userData.id,
      atlasCell: box.userData.atlasCell,
      uvRange: uvRange(box),
    },
    tiled: { id: tiledRemapped.userData.id, uvRange: uvRange(tiledRemapped) },
    errors: {
      alreadyRemapped: expectSync(() => remapUVsToAtlasCell(remapped, ATLAS_ID, 'red')),
      unknownCell: expectSync(() => remapUVsToAtlasCell(sphere, ATLAS_ID, 'noSuchCell')),
      unknownAtlas: expectSync(() => remapUVsToAtlasCell(sphere, 'noSuchAtlas', 'red')),
      unknownGeometry: expectSync(() => remapUVsToAtlasCell('noSuchGeometry', ATLAS_ID, 'red')),
      noAttribute: expectSync(() =>
        remapUVsToAtlasCell(sphere, ATLAS_ID, 'red', { attribute: 'uv1' })
      ),
    },
  };
};

/** loadTextureAsync of a slot that fails: no output, or a file that doesn't fit its layout. */
const checkErrors = async () => {
  const { results } = state;
  const albedo = (getGeneratedSceneData('textureAtlases')?.textures ?? []).find(
    (tex): tex is TextureProps => typeof tex !== 'string' && tex.id === `${ATLAS_ID}.albedo`
  );
  if (!albedo?.__atlas) throw new Error('No albedo slot entry in the scene data');
  const fallback = await loadTextureAsync({
    id: 'textureAtlases/noOutputFallback',
    __atlas: albedo.__atlas,
  });
  results.noOutputFallback = {
    type: fallback.constructor.name,
    hasAtlasInfo: getTextureAtlasInfo(fallback) !== undefined,
    isRegistered: getTexture('textureAtlases/noOutputFallback') !== undefined,
  };
  const badLayout = (name: string, atlas: Partial<TextureAtlasInfo>) =>
    expectError(() =>
      loadTextureAsync({
        id: `textureAtlases/${name}`,
        __url: albedo.__url,
        __atlas: { ...albedo.__atlas!, ...atlas },
        throwOnError: true,
      })
    );
  results.errors = {
    noOutput: await expectError(() =>
      loadTextureAsync({
        id: 'textureAtlases/noOutput',
        __atlas: albedo.__atlas,
        throwOnError: true,
      })
    ),
    // The file has 5 levels
    tooManyLevels: await badLayout('tooManyLevels', { levels: 3 }),
    // 1024² would mean one dropped level: 1 + 5 > 5
    droppedPlusStored: await badLayout('droppedPlusStored', { size: [1024, 1024] }),
    sizeMismatch: await badLayout('sizeMismatch', { size: [384, 512] }),
  };
};

/** Phase 4's lookups and sampleAtlasCell's errors. */
const checkHelpers = (albedo: THREE.Texture) => {
  const { results } = state;
  const plain = getTexture('textureAtlases/albedo_red')!;
  results.cellLookups = {
    byAtlasId: getAtlasCell(ATLAS_ID, 'metal') ?? null,
    bySlotId: getAtlasCell(`${ATLAS_ID}.mask`, 'metal') ?? null,
    bySlotTexture: getAtlasCell(albedo, 'metal') ?? null,
    unknownCell: getAtlasCell(ATLAS_ID, 'noSuchCell') ?? null,
    unknownAtlas: getAtlasCell('noSuchAtlas', 'metal') ?? null,
    notAnAtlas: getAtlasCell(plain, 'metal') ?? null,
  };
  const expectSampleError = (fn: () => unknown) => {
    try {
      fn();
      return 'FAILED: did not throw';
    } catch (error) {
      return (error as Error).message;
    }
  };
  results.sampleErrors = {
    unknownCell: expectSampleError(() => sampleAtlasCell(albedo, meshUv(), 'noSuchCell')),
    notAnAtlas: expectSampleError(() => sampleAtlasCell(plain, meshUv(), 'metal')),
  };
  // A rect works on any texture
  try {
    sampleAtlasCell(plain, meshUv(), [0, 0, 0.5, 0.5]);
    results.rectOnPlainTexture = 'ok';
  } catch (error) {
    results.rectOnPlainTexture = (error as Error).message;
  }
};

const build = async (assets: ScenePrimitiveAssets) => {
  const { results } = state;
  results.sceneTextureIds = Object.keys(assets.textures);
  const slotTextures = SLOTS.map((slot) => assets.textures[`${ATLAS_ID}.${slot}`]);
  for (const [i, tex] of slotTextures.entries()) {
    if (!tex || !getTextureAtlasInfo(tex)) {
      throw new Error(`Slot "${SLOTS[i]}" didn't load as an atlas slot`);
    }
    await buildSlot(tex, i);
  }
  await checkErrors();
  checkHelpers(slotTextures[0]);
  buildRemappedMeshes(slotTextures[0]);
  return slotTextures;
};

type Backend = { isWebGPUBackend?: boolean };

export const scene = async ({ assets }: { assets: ScenePrimitiveAssets }) => {
  (window as unknown as { __textureAtlases: typeof state }).__textureAtlases = state;
  state.results = {};
  state.quads = {};

  createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 45,
      position: { x: 0, y: 0, z: Z + 15 },
      lookAtPoint: { x: 0, y: 0, z: Z },
      active: true,
    },
    { appId: 'textureAtlasesCam', debugData: { name: 'Texture atlases' } }
  );
  // For the lit meshes only: the quads are unlit
  createLightEntity(
    { type: 'AMBIENT', color: '#ffffff', intensity: 0.6 },
    { appId: 'textureAtlasesAmbient' }
  );
  createLightEntity(
    {
      type: 'DIRECTIONAL',
      color: '#ffffff',
      intensity: 2.5,
      position: { x: 3, y: 5, z: Z + 6 },
      targetPos: { x: 0, y: 0, z: Z },
    },
    { appId: 'textureAtlasesSun' }
  );

  const quad = new THREE.PlaneGeometry(1, 1);
  quadGeo = saveBufferGeometry(quad, { id: 'textureAtlasesQuad' });
  if (quadGeo !== quad) quad.dispose();

  try {
    const slotTextures = await build(assets);
    // The slots' state once they are on the GPU (nothing is drawn while the scene loads)
    void nextFrames(10).then(() => {
      const { results } = state;
      const backend = (getRenderer() as unknown as { backend: Backend }).backend;
      results.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
      results.slots = Object.fromEntries(
        slotTextures.map((tex, i) => [SLOTS[i], describeSlot(tex)])
      );
      results.done = true;
    });
  } catch (error) {
    lerror('[textureAtlases] Build failed', error);
    state.results.buildError = (error as Error).message;
  }
};
