/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Copies the runtime decoders from the installed three.js version into `src/public/` (Vite
 * serves `src/public/**` at `/`):
 * - the glTF-variant DRACO decoders into `src/public/draco/gltf/`, where
 *   `src/_engine/core/Import/DracoDecoder.ts` expects them (the encoder is not copied);
 * - the Basis Universal transcoder into `src/public/basis/`, where
 *   `src/_engine/core/Import/KTX2.ts` expects it.
 * The destinations are gitignored, so upgrading three.js updates the decoders without
 * committing binaries. (The meshopt decoder is a JS module, bundled by Vite: nothing to copy.)
 *
 * Idempotent: a file whose size and mtime already match the source is skipped.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREE_LIBS_DIR = path.resolve(__dirname, '../node_modules/three/examples/jsm/libs');
const PUBLIC_DIR = path.resolve(__dirname, '../src/public');

const DECODER_SETS = [
  {
    label: 'DRACO',
    sourceDir: path.join(THREE_LIBS_DIR, 'draco/gltf'),
    targetDir: 'draco/gltf',
    files: ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'],
  },
  {
    label: 'BASIS',
    sourceDir: path.join(THREE_LIBS_DIR, 'basis'),
    targetDir: 'basis',
    files: ['basis_transcoder.js', 'basis_transcoder.wasm'],
  },
];

/** Copies one decoder set; returns false when a source file is missing. */
const copyDecoderSet = ({ label, sourceDir, targetDir, files }: (typeof DECODER_SETS)[number]) => {
  const targetPath = path.join(PUBLIC_DIR, targetDir);
  fs.mkdirSync(targetPath, { recursive: true });

  let copiedCount = 0;
  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];
    const source = path.join(sourceDir, fileName);
    const target = path.join(targetPath, fileName);

    if (!fs.existsSync(source)) {
      console.error(`\x1b[31m✗ [${label}] Decoder file not found: ${source}\x1b[0m`);
      process.exitCode = 1;
      return false;
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
      ? `\x1b[32m✓ [${label}] Copied ${copiedCount} decoder file(s) to src/public/${targetDir}/\x1b[0m`
      : `✓ [${label}] Decoders up to date`
  );
  return true;
};

export const copyDecoders = () => {
  for (const decoderSet of DECODER_SETS) {
    if (!copyDecoderSet(decoderSet)) return;
  }
};

copyDecoders();
