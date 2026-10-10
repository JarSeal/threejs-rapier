export { SpatialGrid } from '../../core/Spatial/SpatialGrid';
export type {
  ReadonlyVec3,
  SpatialGridOptions,
  SpatialGridStats,
} from '../../core/Spatial/SpatialGrid';
export {
  getConservativeGeometryRadius,
  getSpatialDomain,
  getSpatialGrid,
  invalidateSpatialDomain,
  isInSpatialDomain,
  joinSpatialDomain,
  leaveSpatialDomain,
  rebuildSpatialDomain,
  refreshSpatialRadius,
  registerSpatialDomain,
  registerSpatialRadiusProvider,
  unregisterSpatialDomain,
} from '../../core/Spatial/SpatialIndexSystem';
export type {
  SpatialDomainOptions,
  SpatialRadiusProvider,
} from '../../core/Spatial/SpatialIndexSystem';
