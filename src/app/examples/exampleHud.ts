import { getHUDRootCMP } from '../../_engine/core/HUD';
import { registerOnAllSceneExits } from '../../_engine/core/Scene';
import type { TCMP } from '../../_engine/utils/CMP';

// The example scenes' HUD panel: one box of text at the bottom of the screen, removed when its
// scene exits (the exit hooks run before the next scene's file, so a new panel is never removed)

let panel: TCMP | null = null;

registerOnAllSceneExits('exampleHud', () => {
  panel?.remove();
  panel = null;
});

/**
 * Shows the example's HUD panel (one per scene)
 * @param text (string) its text, lines separated by `\n`
 * @returns the panel, to update with `panel.updateText(text)`
 */
export const createExampleHud = (text: string) => {
  panel?.remove();
  panel = getHUDRootCMP().add({
    text,
    style: {
      // #hudRoot is a 0 × 0 box: the panel is placed against the viewport
      position: 'fixed',
      bottom: '72px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '6px 12px',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.5)',
      color: '#fff',
      font: '14px/1.5 sans-serif',
      textAlign: 'center',
      whiteSpace: 'pre',
      pointerEvents: 'none',
    },
  });
  return panel;
};
