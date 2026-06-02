import { z } from 'zod';

export const MetaSchema = z.object({
  date: z
    .number({
      error: 'Metadata timestamp must be a valid numeric UNIX tracking sign.',
    })
    .optional(),

  // Possible additions for future implementations:
  // engineVersion: z.string().optional(),
  // author: z.string().optional(),
});

/**
 * Reusable layout engine factory.
 * Merges your strict __meta layout with unique asset properties via native JS spreading.
 * * @param propertyOverrideShape A raw JavaScript object tracking parameters dictionary shape
 */
/**
 * Reusable layout engine factory.
 * Generically captures any Zod object schema and flattens its type definitions cleanly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// export function createSaveDataSchema<T extends z.ZodObject<any>>(propertyOverrideShape: T) {
//   return z
//     .record(
//       z.string(), // Scene ID lookup key
//       z.array(
//         z.looseObject({
//           __meta: MetaSchema.optional(),
//           ...propertyOverrideShape.shape,
//         })
//       )
//     )
//     .optional();
// }
export function createSaveDataSchema<T extends z.ZodObject>(propertyOverrideObject: T) {
  return z
    .record(
      z.string(), // Scene ID
      z.array(propertyOverrideObject)
    )
    .optional();
}
