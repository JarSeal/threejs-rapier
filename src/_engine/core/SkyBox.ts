/**
 * @deprecated Re-export shim for the sky box module's old path (p111 Phases 2-3): import from
 * `core/SkyBox/SkyBox` instead. Removed in p111 Phase 4.
 */
export * from './SkyBox/SkyBox';
/** @deprecated The pre-p111 createSkyBox props: use a `SkyBoxDef` (see legacySkyBox.ts). */
export type { LegacySkyBoxProps as SkyBoxProps } from './SkyBox/legacySkyBox';
