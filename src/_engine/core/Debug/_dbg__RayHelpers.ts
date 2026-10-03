import * as THREE from 'three/webgpu';
import { createLines, preloadFatLineBackend, type LineObject } from '../LineManager';
import { lwarn } from '../../utils/Logger';
import { markDebugHelper } from '../../debug/Profiler';
import type { RayDebugOpts, RayHelperKind } from '../RayDebugTypes';

/**
 * The ray debug helper renderer, shared by every ray kind (Three.js rays, physics rays).
 *
 * A helper is a pooled thick line (the ray, plus a cross at the hit point). It is **active**
 * (solid, active color) while its ray is cast and for a minimum hold time after the last
 * cast, so one-frame rays stay readable, then **inactive** (dashed, inactive color, fading
 * out), then hidden and returned to its kind's free list. Lines are only created while a pool
 * grows and only disposed when a kind's helpers are turned off: none per frame.
 *
 * Every helper line pins the FAT backend (dashes), stays below opacity 1 (fading is then a
 * uniform write, never the transparent pipeline rebuild), and is `persistent`: this module
 * owns the lifetimes, a scene exit only recycles them (_clearRayHelpers).
 */

export type RayHelperKindSettings = {
  /** Draw this kind's helpers. Turning it off disposes the kind's pool. */
  show: boolean;
  /** Also draw the rays cast without `debug.id` (ids anon_0…anon_N in cast order per frame) */
  showAnonymous: boolean;
  /** Ignore the per-ray colors, to tell the kinds apart at a glance */
  forceKindColors: boolean;
  /** Respect depth: geometry in front hides the helpers. Off (default), they draw on top of
   * everything. A ray's own `debug.depthTest` overrides it. Changing it rebuilds the helpers'
   * pipelines once. */
  depthTest: boolean;
  activeColor: string;
  inactiveColor: string;
  /** Screen px */
  width: number;
  holdMs: number;
  fadeOutMs: number;
  /** Inactive dash pattern, screen px */
  dashPx: number;
  gapPx: number;
  /** World units, the length of each of the hit cross's three axis segments */
  hitMarkerSize: number;
  /** World units: a miss with an infinite (or longer) `far` draws this long */
  maxHelperLength: number;
  maxAnonymousHelpers: number;
  /** Live helpers per kind. Past it, the least recently cast inactive helper is recycled. */
  maxHelpers: number;
};

const DEFAULT_SETTINGS: Omit<RayHelperKindSettings, 'activeColor' | 'inactiveColor'> = {
  show: false,
  showAnonymous: false,
  forceKindColors: false,
  depthTest: false,
  width: 3,
  holdMs: 250,
  fadeOutMs: 1500,
  dashPx: 8,
  gapPx: 6,
  hitMarkerSize: 0.3,
  maxHelperLength: 1000,
  maxAnonymousHelpers: 32,
  maxHelpers: 256,
};

/** Just below 1, so a fade never crosses the opacity 1.0 pipeline rebuild. */
const MAX_OPACITY = 0.99;
/** Cast serial bits in a helper token (the rest is the helper's index). */
const SERIAL_RANGE = 2 ** 21;

type HelperState = 'ACTIVE' | 'INACTIVE' | 'FREE';

type Helper = {
  /** Stable per helper record, part of its tokens */
  readonly index: number;
  readonly pool: KindPool;
  readonly line: LineObject;
  id: string;
  state: HelperState;
  /** Incremented per cast: a token only updates the cast it was issued for */
  serial: number;
  lastCastMs: number;
  readonly origin: THREE.Vector3;
  readonly dir: THREE.Vector3;
  far: number;
  hitDistance: number | null;
  // Per-ray overrides (RayDebugOpts); undefined falls back to the kind's setting
  color: THREE.ColorRepresentation | undefined;
  inactiveColorOverride: THREE.ColorRepresentation | undefined;
  width: number | undefined;
  holdMs: number | undefined;
  fadeOutMs: number | undefined;
  showHit: boolean;
  depthTest: boolean | undefined;
  // Resolved style, and what the line currently has
  readonly activeColor: THREE.Color;
  readonly inactiveColor: THREE.Color;
  /** The kind's settings version this style was resolved at; -1 forces a re-resolve */
  styleVersion: number;
  appliedWidth: number;
  appliedDepthTest: boolean;
  /** Reused for every color/opacity write */
  readonly colorStyle: { type: 'STATIC'; color: THREE.Color; opacity: number };
};

type KindPool = {
  readonly kind: RayHelperKind;
  readonly settings: RayHelperKindSettings;
  /** Bumped on every settings change; live helpers re-resolve their style against it */
  version: number;
  readonly helpers: Map<string, Helper>;
  readonly free: Helper[];
  /** Anonymous rays drawn this frame */
  anonCount: number;
  warnedCap: boolean;
};

const createPool = (kind: RayHelperKind, activeColor: string, inactiveColor: string): KindPool => ({
  kind,
  settings: { ...DEFAULT_SETTINGS, activeColor, inactiveColor },
  version: 0,
  helpers: new Map(),
  free: [],
  anonCount: 0,
  warnedCap: false,
});

const pools: Record<RayHelperKind, KindPool> = {
  THREE: createPool('THREE', '#ff3b30', '#7a2a26'),
  PHYSICS: createPool('PHYSICS', '#30d5ff', '#1f5f73'),
};
const POOL_LIST = [pools.THREE, pools.PHYSICS];

/** Every helper record by index, for tokens */
const helpersByIndex = new Map<number, Helper>();
let nextHelperIndex = 1;
/** anon_0…anon_N, built once */
const anonIds: string[] = [];
/** True once the FAT backend has loaded (or failed to): until then casts draw nothing */
let linesReady = false;
let linesLoading = false;

const scratchEnd = new THREE.Vector3();

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

/** A kind's live settings object (Ray cast controls tab). Change it with setRayHelperSettings. */
export const getRayHelperSettings = (kind: RayHelperKind): Readonly<RayHelperKindSettings> =>
  pools[kind].settings;

/** Changes a kind's settings. Live helpers pick up the new style on the next frame; turning
 * `show` off disposes the kind's pool. */
export const setRayHelperSettings = (
  kind: RayHelperKind,
  patch: Partial<RayHelperKindSettings>
) => {
  const pool = pools[kind];
  const wasShown = pool.settings.show;
  Object.assign(pool.settings, patch);
  pool.version++;
  if (pool.settings.show && !wasShown) {
    loadLines();
  } else if (!pool.settings.show && wasShown) {
    disposePool(pool);
  }
};

const loadLines = () => {
  if (linesReady || linesLoading) return;
  linesLoading = true;
  // Without it the pinned-FAT lines would start 1px and swap backends when the chunk arrives.
  // A failed load still lets them draw (solid, 1px).
  void preloadFatLineBackend().then(() => {
    linesLoading = false;
    linesReady = true;
  });
};

// ----------------------------------------------------------------------------
// Drawing
// ----------------------------------------------------------------------------

/**
 * Draws (or refreshes) a ray's helper: origin → hit, or origin → `far` on a miss (capped at
 * the kind's maxHelperLength). A ray without `opts` is drawn only when the kind shows
 * anonymous rays. Called per cast; it rewrites the geometry, never the pool.
 * @returns (number) a token for _updateRayHit, or 0 when nothing was drawn
 */
export const _drawRay = (
  kind: RayHelperKind,
  origin: THREE.Vector3Like,
  dir: THREE.Vector3Like,
  far: number,
  hitDistance: number | null,
  opts: RayDebugOpts | undefined,
  nowMs: number
): number => {
  const pool = pools[kind];
  const s = pool.settings;
  if (!s.show || !linesReady) return 0;

  let id = opts?.id;
  if (!id) {
    if (!s.showAnonymous || pool.anonCount >= s.maxAnonymousHelpers) return 0;
    id = anonIds[pool.anonCount] ??= `anon_${pool.anonCount}`;
    pool.anonCount++;
  }

  const helper = pool.helpers.get(id) ?? acquireHelper(pool, id);
  if (!helper) return 0;

  if (copyOverrides(helper, opts)) helper.styleVersion = -1;
  helper.origin.copy(origin);
  helper.dir.copy(dir);
  helper.far = far;
  helper.hitDistance = hitDistance;
  writeGeometry(pool, helper);

  helper.lastCastMs = nowMs;
  helper.serial = (helper.serial + 1) % SERIAL_RANGE;
  // Right away, not on the next update pass: this frame renders before that
  if (helper.state !== 'ACTIVE' || helper.styleVersion !== pool.version) {
    applyActiveStyle(pool, helper);
  }
  return helper.index * SERIAL_RANGE + helper.serial;
};

/** Sets the hit of an already drawn cast whose result arrived later (async physics casts).
 * A no-op when the helper has been cast again or recycled since. */
export const _updateRayHit = (token: number, hitDistance: number | null) => {
  if (!token) return;
  const helper = helpersByIndex.get(Math.floor(token / SERIAL_RANGE));
  if (!helper || helper.state === 'FREE' || helper.serial !== token % SERIAL_RANGE) return;
  helper.hitDistance = hitDistance;
  writeGeometry(helper.pool, helper);
};

/** Once per rendered frame (Raycast.ts's LATE_MAIN frame end): moves every helper through
 * active → inactive (fading) → recycled. Style writes happen on state changes only, plus
 * the opacity while fading. `performance.now()` time, so helpers fade while paused too. */
export const _updateRayHelpers = (nowMs: number) => {
  for (let i = 0; i < POOL_LIST.length; i++) {
    const pool = POOL_LIST[i];
    pool.anonCount = 0;
    for (const helper of pool.helpers.values()) updateHelper(pool, helper, nowMs);
  }
};

/** Hides and recycles every helper (of one kind, or all). Disposes nothing. */
export const _clearRayHelpers = (kind?: RayHelperKind) => {
  for (let i = 0; i < POOL_LIST.length; i++) {
    const pool = POOL_LIST[i];
    if (kind && pool.kind !== kind) continue;
    for (const helper of pool.helpers.values()) recycleHelper(pool, helper);
    pool.anonCount = 0;
  }
};

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

const updateHelper = (pool: KindPool, helper: Helper, nowMs: number) => {
  const s = pool.settings;
  const holdMs = helper.holdMs ?? s.holdMs;
  const fadeOutMs = helper.fadeOutMs ?? s.fadeOutMs;
  const age = nowMs - helper.lastCastMs;

  if (age <= holdMs) {
    if (helper.state !== 'ACTIVE' || helper.styleVersion !== pool.version) {
      applyActiveStyle(pool, helper);
    }
    return;
  }
  if (age < holdMs + fadeOutMs) {
    if (helper.state !== 'INACTIVE' || helper.styleVersion !== pool.version) {
      resolveStyle(pool, helper);
      helper.line.setDash(s.dashPx, s.gapPx);
      helper.colorStyle.color = helper.inactiveColor;
      helper.state = 'INACTIVE';
    }
    helper.colorStyle.opacity = MAX_OPACITY * (1 - (age - holdMs) / fadeOutMs);
    helper.line.setColorStyle(helper.colorStyle);
    return;
  }
  recycleHelper(pool, helper);
};

const applyActiveStyle = (pool: KindPool, helper: Helper) => {
  resolveStyle(pool, helper);
  helper.line.setDash(pool.settings.dashPx, 0);
  helper.colorStyle.color = helper.activeColor;
  helper.colorStyle.opacity = MAX_OPACITY;
  helper.line.setColorStyle(helper.colorStyle);
  helper.state = 'ACTIVE';
};

/** Resolves the per-ray overrides against the kind's settings, and pushes width/depth test
 * to the line when they changed (depth test rebuilds the pipeline). */
const resolveStyle = (pool: KindPool, helper: Helper) => {
  const s = pool.settings;
  const usePerRay = !s.forceKindColors;
  helper.activeColor.set(usePerRay && helper.color !== undefined ? helper.color : s.activeColor);
  helper.inactiveColor.set(
    usePerRay && helper.inactiveColorOverride !== undefined
      ? helper.inactiveColorOverride
      : s.inactiveColor
  );
  const width = helper.width ?? s.width;
  if (width !== helper.appliedWidth) {
    helper.appliedWidth = width;
    helper.line.setWidth(width);
  }
  const depthTest = helper.depthTest ?? s.depthTest;
  if (depthTest !== helper.appliedDepthTest) {
    helper.appliedDepthTest = depthTest;
    helper.line.setDepthTest(depthTest);
  }
  helper.styleVersion = pool.version;
};

/** Copies a cast's options into the helper. Returns true when a style input changed (a
 * Color object always counts, it may have been mutated in place). */
const copyOverrides = (helper: Helper, opts: RayDebugOpts | undefined) => {
  const color = opts?.color;
  const inactiveColor = opts?.inactiveColor;
  const width = opts?.width;
  const depthTest = opts?.depthTest;
  const changed =
    color !== helper.color ||
    inactiveColor !== helper.inactiveColorOverride ||
    typeof color === 'object' ||
    typeof inactiveColor === 'object' ||
    width !== helper.width ||
    depthTest !== helper.depthTest;
  helper.color = color;
  helper.inactiveColorOverride = inactiveColor;
  helper.width = width;
  helper.depthTest = depthTest;
  helper.holdMs = opts?.holdMs;
  helper.fadeOutMs = opts?.fadeOutMs;
  helper.showHit = opts?.showHit ?? true;
  return changed;
};

/** The ray segment, plus a three-axis cross at the hit. */
const writeGeometry = (pool: KindPool, helper: Helper) => {
  const s = pool.settings;
  const { origin, dir, hitDistance } = helper;
  const length = hitDistance ?? Math.min(helper.far, s.maxHelperLength);
  const end = scratchEnd.copy(dir).multiplyScalar(length).add(origin);
  const w = helper.line.beginWrite();
  w.vec(origin, end);
  if (hitDistance !== null && helper.showHit) {
    const h = s.hitMarkerSize / 2;
    const { x, y, z } = end;
    w.segment(x - h, y, z, x + h, y, z);
    w.segment(x, y - h, z, x, y + h, z);
    w.segment(x, y, z - h, x, y, z + h);
  }
  helper.line.endWrite();
};

/** A helper for a new id: from the free list, or a new line. At the cap, the least recently
 * cast inactive helper is recycled first; with none inactive, nothing is drawn. */
const acquireHelper = (pool: KindPool, id: string): Helper | null => {
  if (pool.helpers.size >= pool.settings.maxHelpers) {
    let oldest: Helper | null = null;
    for (const helper of pool.helpers.values()) {
      if (helper.state !== 'INACTIVE') continue;
      if (!oldest || helper.lastCastMs < oldest.lastCastMs) oldest = helper;
    }
    if (!pool.warnedCap) {
      pool.warnedCap = true;
      lwarn(
        `[RayHelpers] More than ${pool.settings.maxHelpers} ${pool.kind} ray helpers at once: inactive ones are recycled early, and new ones are skipped while all are active (warned once).`
      );
    }
    if (!oldest) return null;
    recycleHelper(pool, oldest);
  }

  const helper = pool.free.pop() ?? createHelper(pool);
  helper.id = id;
  helper.state = 'FREE';
  helper.line.setVisible(true);
  pool.helpers.set(id, helper);
  return helper;
};

const createHelper = (pool: KindPool): Helper => {
  const s = pool.settings;
  const index = nextHelperIndex++;
  const line = createLines({
    name: `rayHelper_${pool.kind}_${index}`,
    capacity: 4,
    growth: 'FIXED',
    backend: 'FAT',
    width: s.width,
    dash: { dashPx: s.dashPx, gapPx: 0 },
    color: s.activeColor,
    opacity: MAX_OPACITY,
    depthTest: false,
    // This module owns the lifetime (recycled on scene exit, disposed when turned off)
    persistent: true,
    attach: { to: 'ROOT_SCENE' },
    visible: false,
  });
  markDebugHelper(line.object3D);
  const activeColor = new THREE.Color(s.activeColor);
  const helper: Helper = {
    index,
    pool,
    line,
    id: '',
    state: 'FREE',
    serial: 0,
    lastCastMs: 0,
    origin: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    far: 0,
    hitDistance: null,
    color: undefined,
    inactiveColorOverride: undefined,
    width: undefined,
    holdMs: undefined,
    fadeOutMs: undefined,
    showHit: true,
    depthTest: undefined,
    activeColor,
    inactiveColor: new THREE.Color(s.inactiveColor),
    styleVersion: -1,
    appliedWidth: s.width,
    appliedDepthTest: false,
    colorStyle: { type: 'STATIC', color: activeColor, opacity: MAX_OPACITY },
  };
  helpersByIndex.set(index, helper);
  return helper;
};

const recycleHelper = (pool: KindPool, helper: Helper) => {
  helper.line.setVisible(false);
  helper.state = 'FREE';
  pool.helpers.delete(helper.id);
  pool.free.push(helper);
};

const disposePool = (pool: KindPool) => {
  for (const helper of pool.helpers.values()) disposeHelper(helper);
  for (let i = 0; i < pool.free.length; i++) disposeHelper(pool.free[i]);
  pool.helpers.clear();
  pool.free.length = 0;
  pool.anonCount = 0;
};

const disposeHelper = (helper: Helper) => {
  helper.line.dispose();
  helpersByIndex.delete(helper.index);
};
