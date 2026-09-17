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

export function createSaveDataSchema<T extends z.ZodObject>(propertyOverrideObject: T) {
  return z
    .record(
      z.string(), // Scene ID
      z.array(propertyOverrideObject)
    )
    .optional();
}
