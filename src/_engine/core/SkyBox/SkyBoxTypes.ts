// Import only types here (`import type ...`), like AppECSRegistry.ts: the schema is the source of
// truth for the definition's shape.
import type * as THREE from 'three/webgpu';
import type { z } from 'zod';
import type {
  SkyBoxBaseSchema,
  SkyBoxDefSchema,
  SkyBoxEnvSchema,
  SkyBoxEnvSizeSchema,
  SkyBoxOverridesSchema,
} from '../../schemas/skyBoxSchema';

type SkyBoxBaseInput = z.input<typeof SkyBoxBaseSchema>;

/** A sky box's base layer. A texture base can be given an already-loaded texture in code. */
export type SkyBoxBaseDef =
  | Extract<SkyBoxBaseInput, { type: 'COLOR' }>
  | (Exclude<SkyBoxBaseInput, { type: 'COLOR' }> & { texture?: THREE.Texture });

export type SkyBoxBaseType = SkyBoxBaseDef['type'];

/** A sky box's env layer (background blur and intensities, and the env bake settings). */
export type SkyBoxEnvDef = z.input<typeof SkyBoxEnvSchema>;

/** The env bake's cube face size. */
export type SkyBoxEnvSize = z.infer<typeof SkyBoxEnvSizeSchema>;

/**
 * A sky box definition: the JSON shape (`SkyBoxDefSchema`), plus what only code can give, a
 * loaded texture and the scene to register in.
 */
export type SkyBoxDef = Omit<z.input<typeof SkyBoxDefSchema>, 'base'> & {
  base: SkyBoxBaseDef;
  /** Code only: the scene the sky box belongs to. Default: the loading scene, or else the current one. In JSON, the scene that lists the sky box owns it. */
  sceneId?: string;
};

/** The values changed from a definition (deep partial of its layers), eg. a scene's save data. */
export type SkyBoxOverrides = z.infer<typeof SkyBoxOverridesSchema>;
