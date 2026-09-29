/* eslint-disable no-console */
import path from 'path';
import { fileURLToPath } from 'url';
import { checkAlwaysRules, git, PARTS, readPkg } from './checkVersions';

/**
 * Tags the current commit with each part's version from package.json: `engine-v2.1.0`,
 * `toolkit-v1.0.0`, `app-v1.2.1` (annotated, "<fullName> <version> (<codename>)"). Run it on
 * `main` right after a PR is merged (`yarn tagRelease`).
 *
 * A part whose tag already exists is skipped: its version didn't change in that merge. Only
 * local tags are created; push them with the printed command.
 */

const main = () => {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') {
    console.error(`\x1b[31m✗ [Tags] Releases are tagged on main, not on "${branch}".\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  if (git(['status', '--porcelain', '--', 'package.json'])) {
    console.error(
      '\x1b[31m✗ [Tags] package.json has uncommitted changes. Tags must match the committed versions.\x1b[0m'
    );
    process.exitCode = 1;
    return;
  }

  const pkg = readPkg();
  const errors = checkAlwaysRules(pkg);
  if (errors.length) {
    for (const error of errors) console.error(`\x1b[31m✗ [Tags] ${error}\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  const created: string[] = [];
  for (const { key, tagPrefix } of PARTS) {
    const part = pkg[key];
    const tag = `${tagPrefix}${part?.version}`;
    const existing = git(['tag', '--list', tag]);
    if (existing) {
      const at = git(['rev-list', '-n', '1', tag]).slice(0, 7);
      console.log(`\x1b[90m- [Tags] ${tag} already exists (${at}), skipped.\x1b[0m`);
      continue;
    }
    const message = `${part?.fullName || part?.name} ${part?.version} (${part?.codename})`;
    git(['tag', '-a', tag, '-m', message]);
    created.push(tag);
    console.log(`\x1b[32m✓ [Tags] ${tag}: ${message}\x1b[0m`);
  }

  if (created.length) {
    console.log(`\nPush them with:\n  git push origin ${created.join(' ')}`);
  } else {
    console.log('Nothing to tag: every part already has a tag for its version.');
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
