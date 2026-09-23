import {
  AdditionalImportPhysicsParams,
  importModelAsync,
  PhysicsParams,
} from '../../core/ImportModel';

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
