/* eslint-disable no-console */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Checks package.json's versions against the versioning rules in `.claude/CLAUDE.md`.
 *
 * Always:
 * - `version` equals `engine_metadata.version`.
 * - Every part's version is MAJOR.MINOR.PATCH and it has a codename.
 *
 * With `--against <ref>` (eg. `yarn checkVersions --against main` before opening a PR), also
 * per part (engine, toolkit, app):
 * - Its files changed since the merge base with `<ref>` → its version is bumped.
 * - A bump raises exactly one part by 1 and resets the lower parts to 0, and is never lower
 *   than `<ref>`'s version.
 * - The codename changes exactly when the major version does.
 *
 * Exits with code 1 on a violation.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export type PartKey = 'engine_metadata' | 'toolkit_metadata' | 'app_metadata';
type PartMeta = { version?: string; codename?: string; fullName?: string; name?: string };
export type Pkg = { version?: string } & Partial<Record<PartKey, PartMeta>>;

// `src/generated/` is in no part: the gatherer rebuilds it from the app's JSON files
export const PARTS: { key: PartKey; label: string; tagPrefix: string; paths: string[] }[] = [
  {
    key: 'engine_metadata',
    label: 'Engine',
    tagPrefix: 'engine-v',
    paths: ['src/_engine'],
  },
  { key: 'toolkit_metadata', label: 'Toolkit', tagPrefix: 'toolkit-v', paths: ['src/toolkit'] },
  {
    key: 'app_metadata',
    label: 'App',
    tagPrefix: 'app-v',
    paths: ['src/app', 'src/AppECSPlugins.ts', 'src/AppECSRegistry.ts', 'src/CONFIG.ts'],
  },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parseSemver = (v?: string) => {
  const m = v?.match(SEMVER);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export const git = (args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();

export const readPkg = (): Pkg =>
  JSON.parse(fs.readFileSync(path.resolve(ROOT, 'package.json'), 'utf-8'));

/** The rules that hold at any commit. Returns the violations. */
export const checkAlwaysRules = (pkg: Pkg): string[] => {
  const errors: string[] = [];
  for (const { key, label } of PARTS) {
    const part = pkg[key];
    if (!parseSemver(part?.version)) {
      errors.push(`${label}: ${key}.version "${part?.version}" is not MAJOR.MINOR.PATCH.`);
    }
    if (!part?.codename) errors.push(`${label}: ${key}.codename is missing.`);
  }
  if (pkg.version !== pkg.engine_metadata?.version) {
    errors.push(
      `The project version (${pkg.version}) must equal engine_metadata.version (${pkg.engine_metadata?.version}).`
    );
  }
  return errors;
};

/** Per-part bump rules against `ref`. Returns the violations and the notes (non-fatal). */
const checkAgainstRef = (pkg: Pkg, ref: string) => {
  const errors: string[] = [];
  const notes: string[] = [];
  const mergeBase = git(['merge-base', ref, 'HEAD']);
  // Versions compare against the ref's tip (a version must not fall behind what is already
  // there), changed files against the merge base (only this branch's own changes count)
  const refPkg = JSON.parse(git(['show', `${ref}:package.json`])) as Pkg;

  for (const { key, label, paths } of PARTS) {
    const cur = pkg[key];
    const prev = refPkg[key];
    const curV = parseSemver(cur?.version);
    const prevV = parseSemver(prev?.version);
    if (!curV) continue; // already reported by checkAlwaysRules
    if (!prevV) {
      notes.push(`${label}: new on this branch, starts at ${cur?.version}.`);
      continue;
    }

    const changed = [
      ...git(['diff', '--name-only', mergeBase, '--', ...paths]).split('\n'),
      ...git(['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n'),
    ].filter(Boolean);

    const diffIndex = curV.findIndex((n, i) => n !== prevV[i]);
    if (diffIndex === -1) {
      if (changed.length) {
        errors.push(
          `${label}: ${changed.length} file(s) changed since ${ref} (eg. ${changed[0]}), but the version is still ${cur?.version}. Bump it.`
        );
      }
      continue;
    }

    if (curV[diffIndex] < prevV[diffIndex]) {
      errors.push(`${label}: ${cur?.version} is lower than ${ref}'s ${prev?.version}.`);
      continue;
    }
    const expected = prevV.map((n, i) => (i < diffIndex ? n : i === diffIndex ? n + 1 : 0));
    if (expected.join('.') !== curV.join('.')) {
      errors.push(
        `${label}: ${prev?.version} → ${cur?.version} skips or doesn't reset the lower parts. Expected ${expected.join('.')}.`
      );
    }
    const isMajor = diffIndex === 0;
    if (isMajor && cur?.codename === prev?.codename) {
      errors.push(`${label}: a major bump needs a new codename (still "${cur?.codename}").`);
    }
    if (!isMajor && cur?.codename !== prev?.codename) {
      errors.push(
        `${label}: the codename changed ("${prev?.codename}" → "${cur?.codename}") without a major bump.`
      );
    }
    if (!changed.length) {
      notes.push(
        `${label}: bumped to ${cur?.version}, but none of its files changed since ${ref}.`
      );
    }
  }
  return { errors, notes };
};

const main = () => {
  const args = process.argv.slice(2);
  const againstArg = args.find((a) => a.startsWith('--against'));
  const ref = againstArg?.includes('=')
    ? againstArg.split('=')[1]
    : againstArg
      ? args[args.indexOf(againstArg) + 1]
      : undefined;
  if (againstArg && !ref) {
    console.error('\x1b[31m✗ [Versions] --against needs a git ref, eg. --against main\x1b[0m');
    process.exitCode = 1;
    return;
  }

  const pkg = readPkg();
  const errors = checkAlwaysRules(pkg);
  const notes: string[] = [];
  if (ref) {
    const result = checkAgainstRef(pkg, ref);
    errors.push(...result.errors);
    notes.push(...result.notes);
  }

  for (const note of notes) console.log(`\x1b[33m⚠ [Versions] ${note}\x1b[0m`);
  if (errors.length) {
    for (const error of errors) console.error(`\x1b[31m✗ [Versions] ${error}\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  const summary = PARTS.map(({ key, label }) => `${label} ${pkg[key]?.version}`).join(', ');
  console.log(`\x1b[32m✓ [Versions] ${summary}${ref ? ` (checked against ${ref})` : ''}\x1b[0m`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
