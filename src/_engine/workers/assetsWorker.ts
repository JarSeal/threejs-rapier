/// <reference lib="webworker" />

// Only import worker-safe modules here (no Config.ts, Logger.ts or utils/helpers.ts: those
// touch `window`/`document`, directly or through their imports).
import {
  AssetsDownProtocol,
  AssetsProtocolType,
  AssetsUpProtocol,
  AssetsWorkerCapabilities,
  AssetsWorkerReadyMessage,
} from '../core/Assets/AssetsAPITypes';
import { AssetsSourceError } from './assets/assetsFetch';
import { assetsSwitchTexture } from './assets/assetsSwitchTexture';

const STATUS_READY_STRING = 'INIT_READY';

/** The same test GLTFLoader runs (three 0.183.2, GLTFParser constructor) to choose between
 * ImageBitmapLoader and the `document`-dependent TextureLoader. */
const getCapabilities = (): AssetsWorkerCapabilities => {
  const hasCreateImageBitmap = typeof createImageBitmap !== 'undefined';
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  const safariMatch = userAgent.match(/Version\/(\d+)/);
  const safariVersion = isSafari && safariMatch ? parseInt(safariMatch[1], 10) : -1;
  const isFirefox = userAgent.indexOf('Firefox') > -1;
  const firefoxMatch = userAgent.match(/Firefox\/([0-9]+)\./);
  const firefoxVersion = isFirefox && firefoxMatch ? parseInt(firefoxMatch[1], 10) : -1;
  return {
    createImageBitmap: hasCreateImageBitmap,
    gltfImageBitmapPath:
      hasCreateImageBitmap &&
      !(isSafari && safariVersion < 17) &&
      !(isFirefox && firefoxVersion < 98),
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  };
};

const sendMessage = (message: AssetsDownProtocol, transfer?: Transferable[]) =>
  self.postMessage(message, transfer || []);

const handleMessage = async (data: AssetsUpProtocol) => {
  const { type, requestId } = data;
  try {
    switch (type) {
      case AssetsProtocolType.PING:
        return sendMessage({ type, requestId, workerTime: performance.now() });
      case AssetsProtocolType.LOAD_TEXTURE:
      case AssetsProtocolType.LOAD_HDR_TEXTURE:
        return await assetsSwitchTexture(data, sendMessage);
      default:
        return sendMessage({
          type: AssetsProtocolType.ERROR,
          requestId,
          message: `Unknown assets worker (up) protocol type: ${type}`,
        });
    }
  } catch (err) {
    sendMessage({
      type: AssetsProtocolType.ERROR,
      requestId,
      message: err instanceof Error ? err.message : String(err),
      isSourceError: err instanceof AssetsSourceError,
    });
  }
};

self.onmessage = (event: MessageEvent<AssetsUpProtocol>) => handleMessage(event.data);

// Automatically send the handshake (with the capabilities) when this file is executed
self.postMessage({
  status: STATUS_READY_STRING,
  capabilities: getCapabilities(),
} satisfies AssetsWorkerReadyMessage);
