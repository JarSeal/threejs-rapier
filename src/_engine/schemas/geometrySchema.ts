import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { DebugDataSchema } from './_helperSchemas';

const GeoBaseProps = z.object({
  id: z.string().optional(),
  debugData: DebugDataSchema.optional(),
});

const BoxVariant = GeoBaseProps.extend({
  type: z.literal('BOX'),
  params: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      depth: z.number().optional(),
      widthSegments: z.number().optional(),
      heightSegments: z.number().optional(),
      depthSegments: z.number().optional(),
    })
    .optional(),
});

const SphereVariant = GeoBaseProps.extend({
  type: z.literal('SPHERE'),
  params: z
    .object({
      radius: z.number().optional(),
      widthSegments: z.number().optional(),
      heightSegments: z.number().optional(),
      phiStart: z.number().optional(),
      phiLength: z.number().optional(),
      thetaStart: z.number().optional(),
      thetaLength: z.number().optional(),
    })
    .optional(),
});

const CylinderVariant = GeoBaseProps.extend({
  type: z.literal('CYLINDER'),
  params: z
    .object({
      radiusTop: z.number().optional(),
      radiusBottom: z.number().optional(),
      height: z.number().optional(),
      radialSegments: z.number().optional(),
      heightSegments: z.number().optional(),
      openEnded: z.boolean().optional(),
      thetaStart: z.number().optional(),
      thetaLength: z.number().optional(),
    })
    .optional(),
});

const CapsuleVariant = GeoBaseProps.extend({
  type: z.literal('CAPSULE'),
  params: z
    .object({
      radius: z.number().optional(),
      height: z.number().optional(),
      capSegments: z.number().optional(),
      radialSegments: z.number().optional(),
      heightSegments: z.number().optional(),
    })
    .optional(),
});

const ConeVariant = GeoBaseProps.extend({
  type: z.literal('CONE'),
  params: z
    .object({
      radius: z.number().optional(),
      height: z.number().optional(),
      radialSegments: z.number().optional(),
      heightSegments: z.number().optional(),
      openEnded: z.boolean().optional(),
      thetaStart: z.number().optional(),
      thetaLength: z.number().optional(),
    })
    .optional(),
});

export const GeoPropsSchema = z.union([
  BoxVariant,
  SphereVariant,
  CylinderVariant,
  CapsuleVariant,
  ConeVariant,
]);

export type GeoProps = z.infer<typeof GeoPropsSchema>;

const GeoOverrides = z.object({
  __meta: MetaSchema.optional(),
  debugData: DebugDataSchema.optional(),
  params: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      depth: z.number().optional(),
      widthSegments: z.number().optional(),
      heightSegments: z.number().optional(),
      depthSegments: z.number().optional(),
      radius: z.number().optional(),
      phiStart: z.number().optional(),
      phiLength: z.number().optional(),
      thetaStart: z.number().optional(),
      thetaLength: z.number().optional(),
      radiusTop: z.number().optional(),
      radiusBottom: z.number().optional(),
      radialSegments: z.number().optional(),
      openEnded: z.boolean().optional(),
      capSegments: z.number().optional(),
    })
    .optional(),
});

export const GeoAssetSchema = z.object({
  $schema: z.string().optional(),
  geoProps: GeoPropsSchema,
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(GeoOverrides),
});

export type GeoAsset = z.infer<typeof GeoAssetSchema>;
