import type { SvgIconKey } from '../UI/icons/SvgIcon';
import type { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';

/**
 * Debug info about the managers that own entities (MANAGED_BY), registered by each manager's
 * debug module, so a tool (eg. the Lights tab) can show whose an entity is and link to the
 * tab that edits it without importing that manager's debug code.
 */
export type ManagerDebugInfo = {
  /** Shown as "Managed by {label}". */
  label: string;
  icon?: SvgIconKey;
  /** The debugger tab that edits the manager's entities. */
  tabId?: string;
};

const managers = new Map<string, ManagerDebugInfo>();

export const _registerManagerDebugInfo = (manager: string, info: ManagerDebugInfo) => {
  managers.set(manager, info);
};

/** The manager info of an entity, or null when it isn't managed. The label falls back to the
 * manager id when its debug module hasn't registered. */
export const _getEntityManagerInfo = (entityId: number, world: ECSWorld) => {
  const managedBy = world.getComponent(entityId, ComponentType.MANAGED_BY);
  if (!managedBy) return null;
  return { ...managedBy, ...(managers.get(managedBy.manager) || { label: managedBy.manager }) };
};
