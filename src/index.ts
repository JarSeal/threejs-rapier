import * as THREE from 'three';
import { getWindowSize } from './utils/window';
import { createRenderer } from './core/Renderer';
import { createScene, getCurrentScene } from './core/Scene';

export const loopState = {
  play: true,
};

const windowSize = getWindowSize();

const scene = createScene('boxScene', true);
const camera = new THREE.PerspectiveCamera(45, windowSize.aspect, 0.1, 1000);

const renderer = createRenderer();

const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

camera.position.z = 5;

const animate = () => {
  if (loopState.play) requestAnimationFrame(animate);
  renderer.render(getCurrentScene() as THREE.Scene, camera);
};

if (loopState.play) {
  animate();
}
