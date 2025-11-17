import {
  AdditionalImportPhysicsParams,
  importModelAsync,
} from '../../../../_engine/core/ImportModel';
import { PhysicsParams } from '../../../../_engine/core/PhysicsRapier';

const obstacles = {
  slideAngles: { fileName: '/debugger/assets/testModels/characterSlideAngles.glb' },
};

export const getTestObstacle = async (
  obstacleId: keyof typeof obstacles,
  physicsParams?:
    | Partial<PhysicsParams & AdditionalImportPhysicsParams>
    | Partial<PhysicsParams & AdditionalImportPhysicsParams>[]
) => {
  const obstacleObj = obstacles[obstacleId];
  if (!obstacleObj) return {};
  const result = await importModelAsync({
    fileName: obstacleObj.fileName,
    physicsParams,
  });
  return result;
};
