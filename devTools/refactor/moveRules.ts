/**
 * The target layout as rules (p602 Phase 2): where every file of `src/_engine/` and
 * `src/toolkit/`, and the app files that move, go in p606-p609. `moveMap.ts` applies them to the
 * tracked tree and writes `moveMap.json`, which p608's codemod reads.
 *
 * - A rule's `from` is a repo-relative file, or a folder ending in `/`. The longest matching
 *   `from` wins, so a file rule beats its folder's rule and the order here doesn't matter.
 * - A folder rule keeps the path under it and makes each `.ts` module's name PascalCase (p602 D7:
 *   `layers/atmosphere.ts` → `layers/Atmosphere.ts`); a file rule's `to` is the final name.
 * - The exceptions to a rule are file rules with their reason in `note`: they are the "edited by
 *   hand" part of the map, kept here so the map can be generated again on a fresh `main`.
 */
import fs from 'fs';
import path from 'path';

export type MoveAction = 'keep' | 'move' | 'delete' | 'merge' | 'split';
/** The plan that applies the move */
export type MovePlan = 'p606' | 'p608' | 'p609';

export type MoveEntry = {
  /** Target path; `null` for a deleted file */
  to: string | null;
  action: MoveAction;
  plan: MovePlan;
  note?: string;
  /** `split` only: each export's target module */
  split?: Record<string, string>;
};

export type MoveRule = {
  from: string;
  /** Target file or folder (a folder ends in `/`); omitted for `delete` */
  to?: string;
  action?: 'delete' | 'merge' | 'split';
  plan?: MovePlan;
  note?: string;
  split?: Record<string, string>;
};

const E = 'src/_engine/';
const K = `${E}kernel/`;
const F = `${E}features/`;
const T = 'src/toolkit/';
const A = 'src/app/';

const WRAPPER_NOTE =
  "a debug wrapper: p606 / p618 merge it into the feature's public module (p602 D4)";

const ENGINE_RULES: MoveRule[] = [
  // Engine root
  { from: `${E}InitApp.ts`, to: `${K}init/InitEngine.ts` },
  { from: `${E}types/`, to: `${E}types/` },
  {
    from: `${E}generatedAppData.json`,
    to: 'src/generated/generatedAppData.json',
    plan: 'p606',
    note: 'app data, handed to the engine through InitEngine (p602 D9)',
  },
  {
    from: `${E}generatedAppFns.ts`,
    to: 'src/generated/generatedAppFns.ts',
    plan: 'p606',
    note: 'app data, handed to the engine through InitEngine (p602 D9)',
  },

  // Kernel: ECS
  { from: `${E}core/ECS.ts`, to: `${K}ecs/ECS.ts` },
  { from: `${E}core/ECS.test.ts`, to: `${K}ecs/ECS.test.ts` },
  { from: `${E}core/ECS/`, to: `${K}ecs/` },
  {
    from: `${E}core/ECS/LightObjectCullingSystem.ts`,
    to: `${F}spatial/LightObjectCullingSystem.ts`,
    note: 'the spatial feature owns light culling (p602 D2)',
  },
  { from: `${E}utils/ECSHelpers.ts`, to: `${K}ecs/ECSHelpers.ts` },
  {
    from: `${E}utils/ECSStressTest.ts`,
    to: `${K}ecs/debug/ECSStressTest.ts`,
    note: 'not the app (p602 D6): the ECS debug tab benchmarks with it',
  },
  { from: `${E}core/Debug/_dbg__ECS.ts`, to: `${K}ecs/debug/_dbg__ECS.ts` },

  // Kernel: loop, config
  { from: `${E}core/MainLoop.ts`, to: `${K}loop/MainLoop.ts` },
  { from: `${E}core/Debug/_dbg__MainLoop.ts`, to: `${K}loop/debug/_dbg__MainLoop.ts` },
  { from: `${E}core/Config.ts`, to: `${K}config/Config.ts` },

  // Kernel: scene
  { from: `${E}core/Scene.ts`, to: `${K}scene/Scene.ts` },
  { from: `${E}core/SceneLoader.ts`, to: `${K}scene/SceneLoader.ts` },
  { from: `${E}core/GroupManager.ts`, to: `${K}scene/Group.ts` },
  {
    from: `${E}core/PropertyLoader.ts`,
    to: `${K}scene/PropertyLoader.ts`,
    note: 'merges the debug overrides into camera and light props: p612 / p618 move it behind the debug loader',
  },
  {
    from: `${E}core/Debug/_dbg__DebuggerSceneLoader.ts`,
    to: `${K}scene/debug/_dbg__DebuggerSceneLoader.ts`,
  },
  {
    from: `${E}core/Debug/DebuggerSceneLoader.module.scss`,
    to: `${K}scene/debug/DebuggerSceneLoader.module.scss`,
  },

  // Kernel: assets
  { from: `${E}core/Assets/`, to: `${K}assets/` },
  { from: `${E}core/Geometry.ts`, to: `${K}assets/Geometry.ts` },
  { from: `${E}core/Material.ts`, to: `${K}assets/Material.ts` },
  { from: `${E}core/Texture.ts`, to: `${K}assets/Texture.ts` },
  { from: `${E}core/TextureArray.ts`, to: `${K}assets/TextureArray.ts` },
  { from: `${E}core/TextureAtlas.ts`, to: `${K}assets/TextureAtlas.ts` },
  { from: `${E}core/Import/`, to: `${K}assets/import/` },
  {
    from: `${E}core/Import/MeshColliderGeometry.ts`,
    to: `${F}physics/import/MeshColliderGeometry.ts`,
    note: 'builds physics colliders: SpawnImported reaches it through an import extension (p606)',
  },
  {
    from: `${E}3dModels/customPropTemplates.blend`,
    to: `${K}assets/import/customPropTemplates.blend`,
  },
  { from: `${E}workers/assetsWorker.ts`, to: `${K}assets/worker/AssetsWorker.ts` },
  { from: `${E}workers/assets/`, to: `${K}assets/worker/` },
  { from: `${E}core/Debug/_dbg__Assets.ts`, to: `${K}assets/debug/_dbg__Assets.ts` },
  { from: `${E}core/Debug/_dbg__AssetStats.ts`, to: `${K}assets/debug/_dbg__AssetStats.ts` },
  { from: `${E}core/Debug/_dbg__AssetsPreview.ts`, to: `${K}assets/debug/_dbg__AssetsPreview.ts` },
  {
    from: `${E}core/Debug/_dbg__TexturePreview.ts`,
    to: `${K}assets/debug/_dbg__TexturePreview.ts`,
  },
  { from: `${E}core/Debug/Assets.module.scss`, to: `${K}assets/debug/Assets.module.scss` },
  { from: `${E}debug/Assets.ts`, to: `${K}assets/debug/Assets.ts`, note: WRAPPER_NOTE },

  // Kernel: render
  { from: `${E}core/Renderer.ts`, to: `${K}render/Renderer.ts` },
  { from: `${E}core/Snapshot.ts`, to: `${K}render/Snapshot.ts` },
  { from: `${E}core/ViewManager.ts`, to: `${K}render/Views.ts` },
  {
    from: `${E}core/Raycast.ts`,
    to: `${K}render/Raycast.ts`,
    note: "three's Raycaster against Object3Ds, not physics (p602 D2)",
  },
  { from: `${E}core/RayDebugTypes.ts`, to: `${K}render/RayDebugTypes.ts` },
  { from: `${E}utils/object3DHelpers.ts`, to: `${K}render/Object3DHelpers.ts` },
  { from: `${E}core/Debug/_dbg__Renderer.ts`, to: `${K}render/debug/_dbg__Renderer.ts` },
  { from: `${E}core/Debug/_dbg__Raycast.ts`, to: `${K}render/debug/_dbg__Raycast.ts` },
  { from: `${E}core/Debug/_dbg__RayHelpers.ts`, to: `${K}render/debug/_dbg__RayHelpers.ts` },
  { from: `${E}core/Debug/_dbg__RayTester.ts`, to: `${K}render/debug/_dbg__RayTester.ts` },

  // Kernel: camera, light, mesh, input
  { from: `${E}core/CameraManager.ts`, to: `${K}camera/Camera.ts` },
  { from: `${E}core/Debug/Camera/`, to: `${K}camera/debug/` },
  { from: `${E}core/LightManager.ts`, to: `${K}light/Light.ts` },
  { from: `${E}core/Debug/Light/`, to: `${K}light/debug/` },
  { from: `${E}core/MeshManager.ts`, to: `${K}mesh/Mesh.ts` },
  { from: `${E}core/Input/`, to: `${K}input/` },
  {
    from: `${E}core/Input/DefaultDebugKeyBindings.ts`,
    to: `${E}debug/DefaultDebugKeyBindings.ts`,
  },

  // Features: physics
  { from: `${E}core/PhysicsAPI.ts`, to: `${F}physics/PhysicsAPI.ts` },
  { from: `${E}core/PhysicsManager.ts`, to: `${F}physics/PhysicsEntity.ts` },
  { from: `${E}core/PhysicsTiers.ts`, to: `${F}physics/PhysicsTiers.ts` },
  { from: `${E}core/PhysicsTierPolicy.ts`, to: `${F}physics/PhysicsTierPolicy.ts` },
  { from: `${E}core/Physics/`, to: `${F}physics/` },
  { from: `${E}core/Physics/ENGINES.ts`, to: `${F}physics/backends/Engines.ts` },
  { from: `${E}core/Physics/EngineRapier.ts`, to: `${F}physics/backends/rapier/EngineRapier.ts` },
  { from: `${E}workers/physicsWorker.ts`, to: `${F}physics/worker/PhysicsWorker.ts` },
  { from: `${E}workers/physicsWorker.test.ts`, to: `${F}physics/worker/PhysicsWorker.test.ts` },
  { from: `${E}workers/physics/`, to: `${F}physics/worker/` },
  { from: `${E}core/Debug/_dbg__PhysicsAPI.ts`, to: `${F}physics/debug/_dbg__PhysicsAPI.ts` },
  {
    from: `${E}core/Debug/_dbg__PhysicsBootOverrides.ts`,
    to: `${F}physics/debug/_dbg__PhysicsBootOverrides.ts`,
  },
  {
    from: `${E}core/Debug/_dbg__PhysicsDebugDraw.ts`,
    to: `${F}physics/debug/_dbg__PhysicsDebugDraw.ts`,
  },
  {
    from: `${E}core/Debug/_dbg__PhysicsDeterminism.ts`,
    to: `${F}physics/debug/_dbg__PhysicsDeterminism.ts`,
  },

  // Features: character
  { from: `${E}core/Character.ts`, to: `${F}character/Character.ts` },
  { from: `${E}core/Character/`, to: `${F}character/` },
  { from: `${E}core/Debug/Character/`, to: `${F}character/debug/` },
  { from: `${E}core/Debug/_dbg__Character.ts`, to: `${F}character/debug/_dbg__Character.ts` },

  // Features: sky box
  { from: `${E}core/SkyBox/`, to: `${F}skybox/` },
  { from: `${E}core/Debug/SkyBox/`, to: `${F}skybox/debug/` },
  { from: `${E}core/Debug/_dbg__SkyBox.ts`, to: `${F}skybox/debug/_dbg__SkyBox.ts` },

  // Features: LOD
  { from: `${E}core/Lod/`, to: `${F}lod/` },
  { from: `${E}core/Lod/Impostors/`, to: `${F}lod/impostors/` },
  { from: `${E}core/Debug/Lod/`, to: `${F}lod/debug/` },
  { from: `${E}core/Debug/_dbg__LOD.ts`, to: `${F}lod/debug/_dbg__LOD.ts` },

  // Features: spatial, instancing, lines, PostFX, viewports
  { from: `${E}core/Spatial/`, to: `${F}spatial/` },
  { from: `${E}core/Debug/_dbg__SpatialGrid.ts`, to: `${F}spatial/debug/_dbg__SpatialGrid.ts` },
  { from: `${E}core/Instancing/`, to: `${F}instancing/` },
  { from: `${E}core/LineManager.ts`, to: `${F}lines/Lines.ts` },
  { from: `${E}core/Lines/`, to: `${F}lines/` },
  { from: `${E}core/PostFX.ts`, to: `${F}postfx/PostFX.ts` },
  { from: `${E}core/PostFX/`, to: `${F}postfx/` },
  { from: `${E}core/Debug/_dbg__PostFX.ts`, to: `${F}postfx/debug/_dbg__PostFX.ts` },
  {
    from: `${E}core/Debug/_dbg__PostFXProfiler.ts`,
    to: `${F}postfx/debug/_dbg__PostFXProfiler.ts`,
  },
  {
    from: `${E}debug/PostFXProfiler.ts`,
    to: `${F}postfx/debug/PostFXProfiler.ts`,
    note: WRAPPER_NOTE,
  },
  { from: `${E}core/Viewports.ts`, to: `${F}viewports/Viewports.ts` },
  { from: `${E}core/Viewports.module.scss`, to: `${F}viewports/Viewports.module.scss` },

  // UI kit (p602 D5)
  { from: `${E}utils/CMP.ts`, to: `${E}ui/CMP.ts` },
  { from: `${E}utils/Window.ts`, to: `${E}ui/Window.ts` },
  { from: `${E}core/HUD.ts`, to: `${E}ui/HUD.ts` },
  { from: `${E}core/UI/`, to: `${E}ui/` },
  { from: `${E}styles/`, to: `${E}ui/styles/` },
  { from: `${E}styles/debugger.scss`, to: `${E}debug/debugger.scss` },

  // The debugger framework (p602 D4)
  { from: `${E}debug/`, to: `${E}debug/` },
  { from: `${E}debug/DebugToolsManager.ts`, to: `${E}debug/DebugTools.ts` },
  { from: `${E}debug/3DSymbols.ts`, to: `${E}debug/symbols/3DSymbols.ts` },
  { from: `${E}core/Debug/`, to: `${E}debug/` },
  { from: `${E}core/Debug/_dbg__Symbols.ts`, to: `${E}debug/symbols/_dbg__Symbols.ts` },
  { from: `${E}core/UI/3DSymbols/`, to: `${E}debug/symbols/` },
  {
    from: `${E}core/UI/3DSymbols/3DSymbolsTextures.png~`,
    action: 'delete',
    note: "an image editor's backup file",
  },
  { from: `${E}3dModels/3DSymbols.blend`, to: `${E}debug/symbols/source/3DSymbols.blend` },
  {
    from: `${E}3dModels/3DSymbolsTextures.kra`,
    to: `${E}debug/symbols/source/3DSymbolsTextures.kra`,
  },
  { from: `${E}core/Debug/Profiler/`, to: `${E}debug/profiler/` },
  { from: `${E}core/Debug/Editors/`, to: `${E}debug/editors/` },
  { from: `${E}core/Debug/Editors/Material/`, to: `${E}debug/editors/material/` },
  { from: `${E}core/Debug/_dbg__GPUMemory.ts`, to: `${E}debug/gpuMemory/_dbg__GPUMemory.ts` },
  {
    from: `${E}core/Debug/_dbg__GPUMemoryAllocations.ts`,
    to: `${E}debug/gpuMemory/_dbg__GPUMemoryAllocations.ts`,
  },
  {
    from: `${E}core/Debug/_dbg__GPUMemoryOwners.ts`,
    to: `${E}debug/gpuMemory/_dbg__GPUMemoryOwners.ts`,
  },
  {
    from: `${E}core/Debug/_dbg__GPUMemorySnapshots.ts`,
    to: `${E}debug/gpuMemory/_dbg__GPUMemorySnapshots.ts`,
  },
  {
    from: `${E}core/Debug/_dbg__GPUMemorySources.ts`,
    to: `${E}debug/gpuMemory/_dbg__GPUMemorySources.ts`,
  },
  { from: `${E}core/Debug/GPUMemory.module.scss`, to: `${E}debug/gpuMemory/GPUMemory.module.scss` },
  {
    from: `${E}core/Helpers.ts`,
    to: `${E}debug/SceneHelpers.ts`,
    note: 'the axes and grid helpers (p602 D6); renamed apart from utils/helpers.ts (D7)',
  },
  { from: `${E}utils/UI/PercentagePieHtml.ts`, to: `${E}debug/PercentagePieHtml.ts` },

  // Utilities (p602 D6)
  { from: `${E}utils/`, to: `${E}utils/` },
  {
    from: `${E}utils/stats/IntervalCounterStats.ts`,
    to: `${E}utils/IntervalCounterStats.ts`,
    note: 'not debug/ (p602 D6): pure, and the ray and physics stats count with it at runtime',
  },
  {
    from: `${E}utils/helpers.ts`,
    action: 'split',
    note: 'split per export (p602 D6); the codemod rewrites each import to its target',
    split: {
      getFileNameExt: `${K}assets/AssetFiles.ts`,
      isHDR: `${K}assets/AssetFiles.ts`,
      isKTX2: `${K}assets/AssetFiles.ts`,
      isJPG: `${K}assets/AssetFiles.ts`,
      isPNG: `${K}assets/AssetFiles.ts`,
      removeTextureFromMemory: `${K}assets/Disposal.ts`,
      removeMaterialFromMemory: `${K}assets/Disposal.ts`,
      removeGeometryFromMemory: `${K}assets/Disposal.ts`,
      removeObjectFromMemory: `${K}assets/Disposal.ts`,
      removeObjectChildrenFromMemory: `${K}assets/Disposal.ts`,
      removeObjectAndChildrenFromMemory: `${K}assets/Disposal.ts`,
      RemovalTypes: `${K}assets/Disposal.ts`,
      ThreeVector3: `${K}render/ThreeMath.ts`,
      ThreeQuoternion: `${K}render/ThreeMath.ts`,
      ThreeEuler: `${K}render/ThreeMath.ts`,
      getQuatFromAngle: `${K}render/ThreeMath.ts`,
      slerp: `${K}render/ThreeMath.ts`,
      smoothDampVec3: `${K}render/ThreeMath.ts`,
      roundToDecimal: `${E}utils/Numbers.ts`,
      isOnlyObject3D: `${K}render/Object3DHelpers.ts`,
      setMeshCreatePropsToUserData: `${K}mesh/MeshUserData.ts`,
      initWorker: `${K}loop/Workers.ts`,
      isMainThread: `${K}loop/Workers.ts`,
      isMainThreadSimple: `${K}loop/Workers.ts`,
      DebugModuleRef: `${E}debug/DebugModules.ts`,
      loadDebugModule: `${E}debug/DebugModules.ts`,
      loadDebugModuleAsync: `${E}debug/DebugModules.ts`,
      isDebugReady: `${E}debug/DebugModules.ts`,
      useDebug: `${E}debug/DebugModules.ts`,
      getLightCharacteristics: `${K}light/LightHelpers.ts`,
    },
  },
  {
    from: `${E}utils/constants.ts`,
    action: 'split',
    note: 'split per export: its three objects leave utils/ (p602 D6)',
    split: {
      HALF_PI: `${E}utils/Constants.ts`,
      QUARTER_PI: `${E}utils/Constants.ts`,
      FOUR_PX_TO_8K_LIST: `${E}utils/Constants.ts`,
      textureMapKeys: `${E}utils/Constants.ts`,
      RENDERER_SHADOW_OPTIONS: `${K}render/ThreeMath.ts`,
      DIRECTIONS: `${K}render/ThreeMath.ts`,
      LEVEL_GROUND_NORMAL: `${K}render/ThreeMath.ts`,
      GRAVITY_DOWN_NORMAL: `${K}render/ThreeMath.ts`,
    },
  },
  {
    from: `${E}utils/commontTypes.ts`,
    to: `${T}ecs/FollowObjectCameraRig.ts`,
    action: 'merge',
    note: 'merged into its one user (p602 D6)',
  },
  { from: `${E}utils/materials/`, action: 'delete', note: 'no importers (p602 D6)' },

  // Gameplay pieces to the toolkit, test scaffolding to the app (p602 D6)
  { from: `${E}utils/world/movingPlatform.ts`, to: `${T}ecs/MovingPlatform.ts` },
  { from: `${E}utils/cameras/followObjectCameraRig.ts`, to: `${T}ecs/FollowObjectCameraRig.ts` },
  {
    from: `${E}utils/PhysicsStressTest.ts`,
    to: `${A}scenes/thirdPersonGymScene/PhysicsStressTest.ts`,
    note: 'only the gym uses it',
  },
  {
    from: `${E}utils/world/characterTestObjects.ts`,
    to: `${A}scenes/thirdPersonGymScene/characterTestObjects.ts`,
    note: 'only the gym uses it',
  },
  {
    from: `${E}utils/world/characterTestObstacles.ts`,
    to: `${A}scenes/thirdPersonGymScene/characterTestObstacles.ts`,
    note: 'only the gym uses it',
  },
  {
    from: `${E}3dModels/characterObstacles.blend`,
    to: `${A}scenes/thirdPersonGymScene/characterObstacles.blend`,
  },

  { from: `${E}schemas/`, to: `${E}schemas/` },
];

/** The toolkit's categories (p609, from the p450 prompt) */
const TOOLKIT_RULES: MoveRule[] = [
  { from: `${T}ecs/effects/`, to: `${T}ecs/effects/`, plan: 'p609' },
  {
    from: `${T}ecs/InstancedMeshPool.ts`,
    action: 'delete',
    plan: 'p609',
    note: "a deprecated re-export, removed in the toolkit's next major",
  },
  {
    from: `${T}ecs/InstancedMeshPoolTypes.ts`,
    action: 'delete',
    plan: 'p609',
    note: "a deprecated re-export, removed in the toolkit's next major",
  },
  {
    from: `${T}geometry/generateAsteroid.ts`,
    to: `${T}geometry/generate/Asteroid.ts`,
    plan: 'p609',
  },
  { from: `${T}geometry/generateFoliage.ts`, to: `${T}geometry/generate/Foliage.ts`, plan: 'p609' },
  { from: `${T}geometry/generateTerrain.ts`, to: `${T}geometry/generate/Terrain.ts`, plan: 'p609' },
  {
    from: `${T}geometry/scatterOnSurface.ts`,
    to: `${T}geometry/scatter/ScatterOnSurface.ts`,
    plan: 'p609',
  },
  { from: `${T}geometry/seededRandom.ts`, to: `${T}geometry/SeededRandom.ts`, plan: 'p609' },
  {
    from: `${T}materials/triplanarProjection.ts`,
    to: `${T}materials/TriplanarProjection.ts`,
    plan: 'p609',
  },
  {
    from: `${T}models/aekashaSymbol/`,
    to: `${T}models/brand/aekashaSymbol/`,
    plan: 'p609',
    note: 'the category is a proposal: p609 names the model categories',
  },
];

/** A toolkit material is a folder named by its asset id: `materials/<id>/` (p609) */
const getToolkitMaterialRules = (files: string[]): MoveRule[] =>
  files
    .filter((f) => /^src\/toolkit\/materials\/[^/]+\.(material\.json|tsl\.ts)$/.test(f))
    .map((f) => {
      const base = path.basename(f);
      const id = base.split('.')[0];
      return { from: f, to: `${T}materials/${id}/${base}`, plan: 'p609' };
    });

/**
 * The app: one folder per scene, `src/app/scenes/<sceneId>/` with its scene JSON, scene file,
 * `_dbg__` module and Hub image, named by the scene id (p602 D7, p609). The examples keep their
 * folders (the Hub's example rule reads `src/app/examples/`); the shared asset JSONs stay in
 * their type folders.
 */
const getAppSceneRules = (root: string, files: string[]): MoveRule[] => {
  const rules: MoveRule[] = [];
  const sceneJsons = files.filter((f) => /^src\/app\/[^/]+\.scene\.json$/.test(f));
  const dbgModules: Record<string, string> = {
    assetCompare: `${A}_dbg__assetCompare.ts`,
    lodShowcase: `${A}_dbg__lodShowcase.ts`,
    space: `${A}_dbg__spaceDemo.ts`,
  };
  for (const jsonFile of sceneJsons) {
    const json = JSON.parse(fs.readFileSync(path.join(root, jsonFile), 'utf8'));
    const id: string = json.id;
    const folder = `${A}scenes/${id}/`;
    const note = 'the codemod rewrites its `sceneFile`';
    rules.push({ from: jsonFile, to: `${folder}${id}.scene.json`, plan: 'p609', note });
    if (typeof json.sceneFile === 'string') {
      let sceneFile = path.posix.join(A, json.sceneFile);
      if (!sceneFile.endsWith('.ts')) sceneFile += '.ts';
      rules.push({ from: sceneFile, to: `${folder}${id}.ts`, plan: 'p609' });
    }
    const hubImage = `${A}${id}.hub.png`;
    if (files.includes(hubImage)) {
      rules.push({ from: hubImage, to: `${folder}${id}.hub.png`, plan: 'p609' });
    }
    const dbg = dbgModules[id];
    if (dbg) rules.push({ from: dbg, to: `${folder}${path.basename(dbg)}`, plan: 'p609' });
  }
  rules.push({ from: `${A}lodShowcase/`, to: `${A}scenes/lodShowcase/`, plan: 'p609' });
  rules.push({
    from: `${A}characterVisual.ts`,
    to: `${A}scenes/thirdPersonGymScene/characterVisual.ts`,
    plan: 'p609',
    note: 'with the gym (p609); the top-down test imports it from there',
  });
  return rules;
};

export const getMoveRules = (root: string, files: string[]): MoveRule[] => [
  ...ENGINE_RULES,
  ...TOOLKIT_RULES,
  ...getToolkitMaterialRules(files),
  ...getAppSceneRules(root, files),
];

/** Whether a `.ts` file keeps its name: an asset-id file (`asteroid.tsl.ts`), an entry, a declaration */
const isNameExempt = (base: string) =>
  base === 'index.ts' || base.endsWith('.d.ts') || /^[^.]+\.(?!test\.)[^.]+\.ts$/.test(base);

/** p602 D7: PascalCase, after a `_dbg__` or `_` prefix; a test follows its module */
export const toModuleFileName = (base: string): string => {
  if (!base.endsWith('.ts') || isNameExempt(base)) return base;
  const prefix = base.startsWith('_dbg__') ? '_dbg__' : base.startsWith('_') ? '_' : '';
  const rest = base.slice(prefix.length);
  return prefix + rest.charAt(0).toUpperCase() + rest.slice(1);
};

export const isPascalModuleName = (base: string) =>
  !base.endsWith('.ts') || isNameExempt(base) || toModuleFileName(base) === base;

const isPascalScope = (target: string) => target.startsWith(E) || target.startsWith(T);

/** The entry for a file, or undefined when no rule matches it */
export const applyMoveRules = (rules: MoveRule[], file: string): MoveEntry | undefined => {
  let best: MoveRule | undefined;
  for (const rule of rules) {
    const matches = rule.from.endsWith('/') ? file.startsWith(rule.from) : file === rule.from;
    if (matches && (!best || rule.from.length > best.from.length)) best = rule;
  }
  if (!best) return undefined;
  const plan = best.plan ?? 'p608';
  const note = best.note ? { note: best.note } : {};
  if (best.action === 'delete') return { to: null, action: 'delete', plan, ...note };
  if (best.action === 'split')
    return { to: file, action: 'split', plan, ...note, split: best.split };
  let to = best.to as string;
  if (best.from.endsWith('/')) {
    const rest = file.slice(best.from.length);
    const dir = path.posix.dirname(rest);
    const base = path.posix.basename(rest);
    const name = isPascalScope(to) ? toModuleFileName(base) : base;
    to = to + (dir === '.' ? '' : `${dir}/`) + name;
  }
  const action = best.action ?? (to === file ? 'keep' : 'move');
  return { to, action, plan, ...note };
};
