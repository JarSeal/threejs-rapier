/* eslint-disable @typescript-eslint/no-explicit-any */

import * as THREE from 'three/webgpu';
import {
  uniform, // Uniforms
  uv, // Standard UV coordinates
  attribute,
  float,
  step,
  abs,
  max,
  vec2,
  mod,
  min,
} from 'three/tsl';
import { existsOrThrow } from '../../../../_engine/utils/helpers';
import { createMaterial } from '../../../../_engine/core/Material';

export const getUVRepeatFactor = (mesh: THREE.Mesh, metersPerTile: number) => {
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();

  const size = new THREE.Vector3();
  existsOrThrow(
    geometry.boundingBox,
    'Geometry does not have a boundingBox (in getUVRepeatFactor).'
  ).getSize(size); // Gets the size in world units (meters)

  // Check which axes the UVs are mapped to.
  // For a typical box/plane, we usually use the two largest dimensions.
  // Assuming U maps to X and V maps to Y for simplicity here.
  const worldWidth = size.x;
  const worldHeight = size.y;

  // Calculate how many tiles fit into the world width/height
  const repeatX = worldWidth / metersPerTile;
  const repeatY = worldHeight / metersPerTile;

  return new THREE.Vector2(repeatX, repeatY);
};

// Constants
const METERS_PER_CHECKER_TILE = 0.05;

// A TSL function that takes a vec2 coordinate and returns the checkerboard color.
// The typings are still lagging behind (my current version is "three": "0.176.0"), hence the "any" type.
const nestedGridPattern = (uv: any) => {
  const majorSpacing = float(0.2);
  const minorSpacing = float(0.32);
  const majorThickness = float(0.002);
  const minorThickness = float(0.001);

  // Major grid: thicker lines
  const majorCell = mod(uv, vec2(majorSpacing));
  const majorLine = max(
    step(abs(majorCell.x.sub(majorSpacing.mul(0.5))), majorThickness),
    step(abs(majorCell.y.sub(majorSpacing.mul(0.5))), majorThickness)
  );

  // Minor grid: thinner lines
  const minorCell = mod(uv, vec2(minorSpacing));
  const minorLine = max(
    // step(abs(minorCell.x - minorSpacing * 0.5), 0.01),
    // step(abs(minorCell.y - minorSpacing * 0.5), 0.01)
    step(abs(minorCell.x.sub(minorSpacing.mul(0.5))), minorThickness),
    step(abs(minorCell.y.sub(minorSpacing.mul(0.5))), minorThickness)
  );

  // Combine both
  return min(majorLine.mul(0.4).add(minorLine), float(1.0));
};

// function nestedGridPattern(uvCoords) {
//   const majorSpacing = 0.4;
//   const minorSpacing = 0.08;

//   // Divide by spacing and take fractional part — node-safe
//   const majorUV = fract(uvCoords.div(majorSpacing));
//   const minorUV = fract(uvCoords.div(minorSpacing));

//   // Calculate distance from line centers
//   const majorDist = abs(majorUV.sub(majorUV.floor().add(majorSpacing * 0.5)));
//   const minorDist = abs(minorUV.sub(minorUV.floor().add(minorSpacing * 0.5)));

//   // Line thresholds
//   const majorLine = step(majorDist, vec2(0.02));
//   const minorLine = step(minorDist, vec2(0.01));

//   // Combine vertical and horizontal lines
//   const majorGrid = majorLine.x.add(majorLine.y);
//   const minorGrid = minorLine.x.add(minorLine.y);

//   // Blend them — thicker major lines, thinner minor lines
//   const grid = minorGrid.mul(0.4).add(majorGrid);
//   const color = vec3(grid.min(1.0));

//   return color;
// }

// const MAJOR_LINE_SPACING = 5.0; // Thicker lines every 5 units/meters
// const MINOR_LINE_SPACING = 1.0; // Thinner lines every 1 unit/meter
// function createNestedGridNode(p: any) {
//   // p is the coordinate node (World or UV space)

//   const majorColor = color(0.1, 0.6, 1.0); // Bright Blue (Major Lines)
//   const minorColor = color(0.4, 0.4, 0.4); // Dark Gray (Minor Lines)
//   const bgColor = color(0.05, 0.05, 0.05); // Near Black (Background)

//   const lineThickness = 0.01; // Adjust for line visibility

//   // 1. Calculate Minor Grid (1m spacing)
//   const pMinor = p.div(MINOR_LINE_SPACING); // Scale coordinates to 1 unit
//   // Use the fractional part to find the distance to the nearest integer grid line
//   const fMinor = pMinor.fract();
//   // Check if the coordinate is very close to a grid line (0.0 or 1.0)
//   const lineMinor = fMinor.min(1.0 - fMinor); // Distance from 0 or 1
//   // The result is 1.0 if we're on a line, 0.0 otherwise.
//   const minorAlpha = lineMinor.lessThan(lineThickness).toFilter(1.0);

//   // 2. Calculate Major Grid (5m spacing)
//   const pMajor = p.div(MAJOR_LINE_SPACING); // Scale coordinates to 5 units
//   const fMajor = pMajor.fract();
//   const lineMajor = fMajor.min(1.0 - fMajor);
//   const majorAlpha = lineMajor.lessThan(lineThickness * 2.0).toFilter(1.0); // Thicker line

//   // 3. Combine and Prioritize
//   // Start with the background color
//   let finalColor = bgColor;

//   // Apply minor color where minor lines exist AND major lines DO NOT exist
//   finalColor = finalColor.mix(minorColor, minorAlpha.mul(1.0).sub(majorAlpha));

//   // Apply major color (this overwrites minor lines because majorAlpha is higher priority)
//   finalColor = finalColor.mix(majorColor, majorAlpha);

//   return finalColor;
// }

// const createNestedGridNode = (p: any) => {
//   const majorSpacing = float(0.2); // Distance between big lines
//   const divisions = float(5.0); // How many small cells per big box
//   const minorSpacing = div(majorSpacing, divisions);

//   const majorThickness = float(0.01);
//   const minorThickness = float(0.002);

//   // === Major grid ===
//   // The typings are still lagging behind (my current version is "three": "0.176.0"), hence the "any" type.
//   const majorX = step(abs(fract(div(p.x, majorSpacing)) - 0.5), majorThickness);
//   const majorY = step(abs(fract(div(p.y, majorSpacing)) - 0.5), majorThickness);
//   const majorLine = max(majorX, majorY);

//   // === Minor grid ===
//   // The typings are still lagging behind (my current version is "three": "0.176.0"), hence the "any" type.
//   const minorX = step(abs(fract(div(p.x, minorSpacing)) - 0.5), minorThickness);
//   const minorY = step(abs(fract(div(p.y, minorSpacing)) - 0.5), minorThickness);
//   const minorLine = max(minorX, minorY);

//   // Combine — make major lines brighter
//   const color = vec3(add(minorLine.mul(0.4), majorLine)); // 0.4 gray for minor, full white for major
//   return color.min(1.0); // clamp
// };

const applyRepeatFactorAsAttribute = (mesh: THREE.Mesh, repeatFactor: THREE.Vector2) => {
  const geometry = mesh.geometry;

  // We only need one value per object, so we'll use a single-item BufferAttribute
  // and let it broadcast to all vertices.
  const attributeArray = new Float32Array([repeatFactor.x, repeatFactor.y]);

  // Create the BufferAttribute (2 components per item, 1 item total)
  const uvRepeatBufferAttribute = new THREE.InstancedBufferAttribute(attributeArray, 2);

  // Set the attribute on the geometry, using the name specified in the TSL shader
  geometry.setAttribute('uvRepeatFactor', uvRepeatBufferAttribute);

  // TSL requires this attribute to be marked as an instance attribute if it's
  // intended to be read just once per object (even on a non-instanced mesh)
  // (uvRepeatBufferAttribute as any).gpuType = THREE.InstancedBufferAttribute;
  // uvRepeatBufferAttribute.count = 1;
  uvRepeatBufferAttribute.needsUpdate = true;
};

export const addNestedGridMaterialToMesh = (
  id: string,
  mesh: THREE.Mesh,
  opts: {
    metersPerCheckerTile?: number;
    useConstantCheckerSize?: boolean;
    nodeMaterialType?:
      | 'BASICNODEMATERIAL'
      | 'PHONGNODEMATERIAL'
      | 'LAMBERTNODEMATERIAL'
      | 'PHYSICALNODEMATERIAL'
      | 'STANDARDNODEMATERIAL';
  } = {
    metersPerCheckerTile: METERS_PER_CHECKER_TILE,
    useConstantCheckerSize: true,
    nodeMaterialType: 'PHONGNODEMATERIAL',
  }
) => {
  const repeatFactor = getUVRepeatFactor(mesh, METERS_PER_CHECKER_TILE);

  // TSL Uniforms
  const uvRepeat = uniform(repeatFactor);

  // --- Coordinate Definitions ---
  const uvRepeatAttribute = attribute('uvRepeatFactor', 'vec2');
  const uvCoords = uv().mul(opts.useConstantCheckerSize ? uvRepeatAttribute : uvRepeat);

  // Call the corrected function node
  // const fragmentColor = nestedGridPattern(uvCoords);
  const fragmentColor = nestedGridPattern(uvCoords);

  const checkerboardMaterial = createMaterial({
    id,
    type: opts.nodeMaterialType || 'PHONGNODEMATERIAL',
    params: {
      colorNode: fragmentColor,
      side: THREE.DoubleSide,
    },
  });

  mesh.material = checkerboardMaterial;

  applyRepeatFactorAsAttribute(mesh, repeatFactor);

  return checkerboardMaterial;
};
