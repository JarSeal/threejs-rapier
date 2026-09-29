import { z } from 'zod';

const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, { error: 'Version must be a MAJOR.MINOR.PATCH semver string.' });

export const MetaSchema = z.object({
  date: z
    .number({
      error: 'Metadata timestamp must be a valid numeric UNIX tracking sign.',
    })
    .optional(),

  // Versions of each part when this entry was saved. Whatever writes a save entry should stamp
  // all three: gatherAppData warns when one is from another major version than the current
  // build. Optional, older entries have none.
  engineVersion: SemverSchema.optional(),
  toolkitVersion: SemverSchema.optional(),
  appVersion: SemverSchema.optional(),

  // Possible additions for future implementations:
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
