import { PhysRotation, PhysVector } from './PhysicsAPITypes';

/** Float32 fields per slot: position(3) + quaternion(4) + linvel(3) + angvel(3). */
export const PHYSICS_TRANSFORM_FIELD_COUNT = 13;

/**
 * Allocates the backing buffer for a PhysicsTransformBuffer. Physics-owned and
 * independent of ECS's TypedArrayTransformStore (see p021 §3.3) so worker-thread
 * physics doesn't require ecs.storageMode: 'TYPED_ARRAY' as a prerequisite.
 */
export function createPhysicsTransformArrayBuffer(
  maxBodies: number,
  useSAB = false
): ArrayBuffer | SharedArrayBuffer {
  const byteLength = maxBodies * PHYSICS_TRANSFORM_FIELD_COUNT * Float32Array.BYTES_PER_ELEMENT;
  return useSAB ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
}

/**
 * Physics-owned per-frame transform hot path. Interleaved layout
 * ([posX, posY, posZ, rotX, rotY, rotZ, rotW] x maxBodies), one slot per live
 * dynamic rigid body.
 *
 * The worker is the allocation authority (allocateSlot/freeSlot tie to rigid
 * body creation/deletion there) and writes into it after every step(). The
 * main thread only ever wraps an existing buffer (SHARED_MEMORY: the same
 * SharedArrayBuffer; MESSAGE_BATCH: the latest received copy) and reads by
 * the slot number delivered in the rigid body's create response - it never
 * allocates its own slots.
 */
export class PhysicsTransformBuffer {
  readonly maxBodies: number;
  readonly buffer: ArrayBuffer | SharedArrayBuffer;
  readonly floats: Float32Array;

  private readonly slotById = new Map<number, number>();
  private readonly freeSlots: number[] = [];
  private liveCount = 0;

  constructor(maxBodies: number, buffer?: ArrayBuffer | SharedArrayBuffer) {
    this.maxBodies = maxBodies;
    this.buffer = buffer ?? createPhysicsTransformArrayBuffer(maxBodies, false);
    this.floats = new Float32Array(this.buffer);
  }

  /** Allocates (or returns the existing) slot for a rigid body id. Worker-side only. */
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
    if (slot >= this.maxBodies) {
      throw new Error(
        `PhysicsTransformBuffer capacity (${this.maxBodies}) exceeded — raise AppConfig.physics.maxBodies`
      );
    }
    if (slot === this.liveCount) this.liveCount++;
    this.slotById.set(id, slot);
    return slot;
  }

  /** Frees the slot for a rigid body id, if any. Worker-side only. */
  freeSlot(id: number): void {
    const slot = this.slotById.get(id);
    if (slot === undefined) return;
    this.slotById.delete(id);
    this.freeSlots.push(slot);
  }

  /** Looks up the slot for a rigid body id, or -1 if it has none. */
  getSlot(id: number): number {
    return this.slotById.get(id) ?? -1;
  }

  setTransform(slot: number, pos: PhysVector, rot: PhysRotation): void {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    this.floats[o] = pos.x;
    this.floats[o + 1] = pos.y;
    this.floats[o + 2] = pos.z;
    this.floats[o + 3] = rot.x;
    this.floats[o + 4] = rot.y;
    this.floats[o + 5] = rot.z;
    this.floats[o + 6] = rot.w;
  }

  getPosition(slot: number): PhysVector {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    return { x: this.floats[o], y: this.floats[o + 1], z: this.floats[o + 2] };
  }

  getRotation(slot: number): PhysRotation {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    return {
      x: this.floats[o + 3],
      y: this.floats[o + 4],
      z: this.floats[o + 5],
      w: this.floats[o + 6],
    };
  }

  setVelocity(slot: number, linvel: PhysVector, angvel: PhysVector): void {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    this.floats[o + 7] = linvel.x;
    this.floats[o + 8] = linvel.y;
    this.floats[o + 9] = linvel.z;
    this.floats[o + 10] = angvel.x;
    this.floats[o + 11] = angvel.y;
    this.floats[o + 12] = angvel.z;
  }

  getLinvel(slot: number): PhysVector {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    return { x: this.floats[o + 7], y: this.floats[o + 8], z: this.floats[o + 9] };
  }

  getAngvel(slot: number): PhysVector {
    const o = slot * PHYSICS_TRANSFORM_FIELD_COUNT;
    return { x: this.floats[o + 10], y: this.floats[o + 11], z: this.floats[o + 12] };
  }
}
