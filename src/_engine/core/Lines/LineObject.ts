import * as THREE from 'three/webgpu';
import { getRootScene } from '../Scene';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { existsOrThrow } from '../../utils/assert';
import { lwarn } from '../../utils/Logger';
import {
  getFatLineBackendFactory,
  loadFatLineBackend,
  resolveLineBackendKind,
  type LineBackend,
  type LineColorNode,
} from './LineBackend';
import { createThinLineBackend } from './LineBackendThin';
import {
  colorGraphKey,
  createLineColorNode,
  createLineColorUniforms,
  hashLinePhase,
  LINE_PULSE_MAX_COLORS,
} from './LinePulse';
import { releaseLineEntity, repointLineEntity, type LineEntityBinding } from './LineEntity';
import { unregisterLine } from './LineRegistry';
import type {
  LineAttachment,
  LineBackendChoice,
  LineBackendKind,
  LineColorStyle,
  LineGrowth,
  LineLocalTransform,
  LineProps,
} from './LineTypes';
import { FLOATS_PER_SEGMENT, LineWriter, type LineWriteTarget } from './LineWriter';

const DEFAULT_CAPACITY = 64;

const scratchBox = new THREE.Box3();
const scratchSphere = new THREE.Sphere();

/** The segment buffer and its growth policy. Never shrinks. */
class LineBuffer implements LineWriteTarget {
  positions: Float32Array;

  constructor(
    capacity: number,
    private readonly growth: LineGrowth,
    private readonly onReallocate: (positions: Float32Array) => void,
    private readonly onOverflow: () => void
  ) {
    this.positions = new Float32Array(Math.max(1, capacity) * FLOATS_PER_SEGMENT);
  }

  reserve(floatCount: number) {
    if (floatCount <= this.positions.length) return true;
    if (this.growth === 'FIXED') {
      this.onOverflow();
      return false;
    }
    this.reallocate(Math.max(floatCount, this.positions.length * 2));
    return true;
  }

  reallocate(floatCount: number) {
    const next = new Float32Array(floatCount);
    next.set(this.positions);
    this.positions = next;
    this.onReallocate(next);
  }
}

/**
 * A line-segment object: a handle usable from any gameplay code, no ECS world involved.
 * Create one with `createLines` (LineManager).
 *
 * Two ways to feed it:
 * - **Build once**: pass `segments` in the props, or call `setSegments`, and move it with
 *   `setLocalTransform`/its parent from then on.
 * - **Refill per frame**: pre-allocate `capacity`, then every frame
 *   `beginWrite()` → write segments → `endWrite()`. This writes into the retained buffer
 *   and uploads only what was written: no allocation, no GPU buffer re-creation. Use
 *   `growth: 'FIXED'` when the ceiling is known, so an overflow can never reallocate
 *   mid-game.
 *
 * **Width and backends.** Lines wider than 1px (or pinned to `backend: 'FAT'`) are drawn
 * by a thick-line backend that is loaded on demand. Until it has loaded, such a line draws
 * 1px wide and upgrades itself when it arrives — call `preloadFatLineBackend()` (and await
 * it) before creating lines whose width must be right on their first frame. A later
 * `setWidth` that crosses 1px on an `'AUTO'` line swaps backends; pin `'FAT'` for a width
 * that is dragged live across that boundary.
 *
 * **`object3D` is not stable across a backend swap** — always read the getter, never keep
 * the object. The new one takes the old one's place (same parent, same child index,
 * transform, visibility, name, userData and children).
 */
export class LineObject {
  readonly id: string;
  /** Kept on scene switches (see LineProps.persistent). */
  readonly persistent: boolean;
  /** @internal Set by LineManager while an entity owns this line. */
  entityBinding: LineEntityBinding | null = null;
  private backend: LineBackend;
  private readonly buffer: LineBuffer;
  private readonly writer: LineWriter;
  private readonly backendChoice: LineBackendChoice;
  private segments = 0;
  private writing = false;
  private disposed = false;

  /** The only writer of this line's colour: setColor and pulses both write these. */
  private readonly colorUniforms = createLineColorUniforms();
  private colorGraph = '';
  private colorNode: LineColorNode = this.colorUniforms.colors[0];
  private width: number;
  private depthTest: boolean;
  private readonly recomputeBounds: boolean;
  private boundsComputed = false;

  private warnedOverflow = false;
  private warnedPalette = false;
  private warnedStaleBounds = false;

  /** @internal Use `createLines`. */
  constructor(id: string, props: LineProps) {
    this.id = id;
    this.persistent = props.persistent ?? false;
    this.backendChoice = props.backend ?? 'AUTO';
    this.colorUniforms.opacity.value = clampOpacity(props.opacity ?? 1);
    this.writeColorStyle(props.colorStyle ?? { type: 'STATIC', color: props.color ?? 0xffffff });
    this.width = props.width ?? 1;
    this.depthTest = props.depthTest ?? true;
    this.recomputeBounds = props.recomputeBounds ?? false;

    const initialSegments = props.segments
      ? Math.floor(props.segments.length / FLOATS_PER_SEGMENT)
      : 0;
    this.buffer = new LineBuffer(
      props.capacity ?? (initialSegments || DEFAULT_CAPACITY),
      props.growth ?? 'GROW',
      (positions) => this.backend.setPositions(positions),
      () => this.warnOverflow()
    );
    this.writer = new LineWriter(this.buffer);

    this.backend = this.createBackend(this.targetBackendKind());
    const obj = this.backend.object3D;
    obj.name = props.name ?? id;
    obj.userData.lineId = id;
    obj.visible = props.visible ?? true;
    obj.renderOrder = props.renderOrder ?? 0;
    obj.frustumCulled = props.frustumCulled ?? false;
    this.applyStateToBackend();

    if (props.localTransform) this.setLocalTransform(props.localTransform);
    this.attach(props.attach ?? { to: 'ROOT_SCENE' });

    if (props.segments) this.setSegments(props.segments);
    this.syncBackend();
  }

  /** The current renderer's Object3D. Not stable across a backend swap — never cache it. */
  get object3D() {
    return this.backend.object3D;
  }

  /** The backend currently rendering this line. */
  get backendKind(): LineBackendKind {
    return this.backend.kind;
  }

  /** The backend choice this line was created with. */
  get requestedBackend() {
    return this.backendChoice;
  }

  /** Allocated room, in segments. */
  get capacity() {
    return this.buffer.positions.length / FLOATS_PER_SEGMENT;
  }

  /** Segments drawn, as of the last `endWrite`. */
  get segmentCount() {
    return this.segments;
  }

  get isDisposed() {
    return this.disposed;
  }

  // --------------------------------------------------------------------------
  // Segments
  // --------------------------------------------------------------------------

  /** Starts a refill: returns this line's reusable writer, reset to the first segment.
   * Nothing is drawn differently until `endWrite`. */
  beginWrite() {
    this.writing = true;
    return this.writer.reset();
  }

  /** Commits the refill: uploads exactly the segments written and draws only those. */
  endWrite() {
    if (!this.writing) {
      lwarn(`[Lines] endWrite() without beginWrite() on line "${this.id}". Nothing committed.`);
      return;
    }
    this.writing = false;
    if (this.disposed) return;
    this.commit(this.writer.segmentCount);
  }

  /** Replaces every segment with a flat `xyzxyz` list — a one-shot beginWrite/endWrite. */
  setSegments(segments: ArrayLike<number>) {
    this.beginWrite().raw(segments);
    this.endWrite();
  }

  /** Grows the buffer to hold at least `segmentCount` segments (regardless of `growth`).
   * Never shrinks. Reallocates, so do it up front rather than per frame. */
  ensureCapacity(segmentCount: number) {
    const floatCount = segmentCount * FLOATS_PER_SEGMENT;
    if (floatCount > this.buffer.positions.length) this.buffer.reallocate(floatCount);
  }

  // --------------------------------------------------------------------------
  // Appearance
  // --------------------------------------------------------------------------

  /** Sets a static colour, and optionally the opacity (0..1) — the one-colour case of
   * `setColorStyle`, stopping any pulse. Always writes: there is no equal-value elision
   * here, so callers that elide their own writes stay in control. */
  setColor(color: THREE.ColorRepresentation, opacity?: number) {
    this.setColorStyle({ type: 'STATIC', color, opacity });
  }

  /**
   * Sets a static colour or a pulse through up to 4 colours (see LinePulse.ts for the
   * blend). Colour values are uniform writes; only switching between static and pulsing,
   * or to another easing/mode, rebuilds the pipeline.
   */
  setColorStyle(style: LineColorStyle) {
    if (this.writeColorStyle(style)) {
      this.backend.setColorNodes(this.colorNode, this.colorUniforms.opacity);
    }
    this.backend.setTransparent(this.colorUniforms.opacity.value < 1);
  }

  /** Line width in screen pixels. A uniform write, unless it moves an `'AUTO'` line across
   * 1px, which swaps backends (see the class docs). */
  setWidth(width: number) {
    this.width = width;
    this.backend.setWidth(width);
    this.syncBackend();
  }

  setVisible(visible: boolean) {
    this.backend.object3D.visible = visible;
  }

  /** False draws the line on top of whatever would hide it. Rebuilds the pipeline. */
  setDepthTest(depthTest: boolean) {
    this.depthTest = depthTest;
    this.backend.setDepthTest(depthTest);
  }

  // --------------------------------------------------------------------------
  // Placement
  // --------------------------------------------------------------------------

  /** Moves the line to a new parent, per the attachment policy. */
  attach(attachment: LineAttachment) {
    const obj = this.backend.object3D;
    obj.removeFromParent();
    switch (attachment.to) {
      case 'ROOT_SCENE':
        existsOrThrow(getRootScene(), `No root scene to attach line "${this.id}" to.`).add(obj);
        break;
      case 'PARENT':
        attachment.parent.add(obj);
        break;
      case 'ENTITY': {
        const world = attachment.world ?? getECSWorld();
        existsOrThrow(
          world.getComponent(attachment.entityId, ComponentType.OBJECT3D)?.value,
          `Entity ${attachment.entityId} has no Object3D to attach line "${this.id}" to.`
        ).add(obj);
        break;
      }
      case 'NONE':
        break;
    }
  }

  /** The line's transform relative to what it is attached to. Omitted parts are kept. On a
   * line entity (createLineEntity) the ECS transform owns this — use setTransform. */
  setLocalTransform(transform: LineLocalTransform) {
    const obj = this.backend.object3D;
    if (transform.position) obj.position.copy(transform.position);
    if (transform.quaternion) obj.quaternion.copy(transform.quaternion);
    if (transform.scale) obj.scale.copy(transform.scale);
  }

  /** Removes the line from the scene and frees its GPU resources. Idempotent. A line entity
   * (createLineEntity) is deleted with it; a bound entity loses its LINE component. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const binding = this.entityBinding;
    this.entityBinding = null;
    this.backend.dispose();
    unregisterLine(this.id);
    if (binding) releaseLineEntity(binding);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private targetBackendKind() {
    return resolveLineBackendKind(this.backendChoice, this.width);
  }

  /** A FAT backend when wanted and loaded, THIN otherwise. */
  private createBackend(kind: LineBackendKind) {
    const createFat = kind === 'FAT' ? getFatLineBackendFactory() : null;
    return createFat
      ? createFat(this.buffer.positions)
      : createThinLineBackend(this.buffer.positions);
  }

  /** Moves the line onto the backend its choice and width call for: now when that backend
   * is at hand, or once the FAT one has loaded. */
  private syncBackend() {
    const target = this.targetBackendKind();
    if (this.disposed || target === this.backend.kind) return;
    if (target === 'THIN' || getFatLineBackendFactory()) {
      this.swapBackend(this.createBackend(target));
      return;
    }
    void loadFatLineBackend().then((loaded) => {
      if (loaded) this.syncBackend();
    });
  }

  private swapBackend(next: LineBackend) {
    const prev = this.backend;
    const from = prev.object3D;
    const to = next.object3D;

    to.name = from.name;
    to.userData = from.userData;
    to.visible = from.visible;
    to.renderOrder = from.renderOrder;
    to.frustumCulled = from.frustumCulled;
    to.layers.mask = from.layers.mask;
    to.matrixAutoUpdate = from.matrixAutoUpdate;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.scale.copy(from.scale);
    to.matrix.copy(from.matrix);
    for (const child of [...from.children]) to.add(child);

    // Take the old object's place, at the same child index
    const parent = from.parent;
    if (parent) {
      const index = parent.children.indexOf(from);
      from.removeFromParent();
      parent.add(to);
      parent.children.splice(parent.children.indexOf(to), 1);
      parent.children.splice(index, 0, to);
    }

    this.backend = next;
    if (this.entityBinding) repointLineEntity(this.entityBinding, from, to);
    this.applyStateToBackend();
    next.commit(this.segments);
    if (this.boundsComputed) this.updateBounds();
    prev.dispose();
  }

  private commit(segmentCount: number) {
    this.segments = segmentCount;
    this.backend.commit(segmentCount);
    if (this.recomputeBounds || !this.boundsComputed) {
      this.updateBounds();
    } else if (this.backend.object3D.frustumCulled && !this.warnedStaleBounds) {
      this.warnedStaleBounds = true;
      lwarn(
        `[Lines] Line "${this.id}" is frustum culled and was refilled, but its bounds are only computed on the first commit. It may be culled while on screen — create it with recomputeBounds: true.`
      );
    }
  }

  /** Tight bounds over the committed segments only (three's own compute would include the
   * unused tail of the buffer). */
  private updateBounds() {
    this.boundsComputed = true;
    const p = this.buffer.positions;
    const floatCount = this.segments * FLOATS_PER_SEGMENT;
    const box = scratchBox.makeEmpty();
    for (let i = 0; i < floatCount; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      if (x < box.min.x) box.min.x = x;
      if (y < box.min.y) box.min.y = y;
      if (z < box.min.z) box.min.z = z;
      if (x > box.max.x) box.max.x = x;
      if (y > box.max.y) box.max.y = y;
      if (z > box.max.z) box.max.z = z;
    }
    const sphere = scratchSphere;
    if (box.isEmpty()) {
      sphere.makeEmpty();
    } else {
      box.getCenter(sphere.center);
      const { x: cx, y: cy, z: cz } = sphere.center;
      let maxDistSq = 0;
      for (let i = 0; i < floatCount; i += 3) {
        const dx = p[i] - cx;
        const dy = p[i + 1] - cy;
        const dz = p[i + 2] - cz;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > maxDistSq) maxDistSq = distSq;
      }
      sphere.radius = Math.sqrt(maxDistSq);
    }
    this.backend.setBounds(box, sphere);
  }

  /** Pushes every piece of owned state into the current backend. */
  private applyStateToBackend() {
    this.backend.setColorNodes(this.colorNode, this.colorUniforms.opacity);
    this.backend.setTransparent(this.colorUniforms.opacity.value < 1);
    this.backend.setWidth(this.width);
    this.backend.setDepthTest(this.depthTest);
  }

  /** Writes a style into the colour uniforms. Returns true when it needs a different
   * colour graph than the current one (which it then builds). */
  private writeColorStyle(style: LineColorStyle) {
    const u = this.colorUniforms;
    if (style.type === 'STATIC') {
      u.colors[0].value.set(style.color);
      u.count.value = 1;
      u.speed.value = 0;
    } else {
      if (!style.colors.length) {
        lwarn(`[Lines] Pulse without colours on line "${this.id}". Colour unchanged.`);
        return false;
      }
      if (style.colors.length > LINE_PULSE_MAX_COLORS && !this.warnedPalette) {
        this.warnedPalette = true;
        lwarn(
          `[Lines] Line "${this.id}" pulses through ${style.colors.length} colours; only the first ${LINE_PULSE_MAX_COLORS} are used.`
        );
      }
      const count = Math.min(style.colors.length, LINE_PULSE_MAX_COLORS);
      for (let i = 0; i < count; i++) u.colors[i].value.set(style.colors[i]);
      u.count.value = count;
      u.speed.value = style.speed;
      const phase = (style.phase ?? 0) + (style.autoPhase ? hashLinePhase(this.id) : 0);
      u.phase.value = phase - Math.floor(phase);
    }
    if (style.opacity !== undefined) u.opacity.value = clampOpacity(style.opacity);

    const graph = colorGraphKey(style);
    if (graph === this.colorGraph) return false;
    this.colorGraph = graph;
    this.colorNode = createLineColorNode(u, style);
    return true;
  }

  private warnOverflow() {
    if (this.warnedOverflow) return;
    this.warnedOverflow = true;
    lwarn(
      `[Lines] Line "${this.id}" is FIXED at ${this.capacity} segments; segments past that are dropped (warned once per line).`
    );
  }
}

const clampOpacity = (opacity: number) => Math.min(1, Math.max(0, opacity));
