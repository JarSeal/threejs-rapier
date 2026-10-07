// What an exported impostor (`*.impostor.json`, docs/plans/p351_impostor-billboard-lod.md Phase 4)
// is made of, shared by the schema (schemas/impostorSchema.ts), the gatherer and the runtime. No
// imports: core loads no zod, and the gatherer (Node) loads no three.

/**
 * The export format's version, written into every `*.impostor.json`. Bump it when what an export
 * means changes: the depth encoding (`encodeImpostorDepth`), the frame maps or bases
 * (`Octahedral.ts`), a layout's meaning or the atlases' slots. An export of another version is
 * refused at runtime (it bakes instead) and warned about by the gatherer, with a re-export hint.
 */
export const IMPOSTOR_EXPORT_FORMAT_VERSION = 1;

export const IMPOSTOR_KINDS = ['OCTAHEDRAL', 'CROSS_QUADS'] as const;
export type ImpostorKind = (typeof IMPOSTOR_KINDS)[number];

/** The atlas slots each kind reads: `required` must be in its atlas, `optional` may be. */
export const IMPOSTOR_ATLAS_SLOTS: Record<
  ImpostorKind,
  { required: readonly string[]; optional: readonly string[] }
> = {
  OCTAHEDRAL: { required: ['albedo', 'normalDepth'], optional: [] },
  CROSS_QUADS: { required: ['albedo'], optional: ['normal'] },
};

/** The impostor material types an export can name (`getShadingProps`' resolved `type`). */
export const IMPOSTOR_MATERIAL_TYPES = [
  'PHONGNODEMATERIAL',
  'LAMBERTNODEMATERIAL',
  'BASICNODEMATERIAL',
  'STANDARDNODEMATERIAL',
] as const;
