/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Copies the glTF-variant DRACO decoders from the installed three.js version into
 * `src/public/draco/gltf/`, where `src/_engine/core/Import/DracoDecoder.ts` expects them
 * (Vite serves `src/public/**` at `/`). The destination is gitignored, so upgrading three.js
 * updates the decoders without committing binaries. The encoder is not copied.
 *
 * Idempotent: a file whose size and mtime already match the source is skipped.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '../node_modules/three/examples/jsm/libs/draco/gltf');
const TARGET_DIR = path.resolve(__dirname, '../src/public/draco/gltf');
const DECODER_FILES = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'];

export const copyDracoDecoders = () => {
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  let copiedCount = 0;
  for (let i = 0; i < DECODER_FILES.length; i++) {
    const fileName = DECODER_FILES[i];
    const source = path.join(SOURCE_DIR, fileName);
    const target = path.join(TARGET_DIR, fileName);

    if (!fs.existsSync(source)) {
      console.error(`\x1b[31m✗ [DRACO] Decoder file not found: ${source}\x1b[0m`);
      process.exitCode = 1;
      return;
    }

    const sourceStat = fs.statSync(source);
    if (fs.existsSync(target)) {
      const targetStat = fs.statSync(target);
      if (
        targetStat.size === sourceStat.size &&
        targetStat.mtimeMs === Math.trunc(sourceStat.mtimeMs)
      ) {
        continue;
      }
    }

    fs.copyFileSync(source, target);
    // Carry the source mtime over so the next run can skip unchanged files.
    fs.utimesSync(target, sourceStat.atime, new Date(Math.trunc(sourceStat.mtimeMs)));
    copiedCount++;
  }

  console.log(
    copiedCount
      ? `\x1b[32m✓ [DRACO] Copied ${copiedCount} decoder file(s) to src/public/draco/gltf/\x1b[0m`
      : '✓ [DRACO] Decoders up to date'
  );
};

copyDracoDecoders();
