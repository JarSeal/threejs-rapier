/// <reference lib="webworker" />

import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
  AssetsDownProtocol,
  AssetsLoadHDRTextureRequest,
  AssetsLoadTextureRequest,
  AssetsProtocolType,
} from '../../core/Assets/AssetsAPITypes';
import { fetchAsset } from './assetsFetch';

let hdrLoader: HDRLoader | null = null;

export const assetsSwitchTexture = async (
  data: AssetsLoadTextureRequest | AssetsLoadHDRTextureRequest,
  sendMessage: (message: AssetsDownProtocol, transfer?: Transferable[]) => void
) => {
  const { type, requestId, url } = data;
  switch (type) {
    case AssetsProtocolType.LOAD_TEXTURE: {
      const blob = await (await fetchAsset(url)).blob();
      // Bakes in the vertical flip TextureLoader's default flipY = true does at upload time
      // (flipY is ignored for ImageBitmaps), and keeps the alpha unpremultiplied like it does
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
      });
      return sendMessage({ type, requestId, bitmap }, [bitmap]);
    }
    case AssetsProtocolType.LOAD_HDR_TEXTURE: {
      const buffer = await (await fetchAsset(url)).arrayBuffer();
      if (!hdrLoader) hdrLoader = new HDRLoader(); // Default HalfFloatType, as on the main thread
      const texData = hdrLoader.parse(buffer);
      // @types/three says Float32Array | Uint8Array, but HalfFloatType data is a Uint16Array
      const hdrData: unknown = texData.data;
      if (!(hdrData instanceof Uint16Array)) {
        throw new Error(`HDRLoader returned no half-float data for "${url}".`);
      }
      return sendMessage(
        { type, requestId, width: texData.width, height: texData.height, data: hdrData },
        [hdrData.buffer]
      );
    }
  }
};
