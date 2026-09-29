import * as THREE from 'three/webgpu';

/** A ColorJSON value ('#rrggbb', or { r, g, b } in 0-255) as a THREE.Color (linear, the working colour space). */
export const toSkyColor = (color: string | { r: number; g: number; b: number }) =>
  typeof color === 'string'
    ? new THREE.Color(color)
    : new THREE.Color(color.r / 255, color.g / 255, color.b / 255);
