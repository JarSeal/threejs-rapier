import { PhysRotation, PhysVector, type PoseArray } from './PhysicsAPITypes';

/** Float32 fields per slot: position(3) + quaternion(4) + linvel(3) + angvel(3). */
export const PHYSICS_TRANSFORM_FIELD_COUNT = 13;

/** Int32 header fields trailing each bank's float slots: [write count, step index] (see publish). */
export const PHYSICS_TRANSFORM_HEADER_INTS = 2;
const HEADER_WRITE_COUNT = 0;
const HEADER_STEP_INDEX = 1;

/** Banks a SHARED_MEMORY buffer uses: a lock-free triple buffer (see publish/latch). */
export const PHYSICS_TRANSFORM_SHARED_BANKS = 3;
/** Control word: the middle bank's index in the low bits, plus a bit set while it holds a
 * snapshot the main thread hasn't latched yet. */
const CONTROL_INDEX_MASK = 0b011;
const CONTROL_FRESH = 0b100;

/** Bytes per bank: the float slots plus that bank's own header. */
const getBankByteLength = (maxBodies: number) =>
  maxBodies * PHYSICS_TRANSFORM_FIELD_COUNT * Float32Array.BYTES_PER_ELEMENT +
  PHYSICS_TRANSFORM_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;

/**
 * Allocates the backing buffer for a PhysicsTransformBuffer. Physics-owned and
 * independent of ECS's TypedArrayTransformStore so worker-thread
 * physics doesn't require ecs.storageMode: 'TYPED_ARRAY' as a prerequisite.
 * With more than one bank, a trailing Int32 control word follows the banks, initialised here
 * (before either side wraps the buffer) to "the middle bank is bank 1, nothing fresh": the
 * main thread starts on bank 0 and the worker on the last bank.
 */
export function createPhysicsTransformArrayBuffer(
  maxBodies: number,
  useSAB = false,
  bankCount = 1
): ArrayBuffer | SharedArrayBuffer {
  const banksByteLength = bankCount * getBankByteLength(maxBodies);
  const byteLength = banksByteLength + (bankCount > 1 ? Int32Array.BYTES_PER_ELEMENT : 0);
  const buffer = useSAB ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
  if (bankCount > 1) new Int32Array(buffer, banksByteLength, 1)[0] = 1;
  return buffer;
}

/**
 * Physics-owned per-frame transform hot path. Interleaved layout
 * ([posX, posY, posZ, rotX, rotY, rotZ, rotW, linvelXYZ, angvelXYZ] x maxBodies), one slot per
 * live rigid body that isn't created `FIXED` (a fixed body never moves under simulation, so its
 * proxy keeps its own pose instead, p352), in one or more banks laid out as [slots][header].
 *
 * The worker is the allocation authority (allocateSlot/freeSlot tie to rigid
 * body creation/deletion there) and writes into it after every step(). The
 * main thread only ever wraps an existing buffer (SHARED_MEMORY: the same
 * SharedArrayBuffer; MESSAGE_BATCH: the latest received copy) and reads by
 * the slot number delivered in the rigid body's create response - it never
 * allocates its own slots. A slot number means the same slot in every bank.
 *
 * Banks: the worker writes into its back bank and the main thread reads its front bank
 * (chosen by latch()). With one bank (MESSAGE_BATCH, where every push is already a private
 * copy) they are the same bank. SHARED_MEMORY uses three, a lock-free triple buffer: a shared
 * middle bank is swapped with the back bank by publish() and with the front bank by latch(),
 * each in one atomic exchange of the control word, so neither side ever waits or reads a bank
 * the other is writing, and the main thread reads one complete, stamped snapshot per latch.
 */
export class PhysicsTransformBuffer {
  readonly maxBodies: number;
  readonly bankCount: number;
  /** Replaced only by rebind() (MESSAGE_BATCH main-thread copies). */
  buffer: ArrayBuffer | SharedArrayBuffer;
  /** Per-bank views, created once per buffer so that switching banks never allocates. */
  private bankFloats: Float32Array[] = [];
  /** Per-bank header: a write counter bumped once per worker write-back, and the step index
   * (steps executed on the current world) the written poses describe. The stamp makes each
   * snapshot self-describing — the main thread never has to reconstruct which step it is from
   * message bookkeeping (poses alone can't tell either: a body that didn't move reads identical). */
  private bankHeaders: Int32Array[] = [];
  /** The middle bank's index | CONTROL_FRESH (multi-bank buffers only). */
  private control?: Int32Array;
  /** Write-backs published so far (worker-side only; wraps harmlessly). */
  private writeCount = 0;
  /** The bank the worker writes (worker-side only). */
  private backBank: number;
  /** The bank the main thread reads (main-thread side only). */
  private frontBank = 0;
  private writeFloats!: Float32Array;
  private writeHeader!: Int32Array;
  private readFloats!: Float32Array;
  private readHeader!: Int32Array;

  private readonly slotById = new Map<number, number>();
  private readonly freeSlots: number[] = [];
  private liveCount = 0;

  constructor(maxBodies: number, buffer?: ArrayBuffer | SharedArrayBuffer, bankCount = 1) {
    if (bankCount !== 1 && bankCount !== PHYSICS_TRANSFORM_SHARED_BANKS) {
      throw new Error(
        `PhysicsTransformBuffer: bank count must be 1 or ${PHYSICS_TRANSFORM_SHARED_BANKS}, got ${bankCount}.`
      );
    }
    this.maxBodies = maxBodies;
    this.bankCount = bankCount;
    this.backBank = bankCount - 1;
    this.buffer = buffer ?? createPhysicsTransformArrayBuffer(maxBodies, false, bankCount);
    this.createViews();
  }

  private createViews(): void {
    const floatCount = this.maxBodies * PHYSICS_TRANSFORM_FIELD_COUNT;
    const bankBytes = getBankByteLength(this.maxBodies);
    this.bankFloats = [];
    this.bankHeaders = [];
    for (let b = 0; b < this.bankCount; b++) {
      const base = b * bankBytes;
      this.bankFloats.push(new Float32Array(this.buffer, base, floatCount));
      this.bankHeaders.push(
        new Int32Array(
          this.buffer,
          base + floatCount * Float32Array.BYTES_PER_ELEMENT,
          PHYSICS_TRANSFORM_HEADER_INTS
        )
      );
    }
    this.control =
      this.bankCount > 1 ? new Int32Array(this.buffer, this.bankCount * bankBytes, 1) : undefined;
    this.writeFloats = this.bankFloats[this.backBank];
    this.writeHeader = this.bankHeaders[this.backBank];
    this.readFloats = this.bankFloats[this.frontBank];
    this.readHeader = this.bankHeaders[this.frontBank];
  }

  /** Re-points this wrapper at another buffer of the same layout. For the MESSAGE_BATCH main
   * thread, which receives a fresh copy on every step: new views per step instead of a whole
   * new wrapper (with its own slot map). Main-thread only — the slot map isn't touched. */
  rebind(buffer: ArrayBuffer | SharedArrayBuffer): void {
    this.buffer = buffer;
    this.createViews();
  }

  /** Marks a completed write-back of all slots into the back bank, stamped with the step index
   * the poses describe. Worker-side only, called after each step batch — after every slot has
   * been written: the Atomics operations are the release fence for them. With three banks the
   * stamped back bank then becomes the middle one, and the worker takes the old middle bank
   * (never the one the main thread has latched) as its next back bank. */
  publish(stepIndex: number): void {
    this.writeCount = (this.writeCount + 1) | 0;
    Atomics.store(this.writeHeader, HEADER_STEP_INDEX, stepIndex);
    Atomics.store(this.writeHeader, HEADER_WRITE_COUNT, this.writeCount);
    if (!this.control) return;
    this.backBank =
      Atomics.exchange(this.control, 0, this.backBank | CONTROL_FRESH) & CONTROL_INDEX_MASK;
    // The new back bank holds an older snapshot: every live slot is rewritten by the next
    // write-back, and freed slots are only ever read through a pending creation pose.
    this.writeFloats = this.bankFloats[this.backBank];
    this.writeHeader = this.bankHeaders[this.backBank];
  }

  /** Makes the newest published snapshot the one every read returns until the next latch.
   * Main-thread only, once per frame before any reader (see latchPhysicsSnapshot). Returns
   * whether a new snapshot was latched. With one bank there is nothing to latch: reads see the
   * bank as it is. */
  latch(): boolean {
    if (!this.control) return false;
    // Only the main thread clears CONTROL_FRESH, so a set bit can't vanish before the exchange
    // (a publish in between just hands over an even newer bank, still fresh).
    if (!(Atomics.load(this.control, 0) & CONTROL_FRESH)) return false;
    this.frontBank = Atomics.exchange(this.control, 0, this.frontBank) & CONTROL_INDEX_MASK;
    this.readFloats = this.bankFloats[this.frontBank];
    this.readHeader = this.bankHeaders[this.frontBank];
    return true;
  }

  /** Step index of the latched snapshot (0 = nothing written yet). */
  getStepIndex(): number {
    return Atomics.load(this.readHeader, HEADER_STEP_INDEX);
  }

  /** Allocates (or returns the existing) slot for a rigid body id, or returns -1 when all
   * `maxBodies` slots are taken (the caller refuses the body). Worker-side only. */
  allocateSlot(id: number): number {
    const existing = this.slotById.get(id);
    if (existing !== undefined) return existing;

    let slot: number;
    if (this.freeSlots.length > 0) {
      const popped = this.freeSlots.pop();
      if (popped === undefined) {
        throw new Error('PhysicsTransformBuffer: freeSlots.pop() was undefined.');
      }
      slot = popped;
    } else {
      slot = this.liveCount;
    }
    if (slot >= this.maxBodies) return -1;
    if (slot === this.liveCount) this.liveCount++;
    this.slotById.set(id, slot);
    return slot;
  }

  /** Frees the slot for a rigid body id, if any, and zeroes it in the back bank: slots are
   * reused. The other banks keep the deleted body's pose there until a write-back reaches
   * them, which a new body never reads: its proxy returns its creation pose until a snapshot
   * stamped after its creation is latched. Worker-side only. */
  freeSlot(id: number): void {
    const slot = this.slotById.get(id);
    if (slot === undefined) return;
    this.slotById.delete(id);
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    this.writeFloats.fill(0, o, o + PHYSICS_TRANSFORM_FIELD_COUNT);
    this.freeSlots.push(slot);
  }

  /** Looks up the slot for a rigid body id, or -1 if it has none. */
  getSlot(id: number): number {
    return this.slotById.get(id) ?? -1;
  }

  /** Writes a pose into the back bank. Worker-side only. */
  setTransform(slot: number, pos: PhysVector, rot: PhysRotation): void {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.writeFloats;
    f[o] = pos.x;
    f[o + 1] = pos.y;
    f[o + 2] = pos.z;
    f[o + 3] = rot.x;
    f[o + 4] = rot.y;
    f[o + 5] = rot.z;
    f[o + 6] = rot.w;
  }

  /** Allocation-free pose read: [posX, posY, posZ, rotX, rotY, rotZ, rotW] into `out` at `offset`. */
  readPoseInto(slot: number, out: PoseArray, offset = 0): void {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.readFloats;
    for (let i = 0; i < 7; i++) out[offset + i] = f[o + i];
  }

  getPosition(slot: number): PhysVector {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.readFloats;
    return { x: f[o], y: f[o + 1], z: f[o + 2] };
  }

  getRotation(slot: number): PhysRotation {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.readFloats;
    return { x: f[o + 3], y: f[o + 4], z: f[o + 5], w: f[o + 6] };
  }

  /** Writes velocities into the back bank. Worker-side only. */
  setVelocity(slot: number, linvel: PhysVector, angvel: PhysVector): void {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.writeFloats;
    f[o + 7] = linvel.x;
    f[o + 8] = linvel.y;
    f[o + 9] = linvel.z;
    f[o + 10] = angvel.x;
    f[o + 11] = angvel.y;
    f[o + 12] = angvel.z;
  }

  /** Allocation-free velocity read: [linvelXYZ, angvelXYZ] into `out` at `offset`. */
  readVelocitiesInto(slot: number, out: PoseArray, offset = 0): void {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT + 7;
    const f = this.readFloats;
    for (let i = 0; i < 6; i++) out[offset + i] = f[o + i];
  }

  getLinvel(slot: number): PhysVector {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.readFloats;
    return { x: f[o + 7], y: f[o + 8], z: f[o + 9] };
  }

  getAngvel(slot: number): PhysVector {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    const f = this.readFloats;
    return { x: f[o + 10], y: f[o + 11], z: f[o + 12] };
  }
}
