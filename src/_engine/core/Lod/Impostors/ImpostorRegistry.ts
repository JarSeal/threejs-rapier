// The impostors generated in this session (docs/plans/_DONE_p351_impostor-billboard-lod.md Phase 4), by
// id: what the LOD tab's Impostors folder lists and exports. A record goes with its impostor's
// assets: when its geometry (registered under the impostor's id) is deleted, eg. by the scene's
// asset release.
import type * as THREE from 'three/webgpu';
import { isDebugEnvironment, isProdTestMode } from '../../Config';
import { onGeometryDeleted } from '../../Geometry';
import type { CrossQuadsOptions } from './CrossQuads';
import type { ImpostorKind } from './ImpostorFormat';
import type { OctahedralImpostorOptions } from './OctahedralImpostor';

/** `BAKED`: rendered at load. `EXPORTED`: built from a `*.impostor.json` and its atlas. */
export type ImpostorOrigin = 'BAKED' | 'EXPORTED';

/** What a generator call got, so an export (or a re-export) can bake it again */
export type ImpostorSource<Options> = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** The call's options, its `id` resolved */
  options: Options & { id: string };
};

export type ImpostorRecord = {
  id: string;
  origin: ImpostorOrigin;
  /** The bake's wall time in ms, the impostor's assets included (null when nothing was baked) */
  bakeMs: number | null;
} & (
  | {
      kind: Extract<ImpostorKind, 'OCTAHEDRAL'>;
      source: ImpostorSource<OctahedralImpostorOptions> | null;
    }
  | { kind: Extract<ImpostorKind, 'CROSS_QUADS'>; source: ImpostorSource<CrossQuadsOptions> | null }
);

const records = new Map<string, ImpostorRecord>();

/** Whether records keep their source: only where an export can run (the debug env, prod test
 * mode). Elsewhere a record would only keep its source geometry from being collected. */
const isSourceKept = () => isDebugEnvironment() || isProdTestMode();

/** Records an impostor a generator just made, replacing an earlier record under its id. */
export const recordImpostor = (record: ImpostorRecord) => {
  records.set(record.id, isSourceKept() ? record : { ...record, source: null });
};

/** The record of the impostor `id`, while its assets are registered. */
export const getImpostorRecord = (id: string) => records.get(id);

/** Every impostor whose assets are registered, in the order they were generated. */
export const getImpostorRecords = () => [...records.values()];

onGeometryDeleted((id) => {
  records.delete(id);
});
