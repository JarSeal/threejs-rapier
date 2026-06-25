import { z } from 'zod';
import { createSaveDataSchema, MetaSchema } from './_saveDataSchema';
import {
  ColorJSONSchema,
  CoreEntityOptsSchema,
  ShadowQualitySchema,
  Vector3Schema,
} from './_helperSchemas';

const LightBaseProps = z.object({
  enabled: z.boolean().optional(),
  appId: z.string().optional(),
});

const Ambient = LightBaseProps.extend({
  type: z.literal('AMBIENT'),
  color: ColorJSONSchema.optional(),
  intensity: z.number().optional(),
});

const Hemisphere = LightBaseProps.extend({
  type: z.literal('HEMISPHERE'),
  color: ColorJSONSchema.optional(),
  groundColor: ColorJSONSchema.optional(),
  intensity: z.number().optional(),
});

const Point = LightBaseProps.extend({
  type: z.literal('POINT'),
  color: ColorJSONSchema.optional(),
  intensity: z.number().optional(),
  distance: z.number().optional(),
  decay: z.number().optional(),
  position: Vector3Schema.optional(),
  castShadow: z.boolean().optional(),
  shadowPreset: ShadowQualitySchema.optional(),
  shadowBias: z.number().optional(),
  shadowNormalBias: z.number().optional(),
  shadowMapSize: z.array(z.number()).length(2).optional(),
  shadowCameraNearFar: z.array(z.number()).length(2).optional(),
  shadowBlurSamples: z.number().optional(),
  shadowRadius: z.number().optional(),
  shadowIntensity: z.number().optional(),
});

const Directional = LightBaseProps.extend({
  type: z.literal('DIRECTIONAL'),
  color: ColorJSONSchema.optional(),
  intensity: z.number().optional(),
  position: Vector3Schema.optional(),
  targetPos: Vector3Schema.optional(),
  castShadow: z.boolean().optional(),
  shadowPreset: ShadowQualitySchema.optional(),
  shadowBias: z.number().optional(),
  shadowNormalBias: z.number().optional(),
  shadowMapSize: z.array(z.number()).length(2).optional(),
  shadowCameraNearFar: z.array(z.number()).length(2).optional(),
  shadowCameraFrustum: z.array(z.number()).length(4).optional(), // left, right, top, bottom for directional light shadow camera
  shadowBlurSamples: z.number().optional(),
  shadowRadius: z.number().optional(),
  shadowIntensity: z.number().optional(),
});

const Spot = LightBaseProps.extend({
  type: z.literal('SPOT'),
  color: ColorJSONSchema.optional(),
  intensity: z.number().optional(),
  distance: z.number().optional(),
  angle: z.number().optional(),
  penumbra: z.number().optional(),
  decay: z.number().optional(),
  position: Vector3Schema.optional(),
  targetPos: Vector3Schema.optional(),
  castShadow: z.boolean().optional(),
  shadowPreset: ShadowQualitySchema.optional(),
  shadowBias: z.number().optional(),
  shadowNormalBias: z.number().optional(),
  shadowMapSize: z.array(z.number()).length(2).optional(),
  shadowCameraNearFar: z.array(z.number()).length(2).optional(),
  shadowBlurSamples: z.number().optional(),
  shadowRadius: z.number().optional(),
  shadowIntensity: z.number().optional(),
  map: z.union([z.string(), z.unknown()]).optional(),
});

const LightProps = z.union([Ambient, Hemisphere, Point, Directional, Spot]);

export type LightProps = z.infer<typeof LightProps>;

const LightOverridesSchema = z.object({
  __meta: MetaSchema.optional(),
  ...Ambient.shape,
  ...Hemisphere.shape,
  ...Point.shape,
  ...Directional.shape,
  ...Spot.shape,
  enabled: z.boolean().optional(),
  type: z.enum(['AMBIENT', 'HEMISPHERE', 'POINT', 'DIRECTIONAL', 'SPOT']).optional(),
});

export type LightOverrides = z.infer<typeof LightOverridesSchema>;

export const LightAssetSchema = z.object({
  $schema: z.string().optional(),
  lightProps: LightProps,
  entityOpts: CoreEntityOptsSchema.optional(),
  __sourcePath: z.string().optional(),
  __saveData: createSaveDataSchema(LightOverridesSchema),
});

export type LightAsset = z.infer<typeof LightAssetSchema>;
