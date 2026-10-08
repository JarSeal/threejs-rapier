import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths';

/**
 * Snippet includes (p552 §2.3): `<<< path/from/repo/root.ts#region {meta}` shows a file's region
 * (or the whole file, or `#L10-L24`) as a code block, so a page shows the real code and can't
 * drift from it. A region is marked in the source with `#region name` / `#endregion name` in a
 * comment of any style (`//`, `/* *\/`, `<!-- -->`, `#`). The marker lines are dropped (nested
 * regions' too) and the code is dedented. JSON has no comments: a `.json` file is included whole
 * or by lines.
 */

/** The language each includable extension is highlighted as ('text': plain) */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.sh': 'bash',
  '.scss': 'scss',
  '.css': 'css',
  '.html': 'html',
  '.wgsl': 'wgsl',
  '.glsl': 'glsl',
  '.vert': 'glsl',
  '.frag': 'glsl',
  '.diff': 'diff',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'md',
  '.txt': 'text',
};

/**
 * `// #region name`, `/* #endregion name *\/`, `<!-- #region name -->`, `# #endregion`. The first
 * word is the name; text after it is a note (`// #region setup (shown in the Hub)`).
 */
const MARKER_REGEX =
  /^\s*(?:\/\/|\/\*|<!--|#)\s*#(end)?region\b(?:\s+([\w.-]+))?(?:\s*(?:\*\/|-->)|\s.*)?$/;

const LINE_RANGE_REGEX = /^L(\d+)(?:-L?(\d+))?$/;

export type HubSnippetSpec = {
  /** As written, from the repo root */
  path: string;
  /** `region-name`, `L10-L24`, or '' for the whole file */
  fragment: string;
  /** The fence meta after it (`title="…" {3,5-7} wrap`) */
  meta: string;
};

export type HubSnippet = {
  code: string;
  lang: string;
  /** The first line's number in the file when it should be shown (a line range), else null */
  startLine: number | null;
};

export type HubSnippetResult =
  | ({ isOk: true; file: string } & HubSnippet)
  /** `file`: the resolved file when it's inside the repo (watched even when it's missing) */
  | { isOk: false; file: string | null; message: string };

/** `<<< src/app/space.ts#asteroids {3} wrap` (the text after `<<<`) */
export const parseSnippetSpec = (text: string): HubSnippetSpec => {
  const [ref = '', ...meta] = text.trim().split(/\s+/);
  const hashAt = ref.indexOf('#');
  return {
    path: hashAt < 0 ? ref : ref.slice(0, hashAt),
    fragment: hashAt < 0 ? '' : ref.slice(hashAt + 1),
    meta: meta.join(' '),
  };
};

const isInside = (dir: string, file: string) => file.startsWith(dir + path.sep);

/** Removes the lines' shared indentation, and the blank lines around them */
export const dedent = (lines: string[]) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  const kept = lines.slice(start, end);
  const indent = Math.min(
    ...kept.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length)
  );
  return kept.map((line) => (line.trim() ? line.slice(indent) : ''));
};

const isMarker = (line: string) => MARKER_REGEX.test(line);

/** The region's lines (its nested regions' markers dropped), or an error message */
const extractRegion = (lines: string[], name: string): string[] | string => {
  const starts = lines.flatMap((line, i) => {
    const match = MARKER_REGEX.exec(line);
    return match && !match[1] && match[2] === name ? [i] : [];
  });
  if (!starts.length) {
    const names = lines
      .map((line) => MARKER_REGEX.exec(line))
      .filter((match) => match && !match[1] && match[2])
      .map((match) => match![2]);
    return `No "#region ${name}" in it${names.length ? ` (it has: ${[...new Set(names)].join(', ')})` : ' (it has no regions)'}`;
  }
  if (starts.length > 1) {
    return `"#region ${name}" is in it ${starts.length} times (lines ${starts.map((i) => i + 1).join(', ')}): rename one`;
  }
  const open = [name];
  const body: string[] = [];
  for (let i = starts[0] + 1; i < lines.length; i++) {
    const match = MARKER_REGEX.exec(lines[i]);
    if (!match) {
      body.push(lines[i]);
      continue;
    }
    if (!match[1]) {
      open.push(match[2] ?? '');
      continue;
    }
    // A named #endregion closes its region (and any left open inside it), a bare one the innermost
    const at = match[2] ? open.lastIndexOf(match[2]) : open.length - 1;
    if (at >= 0) open.length = at;
    if (!open.length) return body;
  }
  return `"#region ${name}" (line ${starts[0] + 1}) has no "#endregion ${name}"`;
};

/** Reads a snippet; never throws */
export const readSnippet = (spec: HubSnippetSpec): HubSnippetResult => {
  const fail = (message: string, file: string | null = null): HubSnippetResult => ({
    isOk: false,
    file,
    message,
  });
  if (!spec.path) return fail('"<<<" needs a file: <<< path/from/repo/root.ts#region');
  if (path.isAbsolute(spec.path) || /^[a-z]:/i.test(spec.path)) {
    return fail(`"${spec.path}": the path is from the repo root, not absolute`);
  }
  const file = path.resolve(ROOT, spec.path);
  if (!isInside(ROOT, file)) return fail(`"${spec.path}" is outside the repo`);
  const ext = path.extname(file).toLowerCase();
  const lang = LANGUAGE_BY_EXTENSION[ext];
  if (!lang) {
    return fail(
      `"${spec.path}": only text files can be included (${Object.keys(LANGUAGE_BY_EXTENSION).join(', ')})`
    );
  }
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return fail(`No such file: ${spec.path}`, file);
  }
  if (!isInside(ROOT, fs.realpathSync(file))) {
    return fail(`"${spec.path}" links to a file outside the repo`);
  }

  const lines = fs.readFileSync(file, 'utf-8').replace(/\r\n?/g, '\n').split('\n');
  let picked: string[];
  let startLine: number | null = null;
  const range = LINE_RANGE_REGEX.exec(spec.fragment);
  if (range) {
    const from = +range[1];
    const to = range[2] ? +range[2] : from;
    if (from < 1 || to < from || to > lines.length) {
      return fail(`#${spec.fragment}: ${spec.path} has lines 1-${lines.length}`, file);
    }
    const slice = lines.slice(from - 1, to);
    picked = slice.filter((line) => !isMarker(line));
    // Numbered as in the file (past the blank lines dedent drops), unless a dropped marker line
    // would shift the numbers
    if (picked.length === slice.length) {
      const leadingBlanks = Math.max(
        0,
        slice.findIndex((line) => line.trim())
      );
      startLine = from + leadingBlanks;
    }
  } else if (spec.fragment) {
    if (lang === 'json') {
      return fail(
        `#${spec.fragment}: JSON has no comments, so no regions: include the whole file or lines (#L10-L24)`,
        file
      );
    }
    const region = extractRegion(lines, spec.fragment);
    if (typeof region === 'string') return fail(`${spec.path}: ${region}`, file);
    picked = region;
  } else {
    picked = lines.filter((line) => !isMarker(line));
  }

  const code = dedent(picked);
  if (!code.length) {
    return fail(`${spec.path}${spec.fragment ? `#${spec.fragment}` : ''} is empty`, file);
  }
  return { isOk: true, file, code: code.join('\n'), lang, startLine };
};
