import { z } from 'zod';

export const Vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const Vector4Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  w: z.number(),
});

export type Vector3 = z.infer<typeof Vector3Schema>;

export const ColorJSONSchema = z.union([
  z.string(), // Hex string format, e.g., "#ff0000"
  z.object({
    r: z.number(),
    g: z.number(),
    b: z.number(),
  }), // RGB object format, e.g., { r: 255, g: 0, b: 0 }
]);

export type ColorJSON = z.infer<typeof ColorJSONSchema>;

export const DebugDataSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  comments: z
    .array(
      z.object({
        timestamp: z.number(),
        comment: z.string(),
      })
    )
    .optional(),
  todo: z.record(z.string(), z.unknown()).optional(),
  debugObj: z.record(z.string(), z.unknown()).optional(),
});

export type DebugData = z.infer<typeof DebugDataSchema>;

export const UserDataSchema = z.record(z.string(), z.unknown());

export type UserData = z.infer<typeof UserDataSchema>;

export const EntityDebugDataSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  comments: z
    .array(
      z.object({
        timestamp: z.number(),
        comment: z.string(),
      })
    )
    .optional(),
  todo: z.record(z.string(), z.unknown()).optional(),
  debugObj: z.record(z.string(), z.unknown()).optional(),
});

export type EntityDebugData = z.infer<typeof EntityDebugDataSchema>;

export const CoreEntityOptsSchema = z.object({
  appId: z.string().optional(),
  disabled: z.boolean().optional(),
  persistent: z.boolean().optional(),
  doNotAddToScene: z.boolean().optional(),
  userData: UserDataSchema.optional(),
  debugData: EntityDebugDataSchema.optional(),
});

export type CoreEntityOpts = z.infer<typeof CoreEntityOptsSchema>;

export const ShadowQualitySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'ULTRA']);

export type ShadowQuality = z.infer<typeof ShadowQualitySchema>;
