// LOD selection types (docs/plans/p348_ecs-lod-selection.md §2). Types only: ECSCoreComponents.ts
// imports them.

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

/** The `LOD` component's data. */
export type LodData = {
  def: LodDef;
  /** The selected level. */
  level: number;
  /** The level the render side last applied, -1 before the first apply. */
  applied: number;
  /** Level 0's local bounding radius, cached when the component is added. The world radius is
   * `radius × max(|scale|)`. */
  radius: number;
};
