import * as THREE from 'three';
import { createRenderer } from './core/Renderer';
import { createScene, getCurrentScene } from './core/Scene';
import { createCamera, getCurrentCamera } from './core/Camera';
import { createGeometry } from './core/Geometry';
import { createMaterial } from './core/Material';

export const loopState = {
  masterPlay: true,
  appPlay: true,
  isMasterPlaying: false,
  isAppPlaying: false,
};

const scene = createScene('boxScene', true);
const camera = createCamera('mainCam', { isCurrentCamera: true });
camera.position.z = 5;
camera.position.x = 2.5;
camera.position.y = 1;

const renderer = createRenderer();

const geometry = createGeometry({ id: 'box1', type: 'SPHERE' });
const material = createMaterial({
  id: 'box1Material',
  type: 'BASIC',
  params: { color: 0xff0000, wireframe: true },
});
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

camera.lookAt(cube.position);

const animate = () => {
  if (loopState.masterPlay) {
    requestAnimationFrame(animate);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // @TODO: add gamePlay loop here
    cube.rotation.z -= 0.001;
    cube.rotation.y += 0.001;
  } else {
    loopState.isAppPlaying = false;
  }
  renderer.render(getCurrentScene(), getCurrentCamera());
};

if (loopState.masterPlay) {
  animate();
}

export const toggleMainPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.masterPlay = value;
  } else {
    loopState.masterPlay = !loopState.masterPlay;
  }
  if (loopState.masterPlay && !loopState.isMasterPlaying) animate();
};

export const toggleGamePlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.appPlay = value;
    return;
  }
  loopState.appPlay = !loopState.appPlay;
};
