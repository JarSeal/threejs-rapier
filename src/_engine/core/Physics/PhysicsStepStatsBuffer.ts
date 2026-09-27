/** Slot layout for the physics step statistics buffer (p027).
 *
 * A three-`Float64` scratch buffer the worker writes after every STEP message and the main
 * thread polls once per frame, used only when `PhysicsState.stepStatsEnabled` is on AND the
 * SHARED_MEMORY transport resolved — in MESSAGE_BATCH mode the same three numbers ride along
 * on the existing TRANSFORMS_PUSH message instead, so no buffer is allocated at all.
 *
 * The three values are kept strictly separate and are never summed: STEP_MS is the pure
 * simulation cost, the other two are messaging overhead around it.
 */
export const PHYSICS_STEP_STATS_SLOTS = {
  /** Total time spent inside the engine's step() calls for one STEP message (all sub-steps
   * summed), excluding sub-step command replay and write-back. */
  STEP_MS: 0,
  /** main→worker dispatch latency: the worker's receipt time minus the main thread's `sentAt`
   * stamp on the STEP message. Relies on a dedicated worker sharing its owning document's
   * `performance.now()` time origin. */
  DISPATCH_MS: 1,
  /** The worker's `performance.now()` at the instant the last sub-step returned. The main
   * thread subtracts this from its own clock to derive the write-back/read-cadence latency. */
  STEP_END_AT: 2,
} as const;

export const PHYSICS_STEP_STATS_FIELD_COUNT = 3;

/** Allocates the backing buffer. SAB-only by design: this buffer exists purely as the
 * SHARED_MEMORY transport for the stats, so there is no non-SAB variant to fall back to. */
export const createPhysicsStepStatsArrayBuffer = () =>
  new SharedArrayBuffer(PHYSICS_STEP_STATS_FIELD_COUNT * Float64Array.BYTES_PER_ELEMENT);
