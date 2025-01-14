import { createNewDebuggerGUI, setDebuggerTabAndContainer } from '../debug/DebuggerGUI';
import { getStats } from '../debug/Stats';
import { getCurrentCamera } from './Camera';
import { getMesh } from './Mesh';
import { getRenderer } from './Renderer';
import { getCurrentScene } from './Scene';

const loopState = {
  masterPlay: true,
  appPlay: true,
  isMasterPlaying: false,
  isAppPlaying: false,
};

export const mainLoop = () => {
  if (loopState.masterPlay) {
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // @TODO: add gamePlay loop here
    const sphere = getMesh('sphereMesh1'); // REMOVE
    if (sphere) {
      sphere.rotation.z -= 0.001; // REMOVE
      sphere.rotation.y += 0.001; // REMOVE
    }
    const box = getMesh('boxMesh1'); // REMOVE
    if (box) {
      box.rotation.y -= 0.001; // REMOVE
      box.rotation.z -= 0.001; //REMOVE
    }
    const importedBox = getMesh('importedMesh1'); // REMOVE
    if (importedBox) {
      importedBox.rotation.y -= 0.0014; // REMOVE
      importedBox.rotation.z -= 0.0014; // REMOVE
    }
  } else {
    loopState.isAppPlaying = false;
  }
  getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
  getStats()?.update();
};

if (loopState.masterPlay) {
  mainLoop();
}

export const toggleMainPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.masterPlay = value;
  } else {
    loopState.masterPlay = !loopState.masterPlay;
  }
  if (loopState.masterPlay && !loopState.isMasterPlaying) mainLoop();
};

export const toggleGamePlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.appPlay = value;
    return;
  }
  loopState.appPlay = !loopState.appPlay;
};

setDebuggerTabAndContainer({
  id: 'loopControls',
  buttonText: 'LOOP',
  title: 'Loop controls',
  orderNr: 4,
  container: () => {
    const { container, debugGui } = createNewDebuggerGUI('Loop', 'Loop Controls');
    debugGui
      .add(loopState, 'masterPlay')
      .name('Master loop')
      .onChange((value: boolean) => {
        if (value) requestAnimationFrame(mainLoop);
      });
    debugGui.add(loopState, 'appPlay').name('App loop');
    // @TODO: add forced max FPS debugger
    return container;
  },
});
