// LOD selection types (docs/plans/p348_ecs-lod-selection.md §2). Types only: ECSCoreComponents.ts
// imports them.

import type * as THREE from 'three/webgpu';
import type { ECSWorld } from '../ECS';

/** One level of a {@link LodDef}. */
export type LodLevelDef = {
  /** Smallest screen size (bounding-sphere diameter / viewport height) this level is used at. */
  screenSize: number;
  /** Registered geometry id. Level 0 defaults to the mesh's own geometry. */
  geo?: string;
  /** Registered material id. Omitted = the previous level's material (level 0: the mesh's own). */
  mat?: string;
  /** Omitted = the previous level's (level 0: the mesh's own). */
  castShadow?: boolean;
};

export type LodDef = {
  /** Level 0 first, `screenSize` descending. */
  levels: LodLevelDef[];
  /** Below this screen size the entity is hidden (TAG_LOD_CULLED). 0 = never hidden. Default 0. */
  cullScreenSize?: number;
  /** Moving to a coarser level (or culling) waits until the screen size is this fraction below
   * the threshold. Default 0.1. */
  hysteresis?: number;
  /** Multiplies the screen size: >1 keeps detail longer. Default 1. */
  bias?: number;
};

/** Levels read from the geometry's LOD chain (p347), each used while its simplification error
 * projects to at most `maxPixelError` pixels (p348 §5). */
export type LodAutoDef = {
  auto: true;
  /** The largest error, in pixels at a viewport height of 1080, a level may show. Default 1. */
  maxPixelError?: number;
} & Omit<LodDef, 'levels'>;

/** What a mesh's `lod` can be: its levels, or `AUTO` (= `{ auto: true }`) for its geometry's
 * LOD chain. */
export type MeshLodDef = LodDef | LodAutoDef | 'AUTO';

/** A level with its assets resolved, what the apply step assigns to the mesh. */
export type LodResolvedLevel = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  castShadow: boolean;
};

/** The `LOD` component's data. Add it with `level: -1, applied: -1, radius: 0, _levels: []`: the
 * component's add hook resolves the levels and the radius. */
export type LodData = {
  def: LodDef;
  /** The selected level, -1 before the first selection. */
  level: number;
  /** The level the render side last applied, -1 before the first apply. */
  applied: number;
  /** Level 0's local bounding radius, cached when the component is added. The world radius is
   * `radius × max(|scale|)`. An `InstancedMesh`'s covers level 0 at every instance (Lod/LodBounds.ts),
   * re-read by `refreshLodBounds`. */
  radius: number;
  /** An `InstancedMesh`'s: the centre of its bounds in the mesh's space, which the selection
   * measures the distance from. Undefined for other meshes (their origin). */
  _center?: THREE.Vector3;
  /** `def.levels` resolved when the component was added (Lod/LodSystem.ts), each holding a
   * registry ref on its geometry and material(s) until the component goes. A target's levels hold
   * none. */
  _levels: LodResolvedLevel[];
  /** What shows the levels when the entity has no plain mesh, set by the add hook. */
  _target?: LodTarget;
};

/**
 * How a `LOD` entity without a plain mesh shows its levels, eg. an instanced LOD pool's
 * instance (registered with `registerLodTarget`). The entity's `Transform` gives its position and
 * scale, in world space. The target owns its levels' assets: the component takes no refs on them.
 */
export type LodTarget = {
  /** The entity's levels, called by the `LOD` add hook. Undefined: not this target's entity. */
  resolveLevels: (
    entityId: number,
    world: ECSWorld,
    lod: LodData
  ) => LodResolvedLevel[] | undefined;
  /** Shows level `level` (an index into the resolved levels). Also called while LOD culled. */
  applyLevel: (entityId: number, world: ECSWorld, level: number) => void;
  /** TAG_LOD_CULLED was added (true) or removed (false). */
  setCulled: (entityId: number, world: ECSWorld, isCulled: boolean) => void;
};
