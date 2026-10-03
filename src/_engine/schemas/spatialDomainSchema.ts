import { z } from 'zod';

/** DEFAULT_SPATIAL_DOMAIN (core/Spatial/SpatialIndexSystem.ts), repeated so the schemas don't import the engine. */
const DEFAULT_DOMAIN_ID = 'DEFAULT';

/**
 * One spatial domain a scene registers for itself (docs/plans/_DONE_p349_scene-scoped-spatial-domains.md
 * §3.4): its settings win while the scene is active and are dropped on its exit. `DEFAULT` takes
 * a partial entry, merged over its world settings; other domains need `cellSize` and `maxMembers`.
 */
const SpatialDomainEntrySchema = z
  .object({
    id: z.string().min(1),
    /** World-space edge length of one grid cell. */
    cellSize: z.number().positive().optional(),
    /** How many members the domain can hold at once. */
    maxMembers: z.number().int().min(1).optional(),
    /** Default `DYNAMIC`. */
    update: z.enum(['DYNAMIC', 'STATIC', 'MANUAL']).optional(),
    /** Default 2. */
    oversizedRadiusMultiplier: z.number().positive().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.id === DEFAULT_DOMAIN_ID) return;
    for (const key of ['cellSize', 'maxMembers'] as const) {
      if (entry[key] !== undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Spatial domain '${entry.id}' needs '${key}' (only '${DEFAULT_DOMAIN_ID}' can leave it out).`,
      });
    }
  });

export type SceneSpatialDomainEntry = z.infer<typeof SpatialDomainEntrySchema>;

export const SceneSpatialDomainsSchema = z
  .array(SpatialDomainEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'id'],
          message: `Spatial domain '${id}' is listed more than once.`,
        });
      }
      seen.add(id);
    }
  });
