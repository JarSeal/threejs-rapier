/* eslint-disable no-console */
import path from 'path';
import { ensureKtx, KTX_VERSION } from './assetPipeline/ktxTool';

/**
 * Sets up the asset optimization tools (p300): the KTX-Software `ktx` encoder, downloaded into
 * the gitignored `.tools/` on Linux (incl. WSL2) and macOS. Does nothing when a working `ktx`
 * is already there (`AEK_KTX`, `.tools/` or PATH). Only needed by whoever encodes assets.
 *
 * Usage: `yarn setupAssetTools [--force]` (`--force` reinstalls the local copy)
 */

const force = process.argv.includes('--force');

try {
  const tool = await ensureKtx({ force, log: (message) => console.log(`  ${message}`) });
  const where =
    tool.source === 'env'
      ? 'AEK_KTX'
      : tool.source === 'path'
        ? 'PATH'
        : `${path.relative(process.cwd(), path.dirname(tool.path))}/`;
  console.log(`\x1b[32m✓ [KTX] ktx ${tool.version} (${where})\x1b[0m`);
  if (tool.source !== 'local' && tool.version !== KTX_VERSION) {
    console.log(
      `  The pipeline pins ${KTX_VERSION}; another version encodes slightly different files. Run with --force for the pinned copy.`
    );
  }
} catch (error) {
  console.error(`\x1b[31m✗ [KTX] ${(error as Error).message}\x1b[0m`);
  process.exitCode = 1;
}
