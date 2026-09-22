/**
 * Per-step live-state mirror for the physics debug wireframes
 * (docs/plans/_DONE_p025_debug-drawing-in-physics-api.md, Design decision 4).
 *
 * The wireframe colors depend on simulation state (sleeping / kinematic / enabled /
 * sensor), which in WORKER_THREAD mode is only reachable through async RPC —
 * RigidBodyProxyAPI.isSleepingSync() and friends throw there on purpose. Polling that
 * per visualized entity per frame would reintroduce exactly the per-object round trip
 * the Physics API exists to avoid, so state travels the same way transforms already do:
 * a flat typed array, either a real SharedArrayBuffer or one batched Transferable push
 * per step (see PhysicsTransformBuffer.ts for the same SAB/fallback split).
 *
 * Two things make it cheaper than the transform buffer:
 *
 * 1. It is allocated lazily. Nothing exists, and the worker writes nothing, until the
 *    first wireframe is switched on — so the always-on cost of the whole feature is zero.
 * 2. It tracks an explicit set of ids, not the whole world. The main thread sends the
 *    exact rigid bodies/colliders it is visualizing and their *array position is their
 *    slot*, so neither side needs a slot allocator and per-step cost scales with how
 *    many wireframes the user turned on, not with world size.
 *
 * MAIN_THREAD mode never uses this — the *Sync state getters are already free there.
 */

/** Uint32 bitflags describing one tracked rigid body. */
export const DebugBodyFlag = {
  /** Slot holds a body that still resolved this step. Clear = read nothing else here. */
  VALID: 1 << 0,
  SLEEPING: 1 << 1,
  ENABLED: 1 << 2,
  KINEMATIC: 1 << 3,
  FIXED: 1 << 4,
} as const;

/** Uint32 bitflags describing one tracked collider. */
export const DebugColliderFlag = {
  /** Slot holds a collider that still resolved this step. */
  VALID: 1 << 0,
  ENABLED: 1 << 1,
  SENSOR: 1 << 2,
} as const;

/** One Uint32 per body slot + one per collider slot, both capped at maxSlots. */
export const createPhysicsDebugStateArrayBuffer = (
  maxSlots: number,
  useSAB = false
): ArrayBuffer | SharedArrayBuffer => {
  const byteLength = maxSlots * 2 * Uint32Array.BYTES_PER_ELEMENT;
  return useSAB ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
};

/**
 * Wrapper over the flat debug-state array. Layout is two fixed-capacity regions:
 * `[0 .. maxSlots)` = body flags, `[maxSlots .. maxSlots * 2)` = collider flags.
 *
 * A "slot" here is simply an index into the id arrays the main thread last sent via
 * SET_DEBUG_STATE_TRACKING, which is why there is no allocate/free pair — both sides
 * derive the same mapping from that one message.
 */
export class PhysicsDebugStateBuffer {
  readonly maxSlots: number;
  readonly buffer: ArrayBuffer | SharedArrayBuffer;
  readonly flags: Uint32Array;

  constructor(maxSlots: number, buffer?: ArrayBuffer | SharedArrayBuffer) {
    this.maxSlots = maxSlots;
    this.buffer = buffer ?? createPhysicsDebugStateArrayBuffer(maxSlots, false);
    this.flags = new Uint32Array(this.buffer);
  }

  setBodyFlags(slot: number, flags: number): void {
    if (slot < 0 || slot >= this.maxSlots) return;
    this.flags[slot] = flags;
  }

  getBodyFlags(slot: number): number {
    if (slot < 0 || slot >= this.maxSlots) return 0;
    return this.flags[slot];
  }

  setColliderFlags(slot: number, flags: number): void {
    if (slot < 0 || slot >= this.maxSlots) return;
    this.flags[this.maxSlots + slot] = flags;
  }

  getColliderFlags(slot: number): number {
    if (slot < 0 || slot >= this.maxSlots) return 0;
    return this.flags[this.maxSlots + slot];
  }

  /** Zeroes every slot, so stale flags can't outlive a tracking-set change. */
  clear(): void {
    this.flags.fill(0);
  }
}
