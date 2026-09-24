import { importAssetAsync } from '../../core/Import/ImportRegistry';
import { spawnImportedAsset } from '../../core/Import/SpawnImported';
import type { SpawnImportedParams } from '../../core/Import/ImportTypes';

const obstacles = {
  slideAngles: { fileName: '/debugger/assets/testModels/characterSlideAngles.glb' },
};

/**
 * Imports (once) and spawns a character test obstacle.
 * @param obstacleId obstacle key
 * @param spawnParams {@link SpawnImportedParams} (placement, material, physics overrides, ...)
 * @returns the spawned entity ids, or null if the obstacle could not be imported
 */
export const getTestObstacle = async (
  obstacleId: keyof typeof obstacles,
  spawnParams?: SpawnImportedParams
) => {
  const obstacleObj = obstacles[obstacleId];
  if (!obstacleObj) return null;
  const manifest = await importAssetAsync({ fileName: obstacleObj.fileName });
  if (!manifest) return null;
  return spawnImportedAsset(manifest, spawnParams);
};
