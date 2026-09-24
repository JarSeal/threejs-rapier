import { DEBUG_PHYSICS_API_BOOT_LS_KEY } from '../Config';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import type { PhysicsWorkerTarget } from '../Physics/PhysicsAPITypes';

/**
 * Debug-only boot-time physics overrides, applied by loadConfig() on the next reload.
 *
 * These live apart from each tab's own persisted UI state on purpose: they are read once at
 * boot, before any debug tab exists, so a tab holding its own copy could clobber the
 * boot-derived value the moment an unrelated field in that tab changed.
 *
 * Shared by more than one tab — `stepStatsEnabled` is offered both from the Physics API tab
 * (next to the other boot fields it belongs with) and from the Statistics tab's Performance
 * Measuring folder (next to the other panel toggles it belongs with) — which is why the
 * read/merge/write/reload lives here instead of being duplicated per tab.
 */
export type DebugPhysicsApiBoot = {
  workerTarget?: PhysicsWorkerTarget;
  useSAB?: boolean;
  maxBodies?: number;
  /** Measure per-step physics time (and worker messaging latency), and show the "PHY" stats
   * panel. Boot-time because the SHARED_MEMORY transport's stats buffer is allocated once at
   * world creation, and because the panel itself is created once at stats init. */
  stepStatsEnabled?: boolean;
};

const getBootOverrides = () => lsGetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, {}) as DebugPhysicsApiBoot;

/** Merges a partial override in and reloads, since none of these can be applied live. */
export const setBootOverride = (partial: DebugPhysicsApiBoot) => {
  lsSetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, { ...getBootOverrides(), ...partial });
  location.reload();
};
