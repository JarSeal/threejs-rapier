import { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { reconcileObject3DVisibility } from '../ECS/ECSCoreSystems';

// LOD selection and apply (docs/plans/p348_ecs-lod-selection.md). `LOD` is the opt-in definition
// and the selected/applied level; TAG_LOD_CULLED is the runtime state "beyond the last level",
// a fourth cull reason next to DISABLED, TAG_FRUSTUM_CULLED and TAG_OBJECT_CULLED.

ECSWorld.registerComponentHooks(ComponentType.TAG_LOD_CULLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isLodCulled: true });
  },
  onRemoveComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isLodCulled: false });
  },
});
