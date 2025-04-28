import { createSceneLoader } from '../core/SceneLoader';
import { CMP } from '../utils/CMP';
import styles from './DebuggerSceneLoader.module.scss';

export const DEBUGGER_SCENE_LOADER_ID = '__debugger-scene-loader';
const START_ANIM_LENGTH_IN_MS = 150;
const END_ANIM_LENGTH_IN_MS = 250;

export const createDebuggerSceneLoader = () =>
  createSceneLoader(
    {
      id: DEBUGGER_SCENE_LOADER_ID,
      loaderContainerFn: () => {
        const baseCmp = CMP({
          id: `${DEBUGGER_SCENE_LOADER_ID}-cmp`,
          class: styles.debuggerSceneLoader,
          style: { transitionDuration: `${START_ANIM_LENGTH_IN_MS}ms` },
        });
        baseCmp.add({ class: styles.debuggerSceneLoader__spinner });
        return baseCmp;
      },
      loadStartFn: (loader) =>
        new Promise((resolve) => {
          setTimeout(() => loader.loaderContainer?.updateStyle({ opacity: 1 }), 1);
          setTimeout(() => resolve(true), START_ANIM_LENGTH_IN_MS);
        }),
      loadEndFn: (loader) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              loader.loaderContainer?.updateStyle({
                opacity: 0,
                transitionDuration: `${END_ANIM_LENGTH_IN_MS}ms`,
              }),
            1
          );
          setTimeout(() => resolve(true), END_ANIM_LENGTH_IN_MS);
        }),
    },
    false
  );
