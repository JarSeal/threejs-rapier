import * as THREE from 'three/webgpu';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/webgpu/LineSegments2.js';

import { ECSSystemStage } from '../../../AppECSRegistry';
import { existsOrThrow } from '../../utils/assert';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lwarn } from '../../utils/Logger';
import { getConfig, PhysicsWireframeColors } from '../Config';
import { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import {
  ColliderAPI,
  HeightFieldData,
  PhysRotation,
  PhysVector,
  RigidBodyAPI,
  ShapeType,
} from '../Physics/PhysicsAPITypes';
import { DebugBodyFlag, DebugColliderFlag } from '../Physics/PhysicsDebugStateBuffer';
import {
  getPhysicsDebugStateBuffer,
  getPhysicsState,
  setPhysicsDebugStateTracking,
} from '../PhysicsAPI';
import { getCurrentSceneId, getRootScene } from '../Scene';

/**
 * Per-entity collider wireframes (docs/plans/_DONE_p025_debug-drawing-in-physics-api.md).
 *
 * Deliberately NOT Rapier's own `World.debugRender()`: that returns one flat line list
 * for the entire world, which in WORKER_THREAD mode would mean a full-world round trip
 * every frame for data the user wants about a handful of objects. Instead each collider
 * gets its own small LineSegments, built once from shape data the Physics API can hand
 * over, and kept positioned by the Three.js scene graph wherever possible.
 *
 * Switched on and off per entity by adding/removing the DEBUG_PHYSICS_WIREFRAME
 * component — deliberately not a single global list, so each entity's own toggle
 * survives independently of the others. `setWireframeMasterVisible` layers a scene-level
 * show/hide filter on top of that (bound to the on-screen tools bottom bar), but it only
 * flips `.visible` on what's already built and never touches the per-entity component or
 * its persisted state. Dynamically imported (see PhysicsManager.registerPhysicsManager),
 * so none of this reaches production.
 */

// ----------------------------------------------------------------------------
// Config resolution
// ----------------------------------------------------------------------------

export type WireframeColorState = keyof Required<PhysicsWireframeColors>;

/** Engine fallbacks, used for any key AppConfig.debugPhysicsWireframe doesn't set. They
 * live here rather than in Config.ts's default config object so no color table ships in
 * a production bundle. */
export const DEFAULT_WIREFRAME_COLORS: Required<PhysicsWireframeColors> = {
  disabled: 0x555555,
  sensor: 0xb8a000,
  sleeping: 0x8b0000,
  kinematic: 0x2266ff,
  fixed: 0xdddddd,
  awake: 0xff0000,
};
export const DEFAULT_WIREFRAME_LINE_THICKNESS = 1;

/** Every color state, in the order they're resolved (and the order the debugger tab
 * lists them). */
export const WIREFRAME_COLOR_STATES = [
  'disabled',
  'sensor',
  'sleeping',
  'kinematic',
  'fixed',
  'awake',
] as const;

/** Tab-level overrides, layered over the config values. The debugger tab's "Wireframe"
 * folder writes here; empty until the user changes something. */
const globalColorOverrides: PhysicsWireframeColors = {};
let globalLineThickness: number | undefined = undefined;

/** What a "Reset" in the debugger tab restores: the app's CONFIG.ts value for this state,
 * or the engine fallback when it doesn't set one. Deliberately excludes the tab's own
 * overrides — that's the thing being reset. */
export const getWireframeColorDefault = (state: WireframeColorState): number =>
  getConfig().debugPhysicsWireframe?.colors?.[state] ?? DEFAULT_WIREFRAME_COLORS[state];

export const getWireframeLineThicknessDefault = (): number =>
  getConfig().debugPhysicsWireframe?.lineThickness ?? DEFAULT_WIREFRAME_LINE_THICKNESS;

/** AppConfig merges shallowly (loadConfig does `{...config, ...configFile}`), so an app
 * that sets only some keys would otherwise leave the rest undefined — resolve each key
 * individually rather than trusting the object to be complete. */
export const getWireframeColors = (): Required<PhysicsWireframeColors> => {
  const resolved = {} as Required<PhysicsWireframeColors>;
  for (const state of WIREFRAME_COLOR_STATES) {
    resolved[state] = globalColorOverrides[state] ?? getWireframeColorDefault(state);
  }
  return resolved;
};

export const getWireframeLineThickness = (): number =>
  globalLineThickness ?? getWireframeLineThicknessDefault();

/**
 * Sets a tab-level color override and repaints every visible wireframe. Passing
 * `undefined` clears the override, falling back to the CONFIG.ts/engine default.
 */
export const setGlobalWireframeColor = (state: WireframeColorState, color?: number) => {
  if (color === undefined) {
    delete globalColorOverrides[state];
  } else {
    globalColorOverrides[state] = color;
  }
  repaintAllWireframes();
};

/** Bulk form of setGlobalWireframeColor, for restoring a persisted set in one go. */
export const setGlobalWireframeColors = (colors: PhysicsWireframeColors) => {
  for (const state of WIREFRAME_COLOR_STATES) {
    const color = colors[state];
    if (color !== undefined) globalColorOverrides[state] = color;
  }
  repaintAllWireframes();
};

/** The tab-level overrides as they stand, for persisting them. */
export const getGlobalWireframeColorOverrides = (): PhysicsWireframeColors => ({
  ...globalColorOverrides,
});

/** Drops every tab-level override, returning to the AppConfig/engine defaults. */
export const resetGlobalWireframeColors = () => {
  for (const state of WIREFRAME_COLOR_STATES) delete globalColorOverrides[state];
  repaintAllWireframes();
};

/**
 * Sets the wireframe line width in pixels, or clears the override with `undefined`.
 *
 * Takes effect immediately on every live wireframe — Line2NodeMaterial reads the width
 * as a uniform, so there's no geometry rebuild and no shader recompile. Has no visible
 * effect only in the fallback case where the fat-line modules couldn't be loaded (see
 * createWireframeObject), which warns once on the console.
 */
export const setGlobalWireframeLineThickness = (thickness?: number) => {
  globalLineThickness = thickness;
  applyLineThickness();
};

const applyLineThickness = () => {
  const linewidth = getWireframeLineThickness();
  for (const entry of wireframes.values()) {
    for (const cw of entry.colliders) cw.material.linewidth = linewidth;
  }
};

// ----------------------------------------------------------------------------
// Per-entity color overrides + persistence
// ----------------------------------------------------------------------------

/** Per-entity overrides, layered over the global palette. Kept here rather than read
 * straight off the DEBUG_PHYSICS_WIREFRAME component so they survive the wireframe being
 * switched off and back on — the component only exists while it's visible. The
 * component's own `colorOverrides` field seeds this map when the component is added, so
 * app code can still declare them inline. */
const entityColorOverrides = new Map<number, PhysicsWireframeColors>();

export const PHYSICS_WIREFRAME_ENTITY_LS_KEY = 'AEK_debugPhysicsApiEntities';

type PersistedEntityWireframe = {
  visible?: boolean;
  colorOverrides?: PhysicsWireframeColors;
};

/**
 * The entity's app id, but only when the app explicitly supplied one.
 *
 * ECS.ts generates a UUID for entities created without an `appId`, and that UUID is new
 * on every reload — so persisting against it would just accumulate dead records.
 * `APP_ID.isFixed` is exactly the "the app named this one" flag, which makes
 * per-entity debug settings reload-durable for named entities and session-only for the
 * rest (p025 Design decision 9).
 */
const getStableAppId = (entityId: number, world: ECSWorld): string | undefined => {
  const appId = world.getComponent(entityId, ComponentType.APP_ID);
  return appId?.isFixed ? appId.id : undefined;
};

const readPersistedEntities = () =>
  lsGetItem(PHYSICS_WIREFRAME_ENTITY_LS_KEY, {}) as Record<string, PersistedEntityWireframe>;

/** Writes this entity's current visibility/overrides, or drops its record when there's
 * nothing non-default left to remember. No-op for entities without a stable app id. */
const persistEntityWireframe = (entityId: number, world: ECSWorld) => {
  const appId = getStableAppId(entityId, world);
  if (!appId) return;

  const all = readPersistedEntities();
  const overrides = entityColorOverrides.get(entityId);
  const visible = isWireframeVisible(entityId, world);
  const record: PersistedEntityWireframe = {};
  if (visible) record.visible = true;
  if (overrides && Object.keys(overrides).length) record.colorOverrides = { ...overrides };

  if (Object.keys(record).length) {
    all[appId] = record;
  } else {
    delete all[appId];
  }

  if (Object.keys(all).length) {
    lsSetItem(PHYSICS_WIREFRAME_ENTITY_LS_KEY, all);
  } else {
    lsRemoveItem(PHYSICS_WIREFRAME_ENTITY_LS_KEY);
  }
};

const restoreEntityWireframe = (entityId: number, world: ECSWorld) => {
  const appId = getStableAppId(entityId, world);
  if (!appId) return;
  const record = readPersistedEntities()[appId];
  if (!record) return;
  if (record.colorOverrides) entityColorOverrides.set(entityId, { ...record.colorOverrides });
  if (record.visible) setWireframeVisible(entityId, world, true);
};

/**
 * Whether this entity's wireframe settings survive a reload.
 *
 * False for entities created without an explicit `appId` — they get a fresh UUID every
 * load, so there's nothing stable to key against and their settings are session-only
 * (p025 Design decision 9). Surfaced in the edit window so that difference is visible
 * rather than looking like settings silently failing to save.
 */
export const isWireframePersistable = (entityId: number, world: ECSWorld) =>
  Boolean(getStableAppId(entityId, world));

/** This entity's override for one state, or undefined when it falls back to the global
 * palette. */
export const getEntityWireframeColor = (
  entityId: number,
  state: WireframeColorState
): number | undefined => entityColorOverrides.get(entityId)?.[state];

/** Sets (or, with `undefined`, clears) one per-entity color override. */
export const setEntityWireframeColor = (
  entityId: number,
  world: ECSWorld,
  state: WireframeColorState,
  color?: number
) => {
  const existing = entityColorOverrides.get(entityId);
  if (color === undefined) {
    if (existing) {
      delete existing[state];
      if (!Object.keys(existing).length) entityColorOverrides.delete(entityId);
    }
  } else {
    if (existing) {
      existing[state] = color;
    } else {
      entityColorOverrides.set(entityId, { [state]: color });
    }
  }
  repaintEntityWireframes(entityId);
  persistEntityWireframe(entityId, world);
};

/** Clears every per-entity override, returning this entity to the global palette. */
export const resetEntityWireframeColors = (entityId: number, world: ECSWorld) => {
  entityColorOverrides.delete(entityId);
  repaintEntityWireframes(entityId);
  persistEntityWireframe(entityId, world);
};

// ----------------------------------------------------------------------------
// Live state
// ----------------------------------------------------------------------------

/** Either implementation: LineSegments2 when the fat-line path is available (respects
 * lineThickness), plain LineSegments otherwise (always 1px). */
type WireframeLines = THREE.LineSegments | LineSegments2;
type WireframeMaterial = THREE.LineBasicMaterial | THREE.Line2NodeMaterial;

type ColliderWireframe = {
  collider: ColliderAPI;
  lines: WireframeLines;
  material: WireframeMaterial;
  /** Collider pose relative to its rigid body, fetched once at build time. */
  localPos: THREE.Vector3;
  localQuat: THREE.Quaternion;
  /** Last painted state, so material.color is only written when it actually changes. */
  lastState: WireframeColorState | null;
};

type EntityWireframes = {
  entityId: number;
  rb?: RigidBodyAPI;
  /** The entity's Object3D, when the wireframes hang off it and the scene graph keeps
   * them positioned for free. Undefined when they live under `host` instead. */
  parent?: THREE.Object3D;
  /** Debug-only root-scene Object3D, for entities with no Object3D to piggyback on. */
  host?: THREE.Object3D;
  /** True for BODY_DYNAMIC_HEADLESS: moves, but has no Object3D — the only case that
   * needs a per-frame transform sync from this module. */
  needsTransformSync: boolean;
  colliders: ColliderWireframe[];
};

const wireframes = new Map<number, EntityWireframes>();
/** Entities whose async build is in flight, so a re-add can't start a second one. */
const building = new Set<number>();

/** WORKER_THREAD only: id -> slot in the debug-state buffer. Rebuilt on every flush, and
 * mirrors exactly the arrays sent to the worker (position IS slot). */
const trackedBodySlots = new Map<number, number>();
const trackedColliderSlots = new Map<number, number>();
/** Set on every add/remove; flushed at most once per frame so bulk toggling costs one
 * protocol message rather than one per entity. */
let trackingDirty = false;

const isWorkerMode = () => getPhysicsState().workerTarget === 'WORKER_THREAD';

// ----------------------------------------------------------------------------
// Master visibility (scene-level show/hide filter)
// ----------------------------------------------------------------------------

/**
 * A scene-level show/hide filter layered on top of each entity's own
 * DEBUG_PHYSICS_WIREFRAME toggle. Never adds/removes that component and never touches
 * `entityColorOverrides`/persisted per-entity state — it only flips `.visible` on
 * whatever is already built, so switching it back on reveals exactly the set of
 * wireframes that were on before, with no per-entity state lost. Defaults to visible.
 */
const MASTER_VISIBILITY_LS_KEY = 'AEK_debugPhysicsWireframeMaster';

/** Per-scene; a scene is only present here when it deviates from the default (visible). */
type WireframeMasterVisibilityLSData = Record<string, boolean>;

let masterVisible = true;

const readMasterVisibilityLS = () =>
  lsGetItem(MASTER_VISIBILITY_LS_KEY, {}) as WireframeMasterVisibilityLSData;

const applyMasterVisibilityToEntry = (entry: EntityWireframes) => {
  if (entry.host) entry.host.visible = masterVisible;
  if (entry.parent) {
    for (const cw of entry.colliders) cw.lines.visible = masterVisible;
  }
};

const applyMasterVisibility = () => {
  for (const entry of wireframes.values()) applyMasterVisibilityToEntry(entry);
};

export const isWireframeMasterVisible = () => masterVisible;

/** Sets the master filter and immediately re-applies it to every currently built
 * wireframe. Persisted per scene, keyed off the scene active at call time. */
export const setWireframeMasterVisible = (visible: boolean) => {
  masterVisible = visible;

  const sceneId = getCurrentSceneId();
  if (sceneId) {
    const data = readMasterVisibilityLS();
    if (visible) delete data[sceneId];
    else data[sceneId] = false;
    if (Object.keys(data).length) lsSetItem(MASTER_VISIBILITY_LS_KEY, data);
    else lsRemoveItem(MASTER_VISIBILITY_LS_KEY);
  }

  applyMasterVisibility();
};

export const toggleWireframeMasterVisible = () => setWireframeMasterVisible(!masterVisible);

/** Restores the master filter for the scene being entered. Called on every scene
 * entering (PhysicsManager.registerPhysicsManager) so switching scenes doesn't carry a
 * previous scene's filter state along. */
export const syncWireframeMasterVisibilityFromLS = (sceneId: string) => {
  masterVisible = readMasterVisibilityLS()[sceneId] !== false;
  applyMasterVisibility();
};

// ----------------------------------------------------------------------------
// Geometry builders
// ----------------------------------------------------------------------------

/** Kept low on purpose: these are wireframes, and a 32-segment sphere reads as noise. */
const RADIAL_SEGMENTS = 12;
const HEIGHT_SEGMENTS = 2;
const CAP_SEGMENTS = 4;
/** A half-space is infinite; this is just how much of it we draw. */
const HALF_SPACE_SIZE = 20;
const HALF_SPACE_DIVISIONS = 4;

/** Shape types with no accessor on ColliderAPI to rebuild them from. Warned about once
 * each rather than per collider. */
const warnedShapeTypes = new Set<ShapeType>();

const warnUnsupportedShape = (shapeType: ShapeType, reason: string) => {
  if (warnedShapeTypes.has(shapeType)) return;
  warnedShapeTypes.add(shapeType);
  lwarn(
    `Physics debug wireframe: no wireframe for shape type ${ShapeType[shapeType]} (${reason}). The collider is skipped; everything else on the entity still draws.`
  );
};

/** Solid geometry -> its triangle edges. Used for curved shapes, where the tessellation
 * lines are what conveys the form. */
const toWireframe = (geom: THREE.BufferGeometry): THREE.BufferGeometry => {
  const wire = new THREE.WireframeGeometry(geom);
  geom.dispose();
  return wire;
};

/** Solid geometry -> only its sharp edges. Used for flat-faced shapes, where triangle
 * diagonals across each face would be pure noise. */
const toEdges = (geom: THREE.BufferGeometry): THREE.BufferGeometry => {
  const edges = new THREE.EdgesGeometry(geom, 1);
  geom.dispose();
  return edges;
};

/** Raw positions -> a LineSegments geometry, for shapes we draw as explicit line lists. */
const toLineSegments = (positions: number[]): THREE.BufferGeometry => {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geom;
};

const buildIndexedMeshWireframe = (
  vertices: Float32Array,
  indices: Uint32Array | null
): THREE.BufferGeometry | null => {
  if (!indices) return null;
  const geom = new THREE.BufferGeometry();
  // Copied, not referenced: on MAIN_THREAD these arrays belong to the live Rapier shape.
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  return toWireframe(geom);
};

/** Polyline indices are segment pairs, so this is already a line list — no wireframe or
 * edge extraction needed. */
const buildPolylineGeometry = (
  vertices: Float32Array,
  indices: Uint32Array | null
): THREE.BufferGeometry => {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  if (indices) geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  return geom;
};

const buildHeightFieldGeometry = (hf: HeightFieldData): THREE.BufferGeometry | null => {
  const { nrows, ncols, heights, scale } = hf;
  if (nrows < 2 || ncols < 2) return null;

  // Rapier stores the height matrix column-major and centers the surface on the local
  // origin, spanning scale.x by scale.z.
  const heightAt = (row: number, col: number) => heights[col * nrows + row] * scale.y;
  const xAt = (row: number) => (row / (nrows - 1) - 0.5) * scale.x;
  const zAt = (col: number) => (col / (ncols - 1) - 0.5) * scale.z;

  const positions: number[] = [];
  for (let row = 0; row < nrows; row++) {
    for (let col = 0; col < ncols; col++) {
      const x = xAt(row);
      const z = zAt(col);
      const y = heightAt(row, col);
      if (col + 1 < ncols) {
        positions.push(x, y, z, x, heightAt(row, col + 1), zAt(col + 1));
      }
      if (row + 1 < nrows) {
        positions.push(x, y, z, xAt(row + 1), heightAt(row + 1, col), z);
      }
    }
  }
  return toLineSegments(positions);
};

const buildHalfSpaceGeometry = (normal: PhysVector): THREE.BufferGeometry => {
  const geom = new THREE.PlaneGeometry(
    HALF_SPACE_SIZE,
    HALF_SPACE_SIZE,
    HALF_SPACE_DIVISIONS,
    HALF_SPACE_DIVISIONS
  );
  // PlaneGeometry faces +Z; rotate it onto the half-space's outward normal.
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(normal.x, normal.y, normal.z).normalize()
  );
  geom.applyQuaternion(quat);
  return toWireframe(geom);
};

/** Segment (2 points) and Triangle (3 points) come back through vertices() flattened. */
const buildSegmentOrTriangleGeometry = (
  vertices: Float32Array,
  close: boolean
): THREE.BufferGeometry => {
  const positions: number[] = [];
  const count = vertices.length / 3;
  for (let i = 0; i < count - 1; i++) {
    positions.push(
      vertices[i * 3],
      vertices[i * 3 + 1],
      vertices[i * 3 + 2],
      vertices[(i + 1) * 3],
      vertices[(i + 1) * 3 + 1],
      vertices[(i + 1) * 3 + 2]
    );
  }
  if (close && count > 2) {
    positions.push(
      vertices[(count - 1) * 3],
      vertices[(count - 1) * 3 + 1],
      vertices[(count - 1) * 3 + 2],
      vertices[0],
      vertices[1],
      vertices[2]
    );
  }
  return toLineSegments(positions);
};

/**
 * Builds the line geometry for one collider, in the collider's own local space.
 *
 * Every getter used here is async so the same code path serves both thread modes
 * (MAIN_THREAD's async getters just wrap the sync ones). This runs exactly once per
 * collider, when its wireframe is first switched on — never per frame.
 */
const buildShapeGeometry = async (collider: ColliderAPI): Promise<THREE.BufferGeometry | null> => {
  const shapeType = await collider.shapeType();

  switch (shapeType) {
    case ShapeType.Ball: {
      const radius = await collider.radius();
      return toWireframe(new THREE.SphereGeometry(radius, RADIAL_SEGMENTS, CAP_SEGMENTS * 2));
    }

    case ShapeType.Cuboid:
    case ShapeType.RoundCuboid: {
      const he = await collider.halfExtents();
      // A round cuboid's border radius inflates it on every side.
      const br = shapeType === ShapeType.RoundCuboid ? await collider.borderRadius() : 0;
      return toEdges(new THREE.BoxGeometry(2 * (he.x + br), 2 * (he.y + br), 2 * (he.z + br)));
    }

    case ShapeType.Capsule: {
      const radius = await collider.radius();
      const halfHeight = await collider.halfHeight();
      // THREE's CapsuleGeometry length is the cylindrical section only, matching Rapier's
      // half-height convention once doubled.
      return toWireframe(
        new THREE.CapsuleGeometry(radius, 2 * halfHeight, CAP_SEGMENTS, RADIAL_SEGMENTS)
      );
    }

    case ShapeType.Cylinder:
    case ShapeType.RoundCylinder: {
      const radius = await collider.radius();
      const halfHeight = await collider.halfHeight();
      const br = shapeType === ShapeType.RoundCylinder ? await collider.borderRadius() : 0;
      return toWireframe(
        new THREE.CylinderGeometry(
          radius + br,
          radius + br,
          2 * (halfHeight + br),
          RADIAL_SEGMENTS,
          HEIGHT_SEGMENTS
        )
      );
    }

    case ShapeType.Cone:
    case ShapeType.RoundCone: {
      const radius = await collider.radius();
      const halfHeight = await collider.halfHeight();
      const br = shapeType === ShapeType.RoundCone ? await collider.borderRadius() : 0;
      return toWireframe(
        new THREE.ConeGeometry(radius + br, 2 * (halfHeight + br), RADIAL_SEGMENTS, HEIGHT_SEGMENTS)
      );
    }

    case ShapeType.HalfSpace: {
      const normal = await collider.normal();
      if (!normal) return null;
      return buildHalfSpaceGeometry(normal);
    }

    case ShapeType.Segment:
    case ShapeType.Triangle:
    case ShapeType.RoundTriangle: {
      const vertices = await collider.vertices();
      if (!vertices) return null;
      return buildSegmentOrTriangleGeometry(vertices, shapeType !== ShapeType.Segment);
    }

    case ShapeType.Polyline: {
      const vertices = await collider.vertices();
      if (!vertices) return null;
      return buildPolylineGeometry(vertices, await collider.indices());
    }

    case ShapeType.TriMesh:
    case ShapeType.ConvexPolyhedron:
    case ShapeType.RoundConvexPolyhedron: {
      const vertices = await collider.vertices();
      if (!vertices) return null;
      // Rapier returns the computed index buffer even for a ConvexPolyhedron built from
      // an auto-generated hull, so this is populated in practice for every mesh shape.
      const geom = buildIndexedMeshWireframe(vertices, await collider.indices());
      if (!geom) warnUnsupportedShape(shapeType, 'the shape has no index buffer');
      return geom;
    }

    case ShapeType.HeightField: {
      const hf = await collider.heights();
      if (!hf) return null;
      return buildHeightFieldGeometry(hf);
    }

    case ShapeType.Voxels:
      warnUnsupportedShape(shapeType, 'ColliderAPI exposes no voxel-data accessor');
      return null;

    default:
      warnUnsupportedShape(shapeType, 'unrecognised shape type');
      return null;
  }
};

// ----------------------------------------------------------------------------
// Line implementation (fat lines, with a 1px fallback)
// ----------------------------------------------------------------------------

/**
 * `LineBasicMaterial.linewidth` is ignored by essentially every modern graphics backend,
 * WebGPU included — it's a GL/D3D/Metal/Vulkan-level limitation, not a Three.js one. The
 * standard workaround is the "fat lines" family, which builds each segment as instanced
 * quad geometry instead.
 *
 * Three ships a WebGPU-native variant of it (examples/jsm/lines/webgpu/LineSegments2,
 * backed by Line2NodeMaterial) which is what this uses. Unlike the WebGL LineMaterial it
 * needs no `resolution` uniform kept in sync with the canvas: the node implementation
 * derives screen-space width from the viewport directly, so there's no resize plumbing.
 *
 * Loaded dynamically and guarded: if it can't be loaded or constructed, wireframes fall
 * back to plain 1px LineSegments and the thickness setting becomes a documented no-op
 * (p025 Design decision 8).
 */
type FatLineDeps = {
  LineSegments2: typeof LineSegments2;
  LineSegmentsGeometry: typeof LineSegmentsGeometry;
};

// undefined = not attempted yet, null = attempted and unavailable.
let fatLineDeps: FatLineDeps | null | undefined = undefined;
let fatLinePromise: Promise<FatLineDeps | null> | undefined = undefined;
let warnedNoFatLines = false;

const loadFatLineDeps = (): Promise<FatLineDeps | null> => {
  if (fatLineDeps !== undefined) return Promise.resolve(fatLineDeps);
  if (!fatLinePromise) {
    fatLinePromise = Promise.all([
      import('three/examples/jsm/lines/webgpu/LineSegments2.js'),
      import('three/examples/jsm/lines/LineSegmentsGeometry.js'),
    ])
      .then(([seg, geo]) => {
        fatLineDeps = {
          LineSegments2: seg.LineSegments2,
          LineSegmentsGeometry: geo.LineSegmentsGeometry,
        };
        return fatLineDeps;
      })
      .catch((err) => {
        fatLineDeps = null;
        lwarn(
          'Physics debug wireframe: fat lines unavailable, falling back to 1px lines. The wireframe line-thickness setting will have no visible effect.',
          err
        );
        warnedNoFatLines = true;
        return null;
      });
  }
  return fatLinePromise;
};

/** LineSegmentsGeometry.setPositions wants a flat, non-indexed list of segment endpoints.
 * WireframeGeometry/EdgesGeometry already produce that, but a Polyline's geometry carries
 * an index buffer, so expand it. */
const toFlatSegmentPositions = (geometry: THREE.BufferGeometry): Float32Array => {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!index) return new Float32Array(position.array);

  const out = new Float32Array(index.count * 3);
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    out[i * 3] = position.getX(v);
    out[i * 3 + 1] = position.getY(v);
    out[i * 3 + 2] = position.getZ(v);
  }
  return out;
};

/** Builds the drawable object for one collider's line geometry, preferring fat lines. */
const createWireframeObject = (
  geometry: THREE.BufferGeometry,
  deps: FatLineDeps | null
): { lines: WireframeLines; material: WireframeMaterial } => {
  const linewidth = getWireframeLineThickness();

  if (deps) {
    try {
      const fatGeometry = new deps.LineSegmentsGeometry();
      fatGeometry.setPositions(toFlatSegmentPositions(geometry));
      // The source geometry was only ever a staging buffer for this.
      geometry.dispose();
      const material = new THREE.Line2NodeMaterial({ linewidth });
      material.toneMapped = false;
      return { lines: new deps.LineSegments2(fatGeometry, material), material };
    } catch (err) {
      // Constructing it can fail even when the import succeeded (an unsupported
      // backend, say) — degrade instead of losing the wireframe entirely.
      if (!warnedNoFatLines) {
        warnedNoFatLines = true;
        lwarn(
          'Physics debug wireframe: could not build a fat-line wireframe, falling back to 1px lines. The line-thickness setting will have no visible effect.',
          err
        );
      }
      fatLineDeps = null;
    }
  }

  const material = new THREE.LineBasicMaterial({ toneMapped: false, linewidth });
  return { lines: new THREE.LineSegments(geometry, material), material };
};

// ----------------------------------------------------------------------------
// Build / dispose
// ----------------------------------------------------------------------------

const toQuat = (r: PhysRotation) => new THREE.Quaternion(r.x, r.y, r.z, r.w);
const toVec = (v: PhysVector) => new THREE.Vector3(v.x, v.y, v.z);

const buildEntityWireframes = async (entityId: number, world: ECSWorld) => {
  if (wireframes.has(entityId) || building.has(entityId)) return;
  const colliders = world.getComponent(entityId, ComponentType.COLLIDER);
  if (!colliders?.length) return;

  building.add(entityId);
  const built: ColliderWireframe[] = [];

  try {
    // Resolved once and cached module-wide; only the very first wireframe pays for it.
    const fatLines = await loadFatLineDeps();
    const rb = world.getRigidBody(entityId);
    const parent = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
    // Only a body that both moves and has no Object3D needs this module to move its
    // wireframe. A parented one rides the scene graph; a static one never moves.
    const needsTransformSync = world.hasComponent(entityId, ComponentType.BODY_DYNAMIC_HEADLESS);

    for (const collider of colliders) {
      const geometry = await buildShapeGeometry(collider);
      if (!geometry) continue;

      const { lines, material } = createWireframeObject(geometry, fatLines);
      lines.name = `physicsWireframe_e${entityId}_c${collider.id}`;
      // Physics debug geometry should never disappear because its own bounds were
      // mis-estimated; the set is small and explicitly opted into.
      lines.frustumCulled = false;

      let localPos: THREE.Vector3;
      let localQuat: THREE.Quaternion;
      if (parent || needsTransformSync) {
        // Positioned relative to the body, which either the scene graph or the sync
        // system below keeps current.
        localPos = toVec((await collider.translationWrtParent()) ?? { x: 0, y: 0, z: 0 });
        localQuat = toQuat((await collider.rotationWrtParent()) ?? { x: 0, y: 0, z: 0, w: 1 });
      } else {
        // Static and nothing to hang off: bake the collider's world pose in once.
        localPos = toVec(await collider.translation());
        localQuat = toQuat(await collider.rotation());
      }

      built.push({ collider, lines, material, localPos, localQuat, lastState: null });
    }

    // The component may have been removed (or the entity deleted) while the awaits above
    // were in flight — throw the work away rather than leaking orphaned lines.
    if (!world.hasComponent(entityId, ComponentType.DEBUG_PHYSICS_WIREFRAME)) {
      for (const cw of built) disposeColliderWireframe(cw);
      return;
    }
    if (!built.length) return;

    let host: THREE.Object3D | undefined = undefined;
    if (parent) {
      for (const cw of built) parent.add(cw.lines);
    } else {
      host = new THREE.Object3D();
      host.name = `physicsWireframeHost_e${entityId}`;
      for (const cw of built) host.add(cw.lines);
      existsOrThrow(getRootScene(), 'No root scene in physics debug wireframes').add(host);
    }

    const entry: EntityWireframes = {
      entityId,
      rb,
      parent,
      host,
      needsTransformSync,
      colliders: built,
    };
    wireframes.set(entityId, entry);
    applyLocalTransforms(entry);
    applyMasterVisibilityToEntry(entry);
    trackingDirty = true;
  } finally {
    building.delete(entityId);
  }
};

const disposeColliderWireframe = (cw: ColliderWireframe) => {
  cw.lines.removeFromParent();
  cw.lines.geometry.dispose();
  cw.material.dispose();
};

const disposeEntityWireframes = (entityId: number) => {
  const entry = wireframes.get(entityId);
  if (!entry) return;
  for (const cw of entry.colliders) disposeColliderWireframe(cw);
  entry.host?.removeFromParent();
  wireframes.delete(entityId);
  trackingDirty = true;
};

/**
 * Places each collider's wireframe at its local offset.
 *
 * When parented to the entity's Object3D, the offset has to be divided out by that
 * object's scale: createPhysicsEntity copies the ECS transform's scale onto the Object3D,
 * but collider dimensions are in unscaled physics space, so a scaled mesh would otherwise
 * stretch its own collider wireframe. Re-run every frame for parented entities, since the
 * scale can change at any time.
 */
const applyLocalTransforms = (entry: EntityWireframes) => {
  const scale = entry.parent?.scale;
  for (const cw of entry.colliders) {
    cw.lines.quaternion.copy(cw.localQuat);
    if (scale) {
      cw.lines.position.set(
        cw.localPos.x / (scale.x || 1),
        cw.localPos.y / (scale.y || 1),
        cw.localPos.z / (scale.z || 1)
      );
      cw.lines.scale.set(1 / (scale.x || 1), 1 / (scale.y || 1), 1 / (scale.z || 1));
    } else {
      cw.lines.position.copy(cw.localPos);
    }
  }
};

// ----------------------------------------------------------------------------
// Color state resolution
// ----------------------------------------------------------------------------

/**
 * Resolves the one state that wins for a collider, highest priority first: disabled
 * beats sensor beats sleeping beats kinematic beats fixed, with awake as the fallback.
 *
 * On MAIN_THREAD the *Sync getters are free, so they're read directly. In WORKER_THREAD
 * mode they throw by design, so state comes from the debug-state buffer the worker fills
 * once per step — an O(1) typed-array read per collider, no RPC.
 */
const resolveColorState = (
  entry: EntityWireframes,
  cw: ColliderWireframe,
  worker: boolean
): WireframeColorState | null => {
  let collEnabled: boolean;
  let collSensor: boolean;
  let bodyEnabled = true;
  let bodySleeping = false;
  let bodyKinematic = false;
  let bodyFixed = false;

  if (worker) {
    const buffer = getPhysicsDebugStateBuffer();
    if (!buffer) return null;
    const collFlags = buffer.getColliderFlags(trackedColliderSlots.get(cw.collider.id) ?? -1);
    // Nothing written for this slot yet (first frame after a tracking change, or the
    // collider is gone) — leave the current color alone rather than guessing.
    if (!(collFlags & DebugColliderFlag.VALID)) return null;
    collEnabled = Boolean(collFlags & DebugColliderFlag.ENABLED);
    collSensor = Boolean(collFlags & DebugColliderFlag.SENSOR);

    if (entry.rb) {
      const bodyFlags = buffer.getBodyFlags(trackedBodySlots.get(entry.rb.id) ?? -1);
      if (bodyFlags & DebugBodyFlag.VALID) {
        bodyEnabled = Boolean(bodyFlags & DebugBodyFlag.ENABLED);
        bodySleeping = Boolean(bodyFlags & DebugBodyFlag.SLEEPING);
        bodyKinematic = Boolean(bodyFlags & DebugBodyFlag.KINEMATIC);
        bodyFixed = Boolean(bodyFlags & DebugBodyFlag.FIXED);
      }
    }
  } else {
    collEnabled = cw.collider.isEnabledSync();
    collSensor = cw.collider.isSensorSync();
    if (entry.rb) {
      bodyEnabled = entry.rb.isEnabledSync();
      bodySleeping = entry.rb.isSleepingSync();
      bodyKinematic = entry.rb.isKinematicSync();
      bodyFixed = entry.rb.isFixedSync();
    }
  }

  if (!collEnabled || !bodyEnabled) return 'disabled';
  if (collSensor) return 'sensor';
  if (bodySleeping) return 'sleeping';
  if (bodyKinematic) return 'kinematic';
  // A collider with no rigid body at all is as static as a fixed one.
  if (bodyFixed || !entry.rb) return 'fixed';
  return 'awake';
};

const colorFor = (
  entry: EntityWireframes,
  state: WireframeColorState,
  globals: Required<PhysicsWireframeColors>
): number => entityColorOverrides.get(entry.entityId)?.[state] ?? globals[state];

/** Forces the next frame to re-evaluate every wireframe's color, used when the global
 * palette changes underneath the "only repaint on state change" optimisation. */
export const repaintAllWireframes = () => {
  for (const entry of wireframes.values()) {
    for (const cw of entry.colliders) cw.lastState = null;
  }
};

/** repaintAllWireframes for one entity, for per-entity override edits. */
export const repaintEntityWireframes = (entityId: number) => {
  const entry = wireframes.get(entityId);
  if (!entry) return;
  for (const cw of entry.colliders) cw.lastState = null;
};

// ----------------------------------------------------------------------------
// Worker-thread tracking set
// ----------------------------------------------------------------------------

/**
 * Tells the worker which bodies/colliders to mirror state for. Coalesced to at most once
 * per frame, so switching many wireframes on at once costs one message, not one each
 * (p025's "could thrash if a user rapidly toggles" risk).
 */
const flushTracking = () => {
  trackingDirty = false;
  if (!isWorkerMode()) return;

  const rigidBodyIds: number[] = [];
  const colliderIds: number[] = [];
  trackedBodySlots.clear();
  trackedColliderSlots.clear();

  for (const entry of wireframes.values()) {
    if (entry.rb && !trackedBodySlots.has(entry.rb.id)) {
      trackedBodySlots.set(entry.rb.id, rigidBodyIds.length);
      rigidBodyIds.push(entry.rb.id);
    }
    for (const cw of entry.colliders) {
      if (trackedColliderSlots.has(cw.collider.id)) continue;
      trackedColliderSlots.set(cw.collider.id, colliderIds.length);
      colliderIds.push(cw.collider.id);
    }
  }

  setPhysicsDebugStateTracking(rigidBodyIds, colliderIds).catch((err) =>
    lwarn('Physics debug wireframe: failed to update debug-state tracking.', err)
  );
};

// ----------------------------------------------------------------------------
// Per-frame system
// ----------------------------------------------------------------------------

/**
 * The feature's only per-frame work. Iterates the DEBUG_PHYSICS_WIREFRAME set, which is
 * empty unless the user explicitly switched something on, and does nothing else:
 * geometry is never rebuilt, and material.color is only written when the resolved state
 * actually changed. Takes no world argument: everything it reads is module state, keyed
 * by entity id.
 */
const physicsWireframeSystem = () => {
  if (trackingDirty) flushTracking();
  if (!wireframes.size) return;

  const worker = isWorkerMode();
  const globals = getWireframeColors();

  for (const entry of wireframes.values()) {
    if (entry.needsTransformSync && entry.host && entry.rb) {
      // BODY_DYNAMIC_HEADLESS: moves, but has no Object3D for the scene graph to carry.
      entry.host.position.set(entry.rb.pos.x, entry.rb.pos.y, entry.rb.pos.z);
      entry.host.quaternion.set(entry.rb.rot.x, entry.rb.rot.y, entry.rb.rot.z, entry.rb.rot.w);
    }
    if (entry.parent) applyLocalTransforms(entry);

    for (const cw of entry.colliders) {
      const state = resolveColorState(entry, cw, worker);
      if (!state || state === cw.lastState) continue;
      cw.material.color.setHex(colorFor(entry, state, globals));
      cw.lastState = state;
    }
  }
};

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

ECSWorld.registerComponentHooks(ComponentType.DEBUG_PHYSICS_WIREFRAME, {
  onAddComponent: (entityId, world) => {
    // The component may declare color overrides inline; fold them into the module map,
    // which is what colorFor reads and what survives the wireframe being toggled off.
    const declared = world.getComponent(
      entityId,
      ComponentType.DEBUG_PHYSICS_WIREFRAME
    )?.colorOverrides;
    if (declared && Object.keys(declared).length) {
      entityColorOverrides.set(entityId, {
        ...entityColorOverrides.get(entityId),
        ...declared,
      });
    }
    // Fire-and-forget: the build needs RPC in worker mode, and hooks are synchronous.
    buildEntityWireframes(entityId, world).catch((err) =>
      lwarn(`Physics debug wireframe: failed to build for entity ${entityId}.`, err)
    );
  },
  onRemoveComponent: (entityId) => disposeEntityWireframes(entityId),
  onDeleteEntity: (entityId) => {
    disposeEntityWireframes(entityId);
    entityColorOverrides.delete(entityId);
  },
});

// Restores persisted per-entity settings as physics entities appear. Hooked on COLLIDER
// rather than TAG_IS_PHYSICS_OBJECT because the tag is added first, before there is
// anything to draw; the microtask defers past the rest of createPhysicsEntity's
// synchronous tail so the rigid-body bucket component is in place too.
ECSWorld.registerComponentHooks(ComponentType.COLLIDER, {
  onAddComponent: (entityId, world) =>
    queueMicrotask(() => restoreEntityWireframe(entityId, world)),
});

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.APP_RENDER_SYNC, 'physicsWireframeSystem', physicsWireframeSystem);

  // Pick up anything that already had the component before this module finished loading
  // (it's dynamically imported, so a world can outrun it).
  for (const [entityId] of world.getStorage(ComponentType.DEBUG_PHYSICS_WIREFRAME)) {
    buildEntityWireframes(entityId, world).catch((err) =>
      lwarn(`Physics debug wireframe: failed to build for entity ${entityId}.`, err)
    );
  }

  // Same for physics entities that predate this module — the COLLIDER hook above only
  // sees the ones created after it was registered.
  for (const [entityId] of world.getStorage(ComponentType.COLLIDER)) {
    restoreEntityWireframe(entityId, world);
  }
});

// ----------------------------------------------------------------------------
// Public helpers (used by the debugger tab in later phases)
// ----------------------------------------------------------------------------

export const isWireframeVisible = (entityId: number, world: ECSWorld) =>
  world.hasComponent(entityId, ComponentType.DEBUG_PHYSICS_WIREFRAME);

export const setWireframeVisible = (entityId: number, world: ECSWorld, visible: boolean) => {
  if (visible === isWireframeVisible(entityId, world)) return;
  if (visible) {
    world.addComponent(entityId, ComponentType.DEBUG_PHYSICS_WIREFRAME, {});
  } else {
    world.removeComponent(entityId, ComponentType.DEBUG_PHYSICS_WIREFRAME);
  }
  persistEntityWireframe(entityId, world);
};
