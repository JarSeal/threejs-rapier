/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, weld } from '@gltf-transform/functions';
import { DOMParser } from 'linkedom';
import { ExtrudeGeometry, MathUtils, Path, Shape, Vector2 } from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Builds the toolkit's Ækasha symbol model (docs/plans/_DONE_p554_hub-examples-start-scene-and-example-scenes.md
 * section 2.3) from the Æ glyph in `src/public/favicon.svg`: the glyph's path extruded with a
 * small bevel, 1 unit high, centred on the origin and facing +z, written as a Draco-compressed
 * GLB next to its `aekashaSymbol.importedAsset.json`. The asset pipeline keeps it Draco (the
 * JSON's `optimize.mesh.codec`). Run it when the glyph changes and commit the GLB:
 *
 *   source .claude/hooks/use-node.sh && npx tsx devTools/toolkit/buildAekashaSymbol.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SVG_FILE = path.join(REPO_ROOT, 'src/public/favicon.svg');
const OUT_FILE = path.join(REPO_ROOT, 'src/toolkit/models/aekashaSymbol/aekashaSymbol.glb');
const NAME = 'aekashaSymbol';

/** Points per curve of the glyph's outline (its rounded corners are short cubic curves) */
const CURVE_SEGMENTS = 8;
/** Extrusion depth and bevel, as fractions of the glyph's height */
const DEPTH = 0.16;
const BEVEL_SIZE = 0.012;
const BEVEL_THICKNESS = 0.016;
const BEVEL_SEGMENTS = 3;
/** Edges sharper than this stay hard; the rounded corners and the bevel are smoothed */
const CREASE_ANGLE_DEG = 40;

/** SVGLoader parses with the browser's DOMParser: linkedom's stands in for the call */
const parseSvg = (text: string) => {
  const g = globalThis as { DOMParser?: unknown };
  const previous = g.DOMParser;
  g.DOMParser = DOMParser;
  try {
    return new SVGLoader().parse(text);
  } finally {
    g.DOMParser = previous;
  }
};

/** The glyph's shapes with y flipped (SVG is y down), as outlines of points with their holes */
const getGlyphShapes = (svgText: string) => {
  const shapes: Shape[] = [];
  let holeCount = 0;
  const flip = (points: Vector2[]) => points.map((p) => new Vector2(p.x, -p.y));
  for (const shapePath of parseSvg(svgText).paths) {
    for (const svgShape of shapePath.toShapes()) {
      const { shape: outline, holes } = svgShape.extractPoints(CURVE_SEGMENTS);
      const shape = new Shape(flip(outline));
      shape.holes = holes.map((hole) => new Path(flip(hole)));
      holeCount += holes.length;
      shapes.push(shape);
    }
  }
  return { shapes, holeCount };
};

const build = async () => {
  const { shapes, holeCount } = getGlyphShapes(fs.readFileSync(SVG_FILE, 'utf8'));
  if (!shapes.length) throw new Error(`No shapes in ${SVG_FILE}.`);
  // The Æ has one inner hole (the A's triangle): without it the glyph was filled in
  if (!holeCount) throw new Error(`The glyph in ${SVG_FILE} has no hole: its fill rule changed?`);

  // The extrusion is in the SVG's units, so its sizes are scaled to the glyph's height first
  const glyphHeight = (() => {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const shape of shapes) {
      for (const p of shape.getPoints()) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
    return maxY - minY;
  })();

  const extruded = new ExtrudeGeometry(shapes, {
    depth: DEPTH * glyphHeight,
    bevelEnabled: true,
    bevelSize: BEVEL_SIZE * glyphHeight,
    bevelThickness: BEVEL_THICKNESS * glyphHeight,
    bevelSegments: BEVEL_SEGMENTS,
    // The outlines are points already
    curveSegments: 1,
  });
  const geometry = toCreasedNormals(extruded, MathUtils.degToRad(CREASE_ANGLE_DEG));
  extruded.dispose();
  geometry.center();
  // 1 unit high with the bevel, which grows the outline
  geometry.computeBoundingBox();
  const height = geometry.boundingBox!.max.y - geometry.boundingBox!.min.y;
  geometry.scale(1 / height, 1 / height, 1 / height);
  // The UVs are the extrusion's own (front: x / y, sides: along the outline / z), in model units
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / height, uv.getY(i) / height);
  geometry.computeBoundingBox();

  const doc = new Document();
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  const buffer = doc.createBuffer();
  const accessor = (name: string, type: 'VEC2' | 'VEC3') =>
    doc
      .createAccessor()
      .setType(type)
      .setArray(new Float32Array(geometry.getAttribute(name).array))
      .setBuffer(buffer);
  const material = doc
    .createMaterial(NAME)
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.5);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('position', 'VEC3'))
    .setAttribute('NORMAL', accessor('normal', 'VEC3'))
    .setAttribute('TEXCOORD_0', accessor('uv', 'VEC2'))
    .setMaterial(material);
  const mesh = doc.createMesh(NAME).addPrimitive(primitive);
  const node = doc.createNode(NAME).setMesh(mesh);
  // The scene has no name: GLTFLoader makes scene and node names unique together, so a scene
  // named like the node would rename the node (and the geometry id, `aekashaSymbol/<node>`)
  doc.getRoot().setDefaultScene(doc.createScene().addChild(node));
  doc.getRoot().getAsset().generator = 'Ækasha devTools/toolkit/buildAekashaSymbol.ts';

  await doc.transform(weld(), draco());

  const draco3d = (await import('draco3dgltf')).default;
  const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.WARN))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  const glb = await io.writeBinary(doc);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, glb);

  const size = geometry.boundingBox!.getSize(geometry.boundingBox!.max.clone());
  console.log(
    [
      `Wrote ${path.relative(REPO_ROOT, OUT_FILE)} (${glb.byteLength} B, Draco)`,
      `  ${geometry.getAttribute('position').count / 3} triangles, ${holeCount} hole(s)`,
      `  size ${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}`,
    ].join('\n')
  );
  geometry.dispose();
};

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
