/// <reference lib="webworker" />

import {
  AssetsDownProtocol,
  AssetsSimplifyGeometryRequest,
} from '../../core/Assets/AssetsAPITypes';
import { simplifyLodChain } from '../../core/Lod/LodSimplify';

/** A geometry's LOD chain (the same simplifyLodChain() the main-thread fallback runs). Its index
 * and vertex arrays are transferred, not copied. */
export const assetsSwitchSimplify = async (
  data: AssetsSimplifyGeometryRequest,
  sendMessage: (message: AssetsDownProtocol, transfer?: Transferable[]) => void
) => {
  const { type, requestId, geometry, options } = data;
  const transfer = new Set<ArrayBuffer>();
  const result = await simplifyLodChain(geometry, options, transfer);
  sendMessage({ type, requestId, result }, [...transfer]);
};
