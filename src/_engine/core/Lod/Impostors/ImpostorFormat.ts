// What an exported impostor (`*.impostor.json`, docs/plans/_DONE_p351_impostor-billboard-lod.md Phase 4)
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

/** The atlas slots an exported impostor reads, all of which its atlas must have: its kind's
 * required ones, plus cross-quads' `normal` when it was baked with normals */
export const getImpostorDefSlots = (def: { kind: ImpostorKind; normals?: boolean }) =>
  def.kind === 'CROSS_QUADS' && def.normals
    ? [...IMPOSTOR_ATLAS_SLOTS.CROSS_QUADS.required, 'normal']
    : [...IMPOSTOR_ATLAS_SLOTS[def.kind].required];

/** Where an impostor atlas's v = 0 is: `TOP` for a bake's render targets (three r186, both
 * backends), `BOTTOM` for an export's loaded KTX2 slots (p299 stores them v-up, three's UVs) */
export type ImpostorAtlasVOrigin = 'TOP' | 'BOTTOM';

/** The impostor material types an export can name (`getShadingProps`' resolved `type`). */
export const IMPOSTOR_MATERIAL_TYPES = [
  'PHONGNODEMATERIAL',
  'LAMBERTNODEMATERIAL',
  'BASICNODEMATERIAL',
  'STANDARDNODEMATERIAL',
] as const;
