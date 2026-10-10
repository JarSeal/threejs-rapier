export { generateCrossQuads } from '../../core/Lod/Impostors/CrossQuads';
export type { CrossQuads, CrossQuadsOptions } from '../../core/Lod/Impostors/CrossQuads';
export {
  IMPOSTOR_EXPORT_FORMAT_VERSION,
  getImpostorDefSlots,
} from '../../core/Lod/Impostors/ImpostorFormat';
export type { ImpostorKind } from '../../core/Lod/Impostors/ImpostorFormat';
export { generateOctahedralImpostor } from '../../core/Lod/Impostors/OctahedralImpostor';
export type {
  OctahedralImpostor,
  OctahedralImpostorOptions,
} from '../../core/Lod/Impostors/OctahedralImpostor';
export { resolveAutoLod } from '../../core/Lod/LodAuto';
export { GLTF_LOD_EXTRAS_KEY } from '../../core/Lod/LodChainGLTF';
export type { GLTFLodChainsExtras } from '../../core/Lod/LodChainGLTF';
export {
  GLTF_LOD_FORMAT_VERSION,
  LOD_SIMPLIFY_VERSION,
  resolveLodChainOptions,
} from '../../core/Lod/LodChainOptions';
export type {
  LodChainOptions,
  LodLevelVertices,
  ResolvedLodChainOptions,
} from '../../core/Lod/LodChainOptions';
export { generateLodChain, getLodChain } from '../../core/Lod/LodChains';
export type { LodChain } from '../../core/Lod/LodChains';
export { simplifyLodChain } from '../../core/Lod/LodSimplify';
export type { SimplifiedLodChain } from '../../core/Lod/LodSimplify';
export {
  DEFAULT_LOD_HYSTERESIS,
  getLodBias,
  getLodFrameStats,
  getLodWorldSphere,
  registerLodTarget,
  setLodBias,
  setLodFadeSeconds,
} from '../../core/Lod/LodSystem';
export type { LodFrameStats } from '../../core/Lod/LodSystem';
export type { LodAutoDef, LodData, LodDef, LodTarget, MeshLodDef } from '../../core/Lod/LodTypes';
