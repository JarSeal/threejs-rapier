import type * as THREE from 'three/webgpu';
import { lwarn } from '../../utils/Logger';
import type { LineBackendChoice, LineBackendKind } from './LineTypes';

/** @internal What a line material's colorNode/opacityNode accept. */
export type LineColorNode = NonNullable<THREE.NodeMaterial['colorNode']>;
/** @internal */
export type LineOpacityNode = NonNullable<THREE.NodeMaterial['opacityNode']>;

/**
 * @internal
 * One renderer for a LineObject. The LineObject owns every piece of state (the segment
 * buffer, colour, width, transform, attachment); a backend is a disposable view of it, so
 * swapping backends is re-applying that state to a new one. Both backends read the same
 * flat `xyzxyz` Float32Array, so a swap hands the buffer over without copying.
 *
 * Imports no addons: this module and the THIN backend are static, the FAT one is a
 * dynamic import.
 */
export interface LineBackend {
  readonly kind: LineBackendKind;
  /** Not stable across a backend swap — LineObject re-reads it, and so must everyone. */
  readonly object3D: THREE.Object3D;
  /** Re-binds a new (grown) buffer. Must free the old GPU buffer. */
  setPositions(positions: Float32Array): void;
  /** Uploads the first `segmentCount` segments and draws exactly those. */
  commit(segmentCount: number): void;
  setBounds(box: THREE.Box3, sphere: THREE.Sphere): void;
  /** The line's colour graph (owned by its LineObject, shared across a swap). Rebuilds
   * the pipeline, so it is only called when the graph itself changes. */
  setColorNodes(colorNode: LineColorNode, opacityNode: LineOpacityNode): void;
  /** Blended rendering, for opacity < 1. Rebuilds the pipeline when it changes. */
  setTransparent(transparent: boolean): void;
  /** Screen pixels. A no-op on THIN, which is always 1px. */
  setWidth(width: number): void;
  setDepthTest(depthTest: boolean): void;
  dispose(): void;
}

/** The backend a line should end up on for its choice and width. */
export const resolveLineBackendKind = (
  choice: LineBackendChoice,
  width: number
): LineBackendKind => (choice === 'AUTO' ? (width > 1 ? 'FAT' : 'THIN') : choice);

// ----------------------------------------------------------------------------
// FAT backend loading
// ----------------------------------------------------------------------------

type FatLineModule = typeof import('./LineBackendFat');

let fatLineModule: FatLineModule | null = null;
let fatLinePromise: Promise<boolean> | null = null;
let warnedFatLineLoad = false;

/** @internal Loads the FAT backend once (a dynamic import, its own chunk). Resolves false
 * if it could not be loaded; a later call retries. */
export const loadFatLineBackend = (): Promise<boolean> => {
  if (fatLineModule) return Promise.resolve(true);
  fatLinePromise ??= import('./LineBackendFat').then(
    (mod) => {
      fatLineModule = mod;
      return true;
    },
    (err) => {
      fatLinePromise = null;
      if (!warnedFatLineLoad) {
        warnedFatLineLoad = true;
        lwarn('[Lines] Could not load the thick-line backend; lines draw 1px wide.', err);
      }
      return false;
    }
  );
  return fatLinePromise;
};

/** @internal The FAT backend factory, or null until loadFatLineBackend has resolved. */
export const getFatLineBackendFactory = () => fatLineModule?.createFatLineBackend ?? null;
