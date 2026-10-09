import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isFilePathValid, validateGatheredJson } from './gatherAppData';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO_ROOT, 'src');

// Every gathered asset JSON in src/, as the gatherer walks it
const assetFiles = (fs.readdirSync(SRC, { recursive: true }) as string[])
  .filter((file) => isFilePathValid(file))
  .map((file) => path.relative(REPO_ROOT, path.join(SRC, file)))
  .sort();

const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) as Record<string, unknown>;

const omit = (json: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(json).filter(([k]) => k !== key));

/** The first repo asset with this suffix, to break one thing in */
const firstOf = (suffix: string) => {
  const file = assetFiles.find((f) => f.endsWith(suffix));
  if (!file) throw new Error(`No ${suffix} in src/ to derive a bad fixture from`);
  return { file, json: readJson(file) };
};

describe('the repo’s asset JSONs', () => {
  test('there are some', () => {
    expect(assetFiles.length).toBeGreaterThan(50);
  });

  test.each(assetFiles)('%s passes its schema', (file) => {
    expect(validateGatheredJson(file, readJson(file))).toBeNull();
  });
});

describe('bad assets fail', () => {
  // Each is a repo asset with one thing broken, and must fail on a path along the broken one (at
  // it, inside it or above it). A light's bad intensity is reported on `lightProps` alone: it's a
  // plain union of the light types, which the gatherer's expandUnionIssues can't narrow.
  const cases: [string, string, string, (json: Record<string, unknown>) => unknown][] = [
    ['a scene without an id', '.scene.json', 'id', (json) => omit(json, 'id')],
    ['a scene without a sceneFile', '.scene.json', 'sceneFile', (json) => omit(json, 'sceneFile')],
    ['a camera without camProps', '.camera.json', 'camProps', (json) => omit(json, 'camProps')],
    [
      'a light of an unknown type',
      '.light.json',
      'lightProps',
      (json) => ({ ...json, lightProps: { ...(json.lightProps as object), type: 'LASER' } }),
    ],
    [
      'a light with a string intensity',
      '.light.json',
      'lightProps.intensity',
      (json) => ({ ...json, lightProps: { ...(json.lightProps as object), intensity: 'bright' } }),
    ],
    [
      'an impostor of an unknown kind',
      '.impostor.json',
      'kind',
      (json) => ({ ...json, kind: 'SPHERE' }),
    ],
    ['a material that is an array', '.material.json', '', () => []],
    [
      'a save entry that is not a list',
      '.scene.json',
      '__saveData.someScene',
      (json) => ({ ...json, __saveData: { someScene: { id: 'x' } } }),
    ],
  ];

  test.each(cases)('%s', (_name, suffix, issuePath, breakIt) => {
    const { file, json } = firstOf(suffix);
    const issues = validateGatheredJson(file, breakIt(json));
    const paths = issues?.map((issue) => issue.path) ?? [];
    expect(
      paths.some(
        (p) => p === issuePath || p.startsWith(`${issuePath}.`) || issuePath.startsWith(`${p}.`)
      ),
      `issues at ${JSON.stringify(paths)}`
    ).toBe(true);
  });

  test('a file that isn’t a gathered type isn’t validated', () => {
    expect(validateGatheredJson('src/app/notes.json', { anything: true })).toBeNull();
  });
});
