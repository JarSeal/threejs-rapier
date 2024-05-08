import * as THREE from 'three';

const windowSize = {
  width: window.innerWidth,
  height: window.innerHeight,
  aspect: window.innerWidth / window.innerHeight,
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, windowSize.aspect, 0.1, 1000);

const renderer = new THREE.WebGLRenderer();
renderer.setSize(windowSize.width, windowSize.height);

const canvasElem = document.getElementById('mainCanvasWrapper');
if (!canvasElem) {
  throw new Error('Canvas element with id: "mainCanvasWrapper was not found".');
}
canvasElem.appendChild(renderer.domElement);

const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

camera.position.z = 5;

function animate() {
  console.log('Anim');
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
