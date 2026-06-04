import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { DebugDataSchema, UserDataSchema } from './_helperSchemas';

const ThreeJsParamsSchema = z.record(z.string(), z.any());

const TslNodeInputsSchema = z.record(z.string(), z.any());

const MaterialOverridesSchema = z.object({
  __meta: MetaSchema.optional(),
  params: ThreeJsParamsSchema.optional(),
  staticDefines: z.record(z.string(), z.any()).optional(),
  nodes: z.record(z.string(), TslNodeInputsSchema).optional(),
  debugData: DebugDataSchema.optional(),
  userData: UserDataSchema.optional(),
  isPersistent: z.boolean().optional(),
});

export type MaterialOverrides = z.infer<typeof MaterialOverridesSchema>;

const MaterailBaseProps = z.object({
  // Common props
  id: z.string({ error: "Material 'id' key is required." }),
  isPersistent: z.boolean().optional(),
  debugData: DebugDataSchema.optional(),
  userData: UserDataSchema.optional(),

  // Three.js material params
  params: ThreeJsParamsSchema.optional(),

  // Meta
  $schema: z.string().optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(MaterialOverridesSchema),
});

export const MaterialAssetSchema = z.union([
  z.object({
    ...MaterailBaseProps.shape,
    tslFile: z.string(),
    staticDefines: z.record(z.string(), z.any()).optional(),
    nodes: z.record(z.string(), TslNodeInputsSchema).optional(),
    type: z.enum(
      [
        'BASICNODEMATERIAL',
        'LAMBERTNODEMATERIAL',
        'PHONGNODEMATERIAL',
        'PHYSICALNODEMATERIAL',
        'STANDARDNODEMATERIAL',
        'MATCAPNODEMATERIAL',
        'NORMALNODEMATERIAL',
        'TOONNODEMATERIAL',
      ],
      { error: "Engine material 'type' is missing (TSL node material)." }
    ),
  }),
  z.object({
    ...MaterailBaseProps.shape,
    type: z.enum(
      [
        'LINEBASIC',
        'LINEDASHED',
        'BASIC',
        'DEPTH',
        'DISTANCE',
        'LAMBERT',
        'MATCAP',
        'NORMAL',
        'PHONG',
        'PHYSICAL',
        'STANDARD',
        'TOON',
        'POINTS',
        'SHADERRAW',
        'SHADER',
        'SHADOW',
        'SPRITE',
      ],
      { error: "Engine material 'type' is missing (non-TSL material)." }
    ),
  }),
]);

export type MaterialAsset = z.infer<typeof MaterialAssetSchema>;
