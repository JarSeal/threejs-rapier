// Exported impostors at runtime (docs/plans/_DONE_p351_impostor-billboard-lod.md Phase 4, decision 5): a
// scene lists them in its JSON's `impostors`, the gatherer puts their definitions on the scene's
// generated data and their atlas slots into its `textures`, and the loader loads those before the
// scene file runs. A generator called with a listed id then builds from the definition and the
// loaded slots instead of baking. Shared by both kinds.
import type * as THREE from 'three/webgpu';
import type { ImpostorDef } from '../../../schemas/impostorSchema';
import { lwarn } from '../../../utils/Logger';
import { isDebugEnvironment } from '../../Config';
import { getCurrentSceneId, getGeneratedSceneData } from '../../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../../SceneLoader';
import { doesTextureExist, getTexture } from '../../Texture';
import { getTextureAtlasInfo } from '../../TextureAtlas';
import { getImpostorDefSlots, IMPOSTOR_EXPORT_FORMAT_VERSION } from './ImpostorFormat';
import { getImpostorSourceHash } from './ImpostorSourceHash';

/** A listed export, ready to build from: its definition and the atlas slots it reads, loaded
 * (`getImpostorDefSlots`) */
export type ImpostorExport<Kind extends ImpostorDef['kind']> = {
  def: Extract<ImpostorDef, { kind: Kind }>;
  slots: Partial<Record<string, THREE.Texture>>;
};

/** A slot's texture id (the schema's getAtlasSlotTextureId; core imports no zod) */
const getSlotTextureId = (atlasId: string, slot: string) => `${atlasId}.${slot}`;

/** The definition of `id` in the loading scene's `impostors` (else the current scene's) */
const getListedImpostorDef = (id: string) => {
  const sceneId = isCurrentlyLoading() ? getNextSceneId() : getCurrentSceneId();
  if (!sceneId) return undefined;
  return getGeneratedSceneData(sceneId)?.impostors?.find((def) => def.id === id);
};

/**
 * The export of the impostor `id` of `kind`, when the loading (else the current) scene lists it,
 * it's in this engine's format and its atlas slots are loaded. Null otherwise, with a warning
 * when the scene lists it but it can't be used (the caller bakes instead). Each slot must be the
 * loaded atlas slot: a texture registered under its id by something else (a bake under the same
 * id) is refused.
 */
export const getImpostorExport = <Kind extends ImpostorDef['kind']>(
  id: string,
  kind: Kind,
  caller: string
): ImpostorExport<Kind> | null => {
  const def = getListedImpostorDef(id);
  if (!def) return null;
  const refuse = (reason: string) => {
    lwarn(`${caller}: the scene lists the exported impostor '${id}', but ${reason}: baking it.`);
    return null;
  };
  if (def.kind !== kind) return refuse(`it's ${def.kind}, not ${kind}`);
  if (def.formatVersion !== IMPOSTOR_EXPORT_FORMAT_VERSION) {
    return refuse(
      `its export format is ${def.formatVersion}, the engine's ${IMPOSTOR_EXPORT_FORMAT_VERSION} (re-export it: the LOD tab's Impostors)`
    );
  }
  const slots: ImpostorExport<Kind>['slots'] = {};
  for (const slot of getImpostorDefSlots(def)) {
    const textureId = getSlotTextureId(def.atlas, slot);
    if (!doesTextureExist(textureId)) {
      return refuse(`its atlas slot '${textureId}' isn't loaded (see the texture error above)`);
    }
    const texture = getTexture(textureId) as THREE.Texture;
    if (getTextureAtlasInfo(texture)?.id !== def.atlas) {
      return refuse(`'${textureId}' is registered, but not as a slot of the atlas '${def.atlas}'`);
    }
    slots[slot] = texture;
  }
  return { def: def as ImpostorExport<Kind>['def'], slots };
};

/**
 * Debug env only: warns when `def`'s source fingerprint isn't the one of `geometry` and
 * `material` with `settings` (the generator's resolved options), ie. the export was made from
 * another source or other options. The export is used anyway: re-exporting it is the fix.
 */
export const warnIfImpostorExportStale = (
  def: ImpostorDef,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  settings: Record<string, unknown>,
  caller: string
) => {
  if (!isDebugEnvironment()) return;
  const hash = getImpostorSourceHash(geometry, material, settings);
  if (hash === def.sourceHash) return;
  lwarn(
    `${caller}: the export of '${def.id}' is stale: its source geometry, material or options changed since it was exported (fingerprint ${def.sourceHash}, now ${hash}). Using it as exported; re-export it (the LOD tab's Impostors).`
  );
};
