import * as THREE from 'three/webgpu';
import { lerror } from '../../../utils/Logger';

const debugMeshIcons: {
  DEFAULT: THREE.Group | null;
  DIRECTIONAL: THREE.Group | null;
  POINT: THREE.Group | null;
  SPOT: THREE.Group | null;
  PERSPECTIVE: THREE.Group | null;
  ORTOGRAPHIC: THREE.Group | null;
} = {
  DEFAULT: null,
  DIRECTIONAL: null,
  POINT: null,
  SPOT: null,
  PERSPECTIVE: null,
  ORTOGRAPHIC: null,
};

const MESH_ICON_COLOR = '#03a5fc';

const createDirectionalLightIcon = () => {
  const geometry = new THREE.CylinderGeometry(0.7, 0.7, 0.4, 16);
  const material = new THREE.MeshBasicMaterial({ color: MESH_ICON_COLOR });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = -0.125;
  const group = new THREE.Group();
  group.add(mesh);
  debugMeshIcons.DIRECTIONAL = group;
  return group;
};

const createPointLightIcon = () => {
  const geometry = new THREE.SphereGeometry(0.3, 16, 8);
  const material = new THREE.MeshBasicMaterial({ color: MESH_ICON_COLOR });
  const mesh = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.add(mesh);
  debugMeshIcons.DEFAULT = group;
  return group;
};

const createDefaultMesh = () => {
  // This icon should not be shown if all icon creators have been defined
  const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2, 1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: MESH_ICON_COLOR });
  const mesh = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.add(mesh);
  debugMeshIcons.POINT = group;
  return group;
};

export const getDebugMeshIcon = (type: keyof typeof debugMeshIcons) => {
  let mesh = debugMeshIcons[type];
  if (!mesh) {
    if (type === 'DIRECTIONAL') mesh = createDirectionalLightIcon();
    if (type === 'POINT') mesh = createPointLightIcon();
  }
  if (!mesh) {
    lerror(`Could not find debug mesh icon for type '${type}'`);
    mesh = debugMeshIcons.DEFAULT;
    if (!mesh) mesh = createDefaultMesh();
  }
  return mesh.clone();
};
