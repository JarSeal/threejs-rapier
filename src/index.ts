import * as THREE from 'three';
import { createRenderer } from './core/Renderer';
import { createScene, getCurrentScene } from './core/Scene';
import { createCamera, getCurrentCamera } from './core/Camera';
import { createGeometry } from './core/Geometry';
import { createMaterial } from './core/Material';

export const loopState = {
  mainPlay: true,
  gamePlay: true,
  isMainPlaying: false,
  isGamePlaying: false,
};

const scene = createScene('boxScene', true);
const camera = createCamera('mainCam', { isCurrentCamera: true });
camera.position.z = 5;
camera.position.x = 2.5;
camera.position.y = 1;

const renderer = createRenderer();

const geometry = createGeometry('box1', { box: { width: 1 } });
const material = createMaterial({
  id: 'box1Material',
  type: 'BASIC',
  params: { color: 0xff0000, wireframe: true },
});
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

camera.lookAt(cube.position);

const animate = () => {
  if (loopState.mainPlay) {
    requestAnimationFrame(animate);
    loopState.isMainPlaying = true;
  } else {
    loopState.isMainPlaying = false;
    return;
  }
  if (loopState.gamePlay) {
    loopState.isGamePlaying = true;
    // @TODO: add gamePlay loop here
    cube.rotation.z -= 0.01;
    cube.rotation.y += 0.01;
  } else {
    loopState.isGamePlaying = false;
  }
  renderer.render(getCurrentScene(), getCurrentCamera());
};

if (loopState.mainPlay) {
  animate();
}

export const toggleMainPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.mainPlay = value;
  } else {
    loopState.mainPlay = !loopState.mainPlay;
  }
  if (loopState.mainPlay && !loopState.isMainPlaying) animate();
};

export const toggleGamePlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.gamePlay = value;
    return;
  }
  loopState.gamePlay = !loopState.gamePlay;
};
