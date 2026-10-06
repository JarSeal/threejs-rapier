// Physics determinism probe (p101 P0). Freezes the simulation N fixed steps after a scene
// enters, hashes every dynamic body's physics state, and diffs it against the last run of the
// same scene and N, so a fresh load and a revisit (or two worker targets) can be compared.
//
// Arm with `?physicsProbe=N` (armed from the first scene on) or from the Physics API debug tab.
// Once armed, it re-runs on every scene enter until disarmed.

import { getECSWorld, getStableAppId } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import type { IComponentStorage } from '../ECS/ECSComponentStorage';
import {
  getPhysicsSnapshotStepIndex,
  getPhysicsState,
  getResolvedTransportMode,
  setPhysicsStepLimit,
} from '../PhysicsAPI';
import type { RigidBodyAPI } from '../Physics/PhysicsAPITypes';
import type { PhysicsTier } from '../Physics/PhysicsTierTypes';
import { getCurrentSceneId, registerOnAllSceneEnterings, registerOnAllSceneExits } from '../Scene';
import { getCharacters } from '../Character';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { llog, lwarn } from '../../utils/Logger';

const LS_KEY = 'AEK_debugPhysicsProbeRuns';
const URL_PARAM = 'physicsProbe';

type ProbeBody = {
  /** appId, or `#k` = the k-th keyless body in creation (rigid body id) order */
  key: string;
  name: string;
  entityId: number;
  /** Float32-rounded [pos xyz, rot xyzw, linvel xyz, angvel xyz], plus the physics tier's index
   * (TIER_INDEX) for an entity that has one, so scenes without tiers keep their hashes */
  values: number[];
};

type StoredRun = {
  hash: string;
  config: string;
  at: string;
  bodies: { key: string; values: number[] }[];
};

type ActiveRun = {
  sceneId: string;
  steps: number;
  startStep: number;
  targetStep: number;
  rafId: number;
};

/** Steps to probe on every scene enter; null = disarmed. */
let armedSteps: number | null = null;
let activeRun: ActiveRun | null = null;

// FNV-1a (32-bit) over each Float32's bit pattern and each key's char codes.
const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const fnvWord = (hash: number, word: number) => {
  let h = hash;
  for (let i = 0; i < 4; i++) {
    h ^= (word >>> (i * 8)) & 0xff;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
};

const hashBodies = (bodies: ProbeBody[]) => {
  let h = FNV_OFFSET;
  for (const body of bodies) {
    for (let i = 0; i < body.key.length; i++) h = fnvWord(h, body.key.charCodeAt(i));
    for (const value of body.values) {
      f32[0] = value;
      h = fnvWord(h, f32Bits[0]);
    }
  }
  return h.toString(16).padStart(8, '0');
};

const readBodyValues = (rb: RigidBodyAPI) => {
  const { pos, rot, lvel, avel } = rb;
  return [
    pos.x,
    pos.y,
    pos.z,
    rot.x,
    rot.y,
    rot.z,
    rot.w,
    lvel.x,
    lvel.y,
    lvel.z,
    avel.x,
    avel.y,
    avel.z,
  ].map(Math.fround);
};

const TIER_INDEX: Record<PhysicsTier, number> = { FULL: 0, STATIC: 1, DISABLED: 2 };

/** Dynamic bodies (characters split out), keyed by appId or by creation order. Bodies a physics
 * tier froze into BODY_STATIC count too. */
const collectBodies = () => {
  const world = getECSWorld();
  const characterEntityIds = new Set(getCharacters(world).map((c) => c.entityId));
  const keyed: ProbeBody[] = [];
  const keyless: { body: ProbeBody; rbId: number }[] = [];
  const characters: ProbeBody[] = [];

  const collect = (storage: IComponentStorage<RigidBodyAPI>, tieredOnly?: boolean) => {
    for (const entityId of storage.keys()) {
      const tier = world.getComponent(entityId, ComponentType.PHYSICS_SIM_TIER)?.tier;
      if (tieredOnly && !tier) continue;
      const rb = storage.get(entityId)!;
      const appId = getStableAppId(entityId, world);
      const name = world.getComponent(entityId, ComponentType.OBJECT3D)?.value.name ?? '';
      const values = readBodyValues(rb);
      if (tier) values.push(TIER_INDEX[tier]);
      const body = { key: appId ?? '', name, entityId, values };
      if (characterEntityIds.has(entityId)) characters.push({ ...body, key: appId ?? name });
      else if (appId) keyed.push(body);
      else keyless.push({ body, rbId: rb.id });
    }
  };
  collect(world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL));
  collect(world.getStorage(ComponentType.BODY_DYNAMIC_HEADLESS));
  collect(world.getStorage(ComponentType.BODY_STATIC), true);

  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  keyless.sort((a, b) => a.rbId - b.rbId);
  const bodies: ProbeBody[] = [
    ...keyed,
    ...keyless.map(({ body }, i) => ({ ...body, key: `#${i}` })),
  ];
  return { bodies, characters };
};

const formatVec = (values: number[], from: number, count: number) =>
  values
    .slice(from, from + count)
    .map((v) => v.toFixed(4))
    .join(', ');

const toTableRows = (bodies: ProbeBody[]) =>
  bodies.map((b) => ({
    key: b.key,
    name: b.name,
    entityId: b.entityId,
    pos: formatVec(b.values, 0, 3),
    rot: formatVec(b.values, 3, 4),
    linvel: formatVec(b.values, 7, 3),
    angvel: formatVec(b.values, 10, 3),
  }));

const positionDelta = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const valuesEqual = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Logs how this run differs from the previous stored run of the same scene and N. */
const logDiff = (bodies: ProbeBody[], hash: string, prev: StoredRun | undefined) => {
  if (!prev) {
    llog('[PhysicsProbe] no previous run of this scene and N to compare with');
    return;
  }
  const prevLabel = `previous run (${prev.config}, ${prev.at})`;
  if (prev.hash === hash) {
    llog(`[PhysicsProbe] MATCH with ${prevLabel}`);
    return;
  }

  const prevByKey = new Map(prev.bodies.map((b) => [b.key, b.values]));
  const currentKeys = new Set(bodies.map((b) => b.key));
  let firstDiff: string | null = null;
  let maxDelta = 0;
  let maxDeltaKey = '';
  for (const body of bodies) {
    const prevValues = prevByKey.get(body.key);
    if (!prevValues) {
      firstDiff ??= `${body.key} (not in the previous run)`;
      continue;
    }
    if (!valuesEqual(body.values, prevValues)) firstDiff ??= body.key;
    const delta = positionDelta(body.values, prevValues);
    if (delta > maxDelta) {
      maxDelta = delta;
      maxDeltaKey = body.key;
    }
  }
  const missing = prev.bodies.filter((b) => !currentKeys.has(b.key)).map((b) => b.key);

  const parts = [`[PhysicsProbe] DIFF from ${prevLabel}, was ${prev.hash}`];
  parts.push(`first differing body: ${firstDiff ?? '(none, only missing bodies)'}`);
  if (maxDeltaKey) parts.push(`largest position delta: ${maxDelta.toFixed(4)} (${maxDeltaKey})`);
  if (missing.length) parts.push(`missing now: ${missing.join(', ')}`);
  lwarn(parts.join(' | '));
};

const report = (run: ActiveRun) => {
  const { bodies, characters } = collectBodies();
  const hash = hashBodies(bodies);
  const state = getPhysicsState();
  const transport =
    state.workerTarget === 'WORKER_THREAD' ? getResolvedTransportMode() ?? 'UNKNOWN' : 'n/a';
  const config = `${state.workerTarget}/${transport} | ${state.interpolationMode}`;

  llog(`[PhysicsProbe] ${run.sceneId} | ${config} | ${run.steps} | ${hash}`);
  llog(
    `[PhysicsProbe] steps ${run.startStep} → ${run.targetStep} of the current world, ${bodies.length} bodies hashed`
  );
  // eslint-disable-next-line no-console
  console.table(toTableRows(bodies));
  if (characters.length) {
    llog('[PhysicsProbe] characters (not hashed):');
    // eslint-disable-next-line no-console
    console.table(toTableRows(characters));
  }

  const runKey = `${run.sceneId}|${run.steps}`;
  const runs = (lsGetItem(LS_KEY, {}) as Record<string, StoredRun>) || {};
  logDiff(bodies, hash, runs[runKey]);
  runs[runKey] = {
    hash,
    config,
    at: new Date().toISOString(),
    bodies: bodies.map(({ key, values }) => ({ key, values })),
  };
  lsSetItem(LS_KEY, runs);
};

const stopRun = () => {
  if (!activeRun) return;
  cancelAnimationFrame(activeRun.rafId);
  activeRun = null;
  setPhysicsStepLimit(null);
};

/** Starts counting `steps` fixed steps from now; reports once the frozen pose is visible. */
const startRun = (steps: number) => {
  stopRun();
  const sceneId = getCurrentSceneId();
  const targetStep = setPhysicsStepLimit(steps);
  if (!sceneId || targetStep === null) return;
  const run: ActiveRun = { sceneId, steps, startStep: targetStep - steps, targetStep, rafId: 0 };
  activeRun = run;
  llog(`[PhysicsProbe] armed: ${sceneId}, freezing at step ${targetStep} (${steps} steps)`);

  const poll = () => {
    if (activeRun !== run) return;
    if (getPhysicsSnapshotStepIndex() < run.targetStep) {
      run.rafId = requestAnimationFrame(poll);
      return;
    }
    // Stays frozen at the target step (for inspection) until the scene exits or it's disarmed.
    report(run);
  };
  run.rafId = requestAnimationFrame(poll);
};

/** Arms the probe for `steps` fixed steps: runs now (counting from the current step) and again
 * on every scene enter. */
export const armPhysicsDeterminismProbe = (steps: number) => {
  armedSteps = steps;
  startRun(steps);
};

/** Disarms the probe and releases the step freeze. */
export const disarmPhysicsDeterminismProbe = () => {
  armedSteps = null;
  stopRun();
};

export const getPhysicsDeterminismProbeSteps = () => armedSteps;

export const _initPhysicsDeterminismProbe = () => {
  const param = new URLSearchParams(window.location.search).get(URL_PARAM);
  const steps = param ? parseInt(param, 10) : NaN;
  if (Number.isFinite(steps) && steps > 0) armedSteps = steps;

  registerOnAllSceneEnterings('physicsDeterminismProbe', () => {
    if (armedSteps !== null) startRun(armedSteps);
  });
  // Released before the next load, so a leftover freeze never holds physics during it (that
  // would hide exactly the load-timing effect the probe is meant to measure).
  registerOnAllSceneExits('physicsDeterminismProbe', stopRun);
};
