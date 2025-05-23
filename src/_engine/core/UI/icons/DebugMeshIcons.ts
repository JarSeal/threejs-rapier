import * as THREE from 'three/webgpu';
import { lerror } from '../../../utils/Logger';

const debugMeshIcons: {
  DEFAULT: THREE.Group | null;
  DIRECTIONAL: THREE.Group | null;
  POINT: THREE.Group | null;
  SPOT: THREE.Group | null;
  PERSPECTIVE: THREE.Group | null;
  ORTOGRAPHIC: THREE.Group | null;
  CAMERA: THREE.Group | null;
} = {
  DEFAULT: null,
  DIRECTIONAL: null,
  POINT: null,
  SPOT: null,
  PERSPECTIVE: null,
  ORTOGRAPHIC: null,
  CAMERA: null,
};

const MESH_DEFAULT_ICON_COLOR = '#ff0000';
const MESH_LIGHT_ICON_COLOR = '#f59042';
const MESH_CAMERA_ICON_COLOR = '#03a5fc';

const createDirectionalLightIcon = () => {
  const geometry = new THREE.CylinderGeometry(0.7, 0.7, 0.4, 16);
  const material = new THREE.MeshBasicMaterial({ color: MESH_LIGHT_ICON_COLOR });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = -0.2;
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.id = '_directionalLightIcon';
  debugMeshIcons.DIRECTIONAL = group;
  return group;
};

const createPointLightIcon = () => {
  const geometry = new THREE.SphereGeometry(0.3, 16, 8);
  const material = new THREE.MeshBasicMaterial({ color: MESH_LIGHT_ICON_COLOR });
  const mesh = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.id = '_pointLightIcon';
  debugMeshIcons.DEFAULT = group;
  return group;
};

const createCameraIcon = () => {
  const multiplier = 4;
  const biggerBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.16 * multiplier, 0.16 * multiplier, 0.26 * multiplier),
    new THREE.MeshBasicMaterial({ color: MESH_CAMERA_ICON_COLOR })
  );
  const smallerBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.06 * multiplier, 0.06 * multiplier, 0.06 * multiplier),
    new THREE.MeshBasicMaterial({ color: '#03fcfc' })
  );
  biggerBox.position.set(0, 0, 0.16 * multiplier);
  smallerBox.position.set(0, 0, 0.03 * multiplier);
  const group = new THREE.Group();
  group.add(biggerBox);
  group.add(smallerBox);
  group.userData.id = '_cameraIcon';
  debugMeshIcons.CAMERA = group;
  return group;
};

const createDefaultMesh = () => {
  // This icon should not be shown if all icon creators have been defined
  const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2, 1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: MESH_DEFAULT_ICON_COLOR });
  const mesh = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.id = '_defaultIcon';
  debugMeshIcons.POINT = group;
  return group;
};

export const getDebugMeshIcon = (type: keyof typeof debugMeshIcons) => {
  let group = debugMeshIcons[type];
  if (!group) {
    if (type === 'DIRECTIONAL') group = createDirectionalLightIcon();
    if (type === 'POINT') group = createPointLightIcon();
    if (type === 'CAMERA') group = createCameraIcon();
  }
  if (!group) {
    lerror(`Could not find debug mesh icon for type '${type}'`);
    group = debugMeshIcons.DEFAULT;
    if (!group) group = createDefaultMesh();
  }
  group.userData.isHelperIcon = true;
  return group.clone();
};
