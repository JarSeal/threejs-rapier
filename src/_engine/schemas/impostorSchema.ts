import { z } from 'zod';
import { DebugDataSchema } from './_helperSchemas';
import {
  IMPOSTOR_EXPORT_FORMAT_VERSION,
  IMPOSTOR_MATERIAL_TYPES,
} from '../core/Lod/Impostors/ImpostorFormat';

/**
 * An exported impostor (docs/plans/p351_impostor-billboard-lod.md Phase 4): everything its
 * material needs besides the atlas, which is a `*.textureAtlas.json` (p299) with the kind's slots
 * (`IMPOSTOR_ATLAS_SLOTS`). Written by the LOD tab's Export, not by hand. A scene lists it in
 * `impostors`, which loads the atlas's slots with the scene; `generateOctahedralImpostor` (or
 * `generateCrossQuads`) with its id then builds from it instead of baking.
 */

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const PxSchema = z.number().int();

/** `OctahedralImpostorLayout` (core/Lod/Impostors/OctahedralImpostor.ts) */
export const OctahedralImpostorLayoutSchema = z
  .strictObject({
    frames: PxSchema.min(2).max(32).describe('Frames along each side of the grid.'),
    hemi: z.boolean().describe('The upper hemisphere only.'),
    frameSize: PxSchema.min(1).describe("A frame's side, in texels."),
    gutter: PxSchema.min(0).describe("Texels between a frame and its cell's edge."),
    atlasSize: PxSchema.min(1).describe(
      "Texels per side of the (square) atlas: frames × (frameSize + 2 × gutter), the atlas's size."
    ),
    center: Vec3Schema.describe("The object's bounding sphere centre (local space)."),
    radius: z.number().positive().describe("The bounding sphere's radius."),
    extent: z.number().positive().describe("Half a frame's side, in local units."),
  })
  .refine((layout) => layout.atlasSize === layout.frames * (layout.frameSize + 2 * layout.gutter), {
    message: 'atlasSize must be frames × (frameSize + 2 × gutter)',
  });

/** The impostor material's resolved shading (`getShadingProps`: never `AUTO`, the source material
 * isn't needed at runtime) */
export const ImpostorShadingSchema = z.strictObject({
  type: z.enum(IMPOSTOR_MATERIAL_TYPES),
  params: z.strictObject({
    shininess: z.number().optional(),
    specular: z.string().optional().describe('Hex, eg. "#111111".'),
    roughness: z.number().optional(),
    metalness: z.number().optional(),
  }),
});

const ImpostorBaseSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().optional().describe("Default: the file name. The generator's `id` option."),
  atlas: z
    .string()
    .min(1)
    .describe("The `*.textureAtlas.json`'s id: its slots are the impostor's textures."),
  formatVersion: PxSchema.min(1).describe(
    `The export format (IMPOSTOR_EXPORT_FORMAT_VERSION, now ${IMPOSTOR_EXPORT_FORMAT_VERSION}): another one is refused at runtime, which bakes instead. Re-export it.`
  ),
  sourceHash: z
    .string()
    .min(1)
    .describe(
      "The fingerprint of the source geometry, its materials' bake inputs, the resolved shading and the options it was baked with (getImpostorSourceHash): the debug env warns when the source it's used with differs (re-export)."
    ),
  alphaTest: z.number().min(0).max(1),
  shading: ImpostorShadingSchema,
  debugData: DebugDataSchema.optional(),
  __sourcePath: z.string().optional(),
});

export const OctahedralImpostorAssetSchema = ImpostorBaseSchema.extend({
  kind: z.literal('OCTAHEDRAL'),
  layout: OctahedralImpostorLayoutSchema,
  surfaceDepth: z.boolean(),
});

export const ImpostorAssetSchema = z.discriminatedUnion('kind', [OctahedralImpostorAssetSchema]);

export type ImpostorAsset = z.infer<typeof ImpostorAssetSchema>;
export type ImpostorShading = z.infer<typeof ImpostorShadingSchema>;

/** An impostor as a scene's generated data carries it (its `impostors`), per kind */
export type ImpostorDef = ImpostorAsset extends infer T
  ? T extends ImpostorAsset
    ? Omit<T, '$schema' | '__sourcePath' | 'id'> & { id: string }
    : never
  : never;
