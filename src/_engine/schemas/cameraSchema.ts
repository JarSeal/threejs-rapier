import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import { CoreEntityOptsSchema, Vector3Schema } from './_helperSchemas';

const CameraBaseProps = z.object({
  active: z.boolean().optional(),
  near: z.number().optional(),
  far: z.number().optional(),
  zoom: z.number().optional(),
  appId: z.string().optional(),
  position: Vector3Schema.optional(),
});

const CameraPerspective = CameraBaseProps.extend({
  type: z.literal('PERSPECTIVE'),
  fov: z.number().optional(),
});

const CameraOrthographic = CameraBaseProps.extend({
  type: z.literal('ORTHOGRAPHIC'),
  frustumSize: z.number().optional(),
});

export const CameraProps = z.union([CameraPerspective, CameraOrthographic]);
export type CameraProps = z.infer<typeof CameraProps>;

const CameraOverrides = z.object({
  __meta: MetaSchema.optional(),
  type: z.enum(['PERSPECTIVE', 'ORTHOGRAPHIC']).optional(),
  active: z.boolean().optional(),
  near: z.number().optional(),
  far: z.number().optional(),
  zoom: z.number().optional(),
  appId: z.string().optional(),
  position: Vector3Schema.optional(),
  fov: z.number().optional(),
  frustumSize: z.number().optional(),
});

export const CameraAssetSchema = z.object({
  $schema: z.string().optional(),
  camProps: CameraProps,
  entityOpts: CoreEntityOptsSchema.optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(CameraOverrides),
});

export type CameraAsset = z.infer<typeof CameraAssetSchema>;
