import { llog } from '../../utils/Logger';
import { isDebugEnvironment } from '../Config';
import { deleteGeometry, getGeometryRegistry } from '../Geometry';
import {
  deleteMaterial,
  deleteTexturesFromMaterial,
  getMaterialRegistry,
  isTextureUsedByAnyMaterial,
} from '../Material';
import { deleteTexture, getTextureRegistry } from '../Texture';
import { releaseImportsOwnedBy } from '../Import/ImportRegistry';
import { getActiveSkyBoxTexture } from '../SkyBox';
import { getAssetOwner } from './AssetOwners';

/**
 * Releases the non-persistent assets a scene still owns (see AssetOwners) that nothing uses:
 * its import manifests, its materials and geometries with ref count 0, and its textures that no
 * registered material or the current sky box uses. SceneLoader runs this for the previous scene
 * once the next one has loaded, so whatever the next scene shares has been re-tagged to it (or
 * has taken refs) and stays.
 *
 * A released material disposes the texture clones it holds alone; registered textures are only
 * released here by owner, never through a material.
 * @param sceneId owner scene id
 * @returns the released ids by kind
 */
export const releaseSceneOwnedAssets = (sceneId: string) => {
  const isOwned = (asset: object) => getAssetOwner(asset) === sceneId;
  const released = {
    imports: releaseImportsOwnedBy(sceneId),
    materials: [] as string[],
    geometries: [] as string[],
    textures: [] as string[],
  };

  // Materials before textures: releasing a material can leave its textures unused
  for (const [id, entry] of Object.entries(getMaterialRegistry())) {
    if (entry.persistent || entry.count > 0 || !isOwned(entry.resource)) continue;
    deleteTexturesFromMaterial(entry.resource, { keepRegistered: true });
    deleteMaterial(id);
    released.materials.push(id);
  }

  for (const [id, entry] of Object.entries(getGeometryRegistry())) {
    if (entry.persistent || entry.count > 0 || !isOwned(entry.resource)) continue;
    deleteGeometry(id);
    released.geometries.push(id);
  }

  // A sky box texture's baked PMREM is disposed with it (SkyBox.ts)
  const skyBoxTexture = getActiveSkyBoxTexture();
  for (const [id, entry] of Object.entries(getTextureRegistry())) {
    if (entry.persistent || !isOwned(entry.resource)) continue;
    if (entry.resource === skyBoxTexture || isTextureUsedByAnyMaterial(entry.resource)) continue;
    deleteTexture(id);
    released.textures.push(id);
  }

  if (isDebugEnvironment()) {
    const count = Object.values(released).reduce((sum, ids) => sum + ids.length, 0);
    if (count) llog(`[Assets] Released ${count} assets of scene "${sceneId}":`, released);
  }
  return released;
};
