import * as THREE from 'three/webgpu';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { createSeededRandom } from './seededRandom';

export interface TerrainNoiseOctave {
  /** Noise cycles per world unit — larger frequency values = smaller/more frequent bumps. */
  frequency: number;
  /** Contribution weight of this octave relative to the others (weights are normalized). */
  amplitude: number;
}

export interface TerrainOptions {
  /** World-space size along X. */
  width: number;
  /** World-space size along Z. */
  depth: number;
  /** Vertex grid resolution along X. Keep low for a "very low poly" look (see docs/plans/p090_large-ecs-test-world-scene.md). */
  widthSegments: number;
  /** Vertex grid resolution along Z. */
  depthSegments: number;
  /** Peak height displacement in world units. */
  maxHeight: number;
  /** Defaults to two gentle octaves — good enough for rolling variation without needing a noise library dependency (`SimplexNoise` ships with three's examples/jsm, already used elsewhere in this repo via `BufferGeometryUtils.js`). */
  noiseOctaves?: TerrainNoiseOctave[];
  /** Deterministic seed — same seed always produces the same terrain. */
  seed?: number;
}

export interface GeneratedTerrain {
  geometry: THREE.BufferGeometry;
  width: number;
  depth: number;
  widthSegments: number;
  depthSegments: number;
  /**
   * Bilinear-sampled terrain height at world-space (x, z), clamped to the terrain's extent.
   * Deliberately physics-engine-agnostic (no Rapier/PhysicsAPI import here) — feed this into
   * whichever heightfield collider API is current when physics is wired up for this scene
   * (see docs/plans/p090_large-ecs-test-world-scene.md §1.1: the physics layer is being
   * rewritten as PhysicsAPI.ts, so this generator intentionally doesn't commit to
   * PhysicsRapier.ts's HEIGHTFIELD shape).
   */
  getHeightAt: (x: number, z: number) => number;
  /** Row-major height samples backing `getHeightAt` (row-major, `cols = widthSegments + 1`), exposed so a future heightfield collider can reuse this exact grid instead of resampling noise. */
  heights: Float32Array;
}

/**
 * Builds a low-poly terrain mesh with gentle procedural height variation, plus a height
 * sampler for placing things on its surface (scattering, spawn points, etc.).
 *
 * Vertices are constructed directly (not via `PlaneGeometry` + rotation) so the grid's
 * (row, col) -> world (x, z) mapping used to build the mesh is exactly the same mapping
 * `getHeightAt` uses to sample it back — a rotated plane's vertex order does not line up
 * with a naively re-derived (x, z) formula, which would otherwise silently mirror sampled
 * heights relative to the actual mesh.
 */
export const generateTerrain = (opts: TerrainOptions): GeneratedTerrain => {
  const {
    width,
    depth,
    widthSegments,
    depthSegments,
    maxHeight,
    noiseOctaves = [
      { frequency: 1 / 50, amplitude: 1 },
      { frequency: 1 / 18, amplitude: 0.35 },
    ],
    seed = 1,
  } = opts;

  const random = createSeededRandom(seed);
  const simplex = new SimplexNoise({ random });
  const totalAmplitude = noiseOctaves.reduce((sum, o) => sum + o.amplitude, 0) || 1;

  const cols = widthSegments + 1;
  const rows = depthSegments + 1;
  const heights = new Float32Array(cols * rows);
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);

  for (let row = 0; row < rows; row++) {
    const z = (row / depthSegments) * depth - depth / 2;
    for (let col = 0; col < cols; col++) {
      const x = (col / widthSegments) * width - width / 2;

      let h = 0;
      for (const octave of noiseOctaves) {
        h += simplex.noise(x * octave.frequency, z * octave.frequency) * octave.amplitude;
      }
      h = (h / totalAmplitude) * maxHeight;

      const i = row * cols + col;
      heights[i] = h;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = col / widthSegments;
      uvs[i * 2 + 1] = row / depthSegments;
    }
  }

  const indices: number[] = [];
  for (let row = 0; row < depthSegments; row++) {
    for (let col = 0; col < widthSegments; col++) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Winding chosen so the computed normal faces +Y before computeVertexNormals()
      // re-derives the real (slope-aware) normals.
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const getHeightAt = (x: number, z: number): number => {
    const u = THREE.MathUtils.clamp((x + width / 2) / width, 0, 1) * widthSegments;
    const v = THREE.MathUtils.clamp((z + depth / 2) / depth, 0, 1) * depthSegments;
    const col0 = Math.floor(u);
    const row0 = Math.floor(v);
    const col1 = Math.min(col0 + 1, widthSegments);
    const row1 = Math.min(row0 + 1, depthSegments);
    const tx = u - col0;
    const tz = v - row0;

    const h00 = heights[row0 * cols + col0];
    const h10 = heights[row0 * cols + col1];
    const h01 = heights[row1 * cols + col0];
    const h11 = heights[row1 * cols + col1];

    const h0 = THREE.MathUtils.lerp(h00, h10, tx);
    const h1 = THREE.MathUtils.lerp(h01, h11, tx);
    return THREE.MathUtils.lerp(h0, h1, tz);
  };

  return { geometry, width, depth, widthSegments, depthSegments, getHeightAt, heights };
};
