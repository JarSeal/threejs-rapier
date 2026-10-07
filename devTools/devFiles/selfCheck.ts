/* eslint-disable no-console */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import { format, resolveConfig } from 'prettier';
import { ROOT } from '../assetPipeline/sources';
import {
  DEV_FILES_HASH_HEADER,
  DEV_FILES_ROUTE_BASE,
  DEV_FILES_TOKEN_HEADER,
  DEV_FILES_TOKEN_META,
  type DevFilesCommitBody,
  type DevFilesErrorBody,
  type DevFilesStageBody,
  type DevFilesStatusBody,
} from '../../src/_engine/debug/DevFilesProtocol';

/**
 * The dev file server's self-check (p342 Phases 1 and 3), no test framework:
 *   source .claude/hooks/use-node.sh && npx tsx devTools/devFiles/selfCheck.ts
 * starts its own dev server (port 8091 or the next free one) with `AEK_DEV_FILES_FAULTS=true`,
 * so it can force a failure in a commit's renames. `--url http://localhost:8080` runs against a
 * running `yarn dev` instead and skips the forced failures. The token is read from `index.html`.
 *
 * It writes into `src/app/__devFilesSelfCheck__/` and removes the folder at the end. The save
 * entry cases (Phase 3) write a material and two debug scenes there and wait for the dev server's
 * gather to apply them (a running `yarn dev` reloads its page on it too). At the end it waits for
 * the gather that drops them again, else it restores `src/_engine/generatedApp*` as they were.
 */

const TEST_DIR = 'src/app/__devFilesSelfCheck__';
const TEST_DIR_ABS = path.join(ROOT, ...TEST_DIR.split('/'));
const OUTSIDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aek-devfiles-'));
// A 1×1 PNG (the server doesn't decode images, so a changed byte makes the "other" image)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_2 = Buffer.concat([PNG, Buffer.from([1])]);
const GENERATED_FILES = [
  path.join(ROOT, 'src/_engine/generatedAppData.json'),
  path.join(ROOT, 'src/_engine/generatedAppFns.ts'),
];
const GATHER_TIMEOUT_MS = 60_000;
// The save entry cases' assets; the scenes reuse an app scene file (never loaded here)
const SAVE_MAT_ID = 'aekSelfCheckMat';
const SAVE_SCENE_IDS = ['aekSelfCheckA', 'aekSelfCheckB'];
const SAVE_SCENE_FILE = './scene01.ts';

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

let baseUrl: URL;
let token = '';
let failures = 0;
let passes = 0;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

const request = (opts: {
  method: string;
  route: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Connect to this address instead of the base URL's host (the Host header stays its own) */
  address?: string;
  isRaw?: boolean;
}) =>
  new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        host: opts.address ?? baseUrl.hostname,
        port: baseUrl.port,
        method: opts.method,
        path: opts.isRaw ? opts.route : `${DEV_FILES_ROUTE_BASE}${opts.route}`,
        headers: {
          ...(token ? { [DEV_FILES_TOKEN_HEADER]: token } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });

const json = <T>(res: Response) => JSON.parse(res.body.toString('utf-8')) as T;
const errorCode = (res: Response) => {
  try {
    return json<DevFilesErrorBody>(res).error?.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
};

const check = (name: string, isOk: boolean, detail = '') => {
  if (isOk) {
    passes++;
    console.log(`\x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? ` (${detail})` : ''}`);
  }
};

const commit = (writes: unknown[], headers: Record<string, string> = {}) =>
  request({
    method: 'POST',
    route: 'commit',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ writes }),
  });

const stage = async (data: Buffer) => {
  const res = await request({ method: 'PUT', route: 'stage', body: data });
  if (res.status !== 200) throw new Error(`Staging failed: ${res.body.toString()}`);
  return json<DevFilesStageBody>(res);
};

const expectCode = async (name: string, promise: Promise<Response>, code: string) => {
  const res = await promise;
  const got = errorCode(res);
  check(`${name} → ${code}`, got === code, `got ${got}`);
};

const testPath = (name: string) => `${TEST_DIR}/${name}`;
const testFile = (name: string) => path.join(TEST_DIR_ABS, name);
const readTestFile = (name: string) =>
  fs.existsSync(testFile(name)) ? fs.readFileSync(testFile(name)) : null;

const formatted = async (value: unknown, name: string) => {
  const options = (await resolveConfig(testFile(name))) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, filepath: testFile(name) });
};

type GeneratedScenes = Record<
  string,
  { materials?: { id?: string; params?: Record<string, unknown> }[] } | undefined
>;

/** The generated data's scenes, null while it can't be read (mid-write) */
const readGeneratedScenes = () => {
  try {
    return (JSON.parse(fs.readFileSync(GENERATED_FILES[0], 'utf-8')) as { scenes: GeneratedScenes })
      .scenes;
  } catch {
    return null;
  }
};

/** The colour the gather gave the save entry material in a scene (undefined: not gathered) */
const gatheredColor = (sceneId: string) =>
  readGeneratedScenes()?.[sceneId]?.materials?.find((mat) => mat.id === SAVE_MAT_ID)?.params?.color;

const waitUntil = async (isDone: () => boolean, timeoutMs = GATHER_TIMEOUT_MS) => {
  const end = Date.now() + timeoutMs;
  while (!isDone()) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
};

const findLanAddress = () => {
  for (const infos of Object.values(os.networkInterfaces())) {
    const info = infos?.find((entry) => entry.family === 'IPv4' && !entry.internal);
    if (info) return info.address;
  }
  return null;
};

const startOwnServer = async () => {
  process.env.AEK_DEV_FILES_FAULTS = 'true';
  process.env.VITE_APP_ENV ??= 'development';
  delete process.env.AEK_DEV_FILES;
  delete process.env.AEK_DEV_FILES_LAN;
  delete process.env.AEK_DEV_HTTPS;
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { port: 8091, host: true },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('The server has no port');
  return { server, url: `http://localhost:${address.port}` };
};

const run = async (hasFaults: boolean) => {
  const html = await request({ method: 'GET', route: '/', isRaw: true });
  const match = new RegExp(`<meta name="${DEV_FILES_TOKEN_META}" content="([0-9a-f]+)"`).exec(
    html.body.toString('utf-8')
  );
  check('index.html has the token', !!match);
  const realToken = match?.[1] ?? '';

  // status needs no token
  const status = json<DevFilesStatusBody>(await request({ method: 'GET', route: 'status' }));
  check('status: enabled and writable from localhost', status.enabled && status.canWrite);
  token = realToken;

  // A JSON and a PNG batch lands
  const value = { name: 'selfCheck', list: [1, 2, 3], nested: { isOn: true } };
  const staged = await stage(PNG);
  check('stage returns the hash', staged.sha256 === sha256(PNG) && staged.bytes === PNG.length);
  let res = await commit([
    { path: testPath('a.json'), json: value },
    { path: testPath('sub/b.png'), stageId: staged.stageId },
  ]);
  const landed = res.status === 200 ? json<DevFilesCommitBody>(res) : null;
  check(
    'a JSON and a PNG batch lands (created)',
    !!landed && landed.results.every((result) => result.status === 'created'),
    errorCode(res)
  );
  const expectedJson = await formatted(value, 'a.json');
  check('the JSON is Prettier-formatted', readTestFile('a.json')?.toString() === expectedJson);
  check('the PNG is written as sent', !!readTestFile('sub/b.png')?.equals(PNG));
  const aHash = sha256(expectedJson);

  res = await request({
    method: 'GET',
    route: `read?path=${encodeURIComponent(testPath('a.json'))}`,
  });
  check(
    'read returns the bytes and their hash',
    res.body.toString() === expectedJson && res.headers[DEV_FILES_HASH_HEADER] === aHash
  );

  res = await commit([{ path: testPath('a.json'), json: value, expectedHash: aHash }]);
  check(
    'an unchanged write reports unchanged',
    res.status === 200 && json<DevFilesCommitBody>(res).results[0].status === 'unchanged',
    errorCode(res)
  );

  // Refusals
  const write = [{ path: testPath('c.json'), json: {} }];
  await expectCode('no token', commit(write, { [DEV_FILES_TOKEN_HEADER]: '' }), 'BAD_TOKEN');
  await expectCode(
    'a foreign Origin',
    commit(write, { Origin: 'http://evil.example' }),
    'BAD_ORIGIN'
  );
  await expectCode(
    'a foreign Host',
    commit(write, { Host: `evil.example:${baseUrl.port}` }),
    'BAD_HOST'
  );
  const lanAddress = findLanAddress();
  if (lanAddress) {
    await expectCode(
      `a LAN address (${lanAddress}) without AEK_DEV_FILES_LAN`,
      request({
        method: 'POST',
        route: 'commit',
        address: lanAddress,
        headers: { Host: `${lanAddress}:${baseUrl.port}` },
        body: JSON.stringify({ writes: write }),
      }),
      'NOT_LOCAL'
    );
  } else {
    console.log('- skipped the LAN case: this machine has no non-loopback IPv4 address');
  }
  await expectCode(
    '"../"',
    commit([{ path: 'src/app/../_engine/x.json', json: {} }]),
    'FORBIDDEN_PATH'
  );
  fs.mkdirSync(TEST_DIR_ABS, { recursive: true });
  fs.symlinkSync(OUTSIDE_DIR, testFile('out'), 'dir');
  await expectCode(
    'a symlink out of a root',
    commit([{ path: testPath('out/x.json'), json: {} }]),
    'FORBIDDEN_PATH'
  );
  check('nothing was written through the symlink', fs.readdirSync(OUTSIDE_DIR).length === 0);
  await expectCode('a .ts file', commit([{ path: testPath('x.ts'), json: {} }]), 'FORBIDDEN_PATH');
  await expectCode(
    'src/_engine/',
    commit([{ path: 'src/_engine/x.json', json: {} }]),
    'FORBIDDEN_PATH'
  );
  await expectCode(
    'aek-assets',
    commit([{ path: 'src/public/aek-assets/x.json', json: {} }]),
    'FORBIDDEN_PATH'
  );
  await expectCode(
    'too large (32 MB + 1)',
    request({ method: 'PUT', route: 'stage', body: Buffer.alloc(32 * 1024 * 1024 + 1) }),
    'TOO_LARGE'
  );
  await expectCode(
    'an invalid *.material.json',
    commit([{ path: testPath('bad.material.json'), json: { id: 5, type: 'NOPE' } }]),
    'INVALID_SCHEMA'
  );
  await expectCode(
    'a stale expectedHash',
    commit([{ path: testPath('a.json'), json: { changed: true }, expectedHash: '0'.repeat(64) }]),
    'CONFLICT'
  );
  await expectCode(
    'expectedHash null on an existing file',
    commit([{ path: testPath('a.json'), json: { changed: true }, expectedHash: null }]),
    'CONFLICT'
  );
  await expectCode(
    'an unknown stageId',
    commit([{ path: testPath('x.png'), stageId: 'f'.repeat(32) }]),
    'STAGE_EXPIRED'
  );
  await expectCode(
    'a body that is not JSON',
    request({ method: 'POST', route: 'commit', body: '{ nope' }),
    'INVALID_JSON'
  );

  // A batch whose last write fails leaves every file as it was
  const aBefore = readTestFile('a.json');
  const bBefore = readTestFile('sub/b.png');
  await expectCode(
    'a batch whose last write is invalid',
    commit([
      { path: testPath('a.json'), json: { changed: true } },
      { path: testPath('c.json'), json: {} },
      { path: testPath('bad.material.json'), json: { id: 5, type: 'NOPE' } },
    ]),
    'INVALID_SCHEMA'
  );
  const isAsBefore = () =>
    !!aBefore?.equals(readTestFile('a.json') ?? Buffer.alloc(0)) &&
    !!bBefore?.equals(readTestFile('sub/b.png') ?? Buffer.alloc(0)) &&
    !readTestFile('c.json') &&
    !readTestFile('new/d.json') &&
    !fs.existsSync(testFile('new'));
  const listTemps = () =>
    fs
      .readdirSync(TEST_DIR_ABS, { recursive: true, encoding: 'utf-8' })
      .filter((file) => file.endsWith('.aek-tmp'));
  check('… and every file is as it was', isAsBefore());

  if (hasFaults) {
    for (const failAt of [0, 2]) {
      const staged2 = await stage(PNG_2);
      await expectCode(
        `a batch whose rename ${failAt} fails`,
        commit(
          [
            { path: testPath('a.json'), json: { changed: true } },
            { path: testPath('sub/b.png'), stageId: staged2.stageId },
            { path: testPath('new/d.json'), json: { isNew: true } },
          ],
          { 'x-aek-dev-fault': `rename:${failAt}` }
        ),
        'WRITE_FAILED'
      );
      check(
        `… and every file is as it was, no temporary file or new folder left`,
        isAsBefore() && !listTemps().length
      );
    }
  } else {
    console.log('- skipped the forced rename failures: they need AEK_DEV_FILES_FAULTS=true');
  }

  // An expectedHash that matches lands
  res = await commit([{ path: testPath('a.json'), json: { changed: true }, expectedHash: aHash }]);
  check(
    'a matching expectedHash updates',
    res.status === 200 && json<DevFilesCommitBody>(res).results[0].status === 'updated',
    errorCode(res)
  );

  await runSaveDataChecks();

  // /@fs/ outside the repo
  res = await request({ method: 'GET', route: '/@fs/etc/hostname', isRaw: true });
  check('/@fs/ outside the repo is refused', res.status === 403, `HTTP ${res.status}`);
  res = await request({ method: 'GET', route: `/@fs${ROOT}/package.json`, isRaw: true });
  check('/@fs/ inside the repo is served', res.status === 200, `HTTP ${res.status}`);
};

/** Phase 3: save entries (`saveData` writes) */
const runSaveDataChecks = async () => {
  const matPath = testPath('saveData.material.json');
  const readEntries = () =>
    (
      JSON.parse(readTestFile('saveData.material.json')?.toString() ?? '{}') as {
        __saveData?: Record<string, { __meta?: Record<string, unknown>; params?: unknown }[]>;
      }
    ).__saveData?.[SAVE_SCENE_IDS[0]] ?? [];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as Record<
    string,
    { version: string }
  >;
  const isStamped = (meta?: Record<string, unknown>) =>
    meta?.engineVersion === pkg.engine_metadata.version &&
    meta?.toolkitVersion === pkg.toolkit_metadata.version &&
    meta?.appVersion === pkg.app_metadata.version &&
    typeof meta?.date === 'number';
  const RED = '#ff0000';
  const GREEN = '#00ff00';
  const BLUE = '#0000ff';

  let res = await commit([
    { path: matPath, json: { id: SAVE_MAT_ID, type: 'PHONG', params: { color: RED } } },
    ...SAVE_SCENE_IDS.map((id) => ({
      path: testPath(`${id}.scene.json`),
      json: { id, sceneFile: SAVE_SCENE_FILE, isDebugScene: true, materials: [SAVE_MAT_ID] },
    })),
  ]);
  check('save entries: a material and two scenes land', res.status === 200, errorCode(res));

  /** A save entry write for the first scene (the default history size is the config's) */
  const saveWrite = (entry: Record<string, unknown>, historySize: unknown = 20) => ({
    path: matPath,
    saveData: { sceneId: SAVE_SCENE_IDS[0], entry, historySize },
  });
  const colors = () => readEntries().map((saved) => (saved.params as { color?: string })?.color);

  res = await commit([saveWrite({ params: { color: GREEN } })]);
  check(
    'a save entry updates the file',
    res.status === 200 && json<DevFilesCommitBody>(res).results[0].status === 'updated',
    errorCode(res)
  );
  let entries = readEntries();
  check(
    '… with one entry, stamped with the three versions and the date',
    entries.length === 1 && isStamped(entries[0].__meta)
  );
  check(
    'the gatherer applies it in its scene',
    await waitUntil(() => gatheredColor(SAVE_SCENE_IDS[0]) === GREEN),
    `got ${String(gatheredColor(SAVE_SCENE_IDS[0]))}`
  );
  check('… and not in the other one', gatheredColor(SAVE_SCENE_IDS[1]) === RED);

  // The server's versions win over the entry's own
  res = await commit([saveWrite({ __meta: { engineVersion: '0.0.0' }, params: { color: BLUE } })]);
  check('a second save entry updates the file', res.status === 200, errorCode(res));
  entries = readEntries();
  check(
    '… puts its entry first, stamped, and keeps the first one after it',
    entries.length === 2 && isStamped(entries[0].__meta) && colors().join() === [BLUE, GREEN].join()
  );
  check(
    'the gatherer applies the new entry',
    await waitUntil(() => gatheredColor(SAVE_SCENE_IDS[0]) === BLUE),
    `got ${String(gatheredColor(SAVE_SCENE_IDS[0]))}`
  );
  check('… and the other scene keeps the asset', gatheredColor(SAVE_SCENE_IDS[1]) === RED);

  res = await commit([saveWrite({ params: { color: BLUE } })]);
  check(
    'an entry equal to the latest one reports unchanged',
    res.status === 200 &&
      json<DevFilesCommitBody>(res).results[0].status === 'unchanged' &&
      readEntries().length === 2,
    errorCode(res)
  );

  // The history size
  const WHITE = '#ffffff';
  const BLACK = '#000000';
  res = await commit([saveWrite({ params: { color: WHITE } }, 2)]);
  check(
    'history size 2 keeps the new entry and the latest older one',
    res.status === 200 && colors().join() === [WHITE, BLUE].join(),
    `${errorCode(res)}, ${colors().join()}`
  );
  res = await commit([saveWrite({ params: { color: WHITE } }, 1)]);
  check(
    'an entry equal to the latest one under a smaller history size only trims',
    res.status === 200 &&
      json<DevFilesCommitBody>(res).results[0].status === 'updated' &&
      colors().join() === WHITE,
    `${errorCode(res)}, ${colors().join()}`
  );
  res = await commit([saveWrite({ params: { color: BLACK } }, -1)]);
  check(
    'history size -1 keeps every entry',
    res.status === 200 && colors().join() === [BLACK, WHITE].join(),
    `${errorCode(res)}, ${colors().join()}`
  );
  await expectCode(
    'history size 0 (saving off)',
    commit([saveWrite({ params: { color: GREEN } }, 0)]),
    'SAVE_DATA_DISABLED'
  );
  await expectCode(
    'no history size',
    commit([
      {
        path: matPath,
        saveData: { sceneId: SAVE_SCENE_IDS[0], entry: { params: { color: GREEN } } },
      },
    ]),
    'BAD_REQUEST'
  );
  await expectCode(
    'history size 1.5',
    commit([saveWrite({ params: { color: GREEN } }, 1.5)]),
    'BAD_REQUEST'
  );
  check(
    '… and the refused ones left the file as it was',
    colors().join() === [BLACK, WHITE].join()
  );

  const entry = { params: { color: GREEN } };
  const saveData = { sceneId: 'x', entry, historySize: 20 };
  await expectCode(
    'a save entry for a missing file',
    commit([{ path: testPath('none.material.json'), saveData }]),
    'NOT_FOUND'
  );
  await expectCode(
    'a save entry for a plain JSON',
    commit([{ path: testPath('a.json'), saveData }]),
    'BAD_REQUEST'
  );
  await expectCode(
    'a save entry for a texture atlas (no __saveData)',
    commit([{ path: testPath('x.textureAtlas.json'), saveData }]),
    'BAD_REQUEST'
  );
  await expectCode(
    'a save entry with json too',
    commit([{ path: matPath, json: {}, saveData }]),
    'BAD_REQUEST'
  );
  await expectCode(
    'an invalid save entry',
    commit([{ path: matPath, saveData: { ...saveData, entry: { params: 5 } } }]),
    'INVALID_SCHEMA'
  );
  await expectCode(
    'a save entry with a stale expectedHash',
    commit([{ path: matPath, saveData, expectedHash: '0'.repeat(64) }]),
    'CONFLICT'
  );
};

/** Removes the test folder; when the gather put the save entry scenes into the generated data,
 * waits for the one that drops them (the server must still run), else restores the snapshot */
const cleanUp = async (generatedBefore: Buffer[], closeServer: () => Promise<void>) => {
  fs.rmSync(TEST_DIR_ABS, { recursive: true, force: true });
  fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  const hasTestScenes = () => SAVE_SCENE_IDS.some((id) => !!readGeneratedScenes()?.[id]);
  const isClean = !hasTestScenes() || (await waitUntil(() => !hasTestScenes()));
  await closeServer();
  if (isClean) return;
  GENERATED_FILES.forEach((file, i) => fs.writeFileSync(file, generatedBefore[i]));
  console.log('- the gather kept the test scenes: restored src/_engine/generatedApp* as they were');
};

const main = async () => {
  const urlIndex = process.argv.indexOf('--url');
  const own = urlIndex === -1 ? await startOwnServer() : null;
  baseUrl = new URL(own ? own.url : process.argv[urlIndex + 1]);
  if (baseUrl.hostname === 'localhost') baseUrl.hostname = '127.0.0.1';
  console.log(`Dev files self-check against ${baseUrl.origin}`);
  const generatedBefore = GENERATED_FILES.map((file) => fs.readFileSync(file));
  try {
    await run(!!own);
  } catch (err) {
    failures++;
    console.error('\x1b[31m✗ The self-check stopped:\x1b[0m', err);
  } finally {
    await cleanUp(generatedBefore, async () => {
      await own?.server.close();
    });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

void main();
