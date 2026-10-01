import * as THREE from 'three/webgpu';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSeededRandom } from './seededRandom';

export interface AsteroidNoiseOptions {
  /** Lumps per unit of the undisplaced sphere's radius (the noise runs on the unit direction). */
  frequency?: number;
  /** Peak lump height as a fraction of `radius`. */
  amplitude?: number;
  /** fbm octaves, each at twice the frequency and half the amplitude of the one before. */
  octaves?: number;
}

export interface AsteroidCraterOptions {
  /** Number of craters (0 = none). */
  count?: number;
  /** Crater angular radius range in degrees, as seen from the rock's centre. */
  sizeDeg?: [min: number, max: number];
  /** Bowl depth at the crater's centre, as a fraction of `radius`. */
  depth?: number;
  /** Rim height, as a fraction of the crater's depth. */
  rim?: number;
}

export interface AsteroidOptions {
  /** Radius of the sphere before displacement and `shape` (default 1). */
  radius?: number;
  /** Icosphere subdivision, 1-10 (default 4): three's `IcosahedronGeometry` splits each edge into
   * `detail + 1` segments, giving 10·(detail + 1)² + 2 vertices (42 at 1, 162 at 3, 252 at 4, 492
   * at 6). Higher = rounder, with finer lumps and craters. The hull collider takes every vertex. */
  detail?: number;
  /** Deterministic seed: the same seed and options always give the same rock (default 1). */
  seed?: number;
  /** Per-axis scale applied after displacement, for elongated or flattened rocks (default [1, 1, 1]). */
  shape?: [x: number, y: number, z: number];
  noise?: AsteroidNoiseOptions;
  craters?: AsteroidCraterOptions;
  /** Faceted, semi-low-poly look: a non-indexed geometry with one normal per face (default true).
   * false keeps it indexed with smooth vertex normals. */
  flatShading?: boolean;
}

export interface GeneratedAsteroid {
  geometry: THREE.BufferGeometry;
  /** The displaced unique vertex positions (x, y, z, ...), for a `CONVEXHULL` collider. */
  hullVertices: Float32Array;
  /** Volume of the closed mesh (craters included). */
  volume: number;
  /** Volume of the convex hull of `hullVertices`: what a physics engine derives a `CONVEXHULL`
   * collider's mass from (mass = density × hullVolume), so use this to match a gravity mass or a
   * density to the simulated body. */
  hullVolume: number;
  /** Largest distance of any vertex from the origin (the rock's local centre). */
  boundingRadius: number;
}

const DEFAULT_NOISE: Required<AsteroidNoiseOptions> = {
  frequency: 1.6,
  amplitude: 0.22,
  octaves: 4,
};
const DEFAULT_CRATERS: Required<AsteroidCraterOptions> = {
  count: 5,
  sizeDeg: [10, 28],
  depth: 0.12,
  rim: 0.35,
};
// A vertex never sinks below this fraction of `radius`, so a deep crater on a big lump can't fold
// the surface through the centre (the mesh stays star-shaped, so the volume sum stays valid).
const MIN_RADIUS_FRACTION = 0.35;
// Rim width, as a fraction of the crater's angular radius, on each side of the rim
const RIM_WIDTH = 0.35;

type Crater = { x: number; y: number; z: number; cosMax: number; size: number };

const randomUnitVector = (random: () => number, out: THREE.Vector3) => {
  // Uniform on the sphere: z uniform in [-1, 1], azimuth uniform
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
};

// Crater height profile at t = angle from the centre / crater radius: a parabolic bowl from
// -1 (centre) to 0 (edge), plus a raised rim peaking at the edge and fading out RIM_WIDTH either side
const craterProfile = (t: number, rim: number) => {
  const bowl = t < 1 ? t * t - 1 : 0;
  const r = 1 - Math.abs(t - 1) / RIM_WIDTH;
  return bowl + (r > 0 ? rim * r * r : 0);
};

// Signed volume of a closed, outward-wound triangle mesh (sum of origin tetrahedra)
const tetraVolume = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
  (a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x)) /
  6;

const computeHullVolume = (points: THREE.Vector3[]) => {
  const hull = new ConvexHull().setFromPoints(points);
  let volume = 0;
  for (const face of hull.faces) {
    // Fan from the face's first vertex (quickhull faces are triangles, this also takes n-gons)
    const first = face.edge;
    const a = first.head().point;
    let edge = first.next;
    while (edge.next !== first) {
      volume += tetraVolume(a, edge.head().point, edge.next.head().point);
      edge = edge.next;
    }
  }
  return Math.abs(volume);
};

/**
 * Builds a procedural asteroid: an icosphere displaced along its normals by seeded simplex fbm
 * (lumps) and spherical-cap craters with raised rims, then scaled per axis by `shape`. The default
 * is faceted (flat normals) for a semi-low-poly look.
 *
 * Returns the geometry plus what physics needs: the hull vertices for a `CONVEXHULL` collider,
 * the mesh and hull volumes (for a mass or density) and the bounding radius. The geometry has
 * positions and normals only, no UVs: pair it with an object-space material such as the toolkit's
 * `asteroid` material. The geometry isn't registered: pass it through `saveBufferGeometry` (with an
 * id) before `createMeshEntity`, so it's disposed with its scene.
 */
export const generateAsteroid = (opts: AsteroidOptions = {}): GeneratedAsteroid => {
  const {
    radius = 1,
    detail: rawDetail = 4,
    seed = 1,
    shape = [1, 1, 1],
    flatShading = true,
  } = opts;
  const detail = THREE.MathUtils.clamp(Math.round(rawDetail), 1, 10);
  const noise = { ...DEFAULT_NOISE, ...opts.noise };
  const craterOpts = { ...DEFAULT_CRATERS, ...opts.craters };

  const random = createSeededRandom(seed);
  const simplex = new SimplexNoise({ random });

  // Craters are drawn from the same seeded stream, after the noise's permutation table
  const craters: Crater[] = [];
  const [minSize, maxSize] = craterOpts.sizeDeg;
  const dir = new THREE.Vector3();
  for (let i = 0; i < craterOpts.count; i++) {
    randomUnitVector(random, dir);
    const size = THREE.MathUtils.degToRad(minSize + (maxSize - minSize) * random());
    // A crater affects vertices out to its rim's outer edge
    const cosMax = Math.cos(Math.min(Math.PI, size * (1 + RIM_WIDTH)));
    craters.push({ x: dir.x, y: dir.y, z: dir.z, cosMax, size });
  }

  // IcosahedronGeometry is non-indexed with per-face normals and UVs: drop those, so the shared
  // corners merge into one vertex each and every face moves with its neighbours (no cracks)
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const indexed = mergeVertices(ico, 1e-5);
  ico.dispose();

  const position = indexed.getAttribute('position') as THREE.BufferAttribute;
  const vertexCount = position.count;
  const hullVertices = new Float32Array(vertexCount * 3);
  const hullPoints: THREE.Vector3[] = [];
  let boundingRadius = 0;

  for (let v = 0; v < vertexCount; v++) {
    dir.fromBufferAttribute(position, v).normalize();

    // Lumps: fbm normalized to [-1, 1] by the octaves' total amplitude
    let lump = 0;
    let amp = 1;
    let freq = noise.frequency;
    let ampSum = 0;
    for (let o = 0; o < noise.octaves; o++) {
      lump += simplex.noise3d(dir.x * freq, dir.y * freq, dir.z * freq) * amp;
      ampSum += amp;
      amp *= 0.5;
      freq *= 2;
    }
    let h = ampSum > 0 ? (lump / ampSum) * noise.amplitude : 0;

    for (let c = 0; c < craters.length; c++) {
      const crater = craters[c];
      const cos = dir.x * crater.x + dir.y * crater.y + dir.z * crater.z;
      if (cos < crater.cosMax) continue;
      const t = Math.acos(Math.min(1, cos)) / crater.size;
      h += craterProfile(t, craterOpts.rim) * craterOpts.depth;
    }

    const r = radius * Math.max(MIN_RADIUS_FRACTION, 1 + h);
    const x = dir.x * r * shape[0];
    const y = dir.y * r * shape[1];
    const z = dir.z * r * shape[2];
    position.setXYZ(v, x, y, z);
    hullVertices[v * 3] = x;
    hullVertices[v * 3 + 1] = y;
    hullVertices[v * 3 + 2] = z;
    hullPoints.push(new THREE.Vector3(x, y, z));
    boundingRadius = Math.max(boundingRadius, Math.sqrt(x * x + y * y + z * z));
  }
  position.needsUpdate = true;

  // Mesh volume from the indexed (closed) triangles
  const index = indexed.getIndex()!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    volume += tetraVolume(a, b, c);
  }
  volume = Math.abs(volume);

  let geometry: THREE.BufferGeometry;
  if (flatShading) {
    // Non-indexed: every face gets its own three vertices, so computeVertexNormals gives flat normals
    geometry = indexed.toNonIndexed();
    indexed.dispose();
  } else {
    geometry = indexed;
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return {
    geometry,
    hullVertices,
    volume,
    hullVolume: computeHullVolume(hullPoints),
    boundingRadius,
  };
};
