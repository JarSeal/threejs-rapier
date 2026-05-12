import { useDebug } from '../utils/helpers';
import { debugGUI } from './_LightManager';
import { IS_DEBUG_ENV } from './Config';

type PropType = 'LIGHT';

export interface LoadableProps {
  appId?: string;
  [key: string]: unknown;
}

/** * Generic property loader.
 * Merges hardcoded props with LocalStorage data (in debug) and eventually files.
 */
export const loadPersistentProps = <T extends LoadableProps>(
  initProps: T,
  propType: PropType
): T => {
  const appId = initProps.appId;
  if (!appId) return initProps;

  // Load props from a file
  // @TODO: Load and return properties from file
  const savedProps = {};

  // Load from LocalStorage (Debug Mode Only)
  if (IS_DEBUG_ENV) {
    const savedDebugProps = getSavedDebugProps(appId, propType);
    if (savedDebugProps) {
      // Merge: Hardcoded < Saved File Props < Saved LS Props
      return { ...initProps, ...savedProps, ...savedDebugProps };
    }
  }

  return { ...initProps, ...savedProps };
};

const getSavedDebugProps = (appId: string, propType: PropType) => {
  switch (propType) {
    case 'LIGHT':
      return useDebug(debugGUI)?.loadLightDebugData(appId) || {};
  }
};
