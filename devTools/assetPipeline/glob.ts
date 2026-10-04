/**
 * A glob → RegExp for the asset pipeline's config rules (p300): `**` (any folders, also none),
 * `*` (within one folder), `?` (one character) and `{a,b}` (alternatives, not nested). Paths
 * are '/'-separated. Node's own `path.matchesGlob` is still experimental (it warns) in Node 22.
 */
export const globToRegExp = (glob: string) => {
  let source = '';
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      // '**/' also matches no folder at all: 'a/**/b' matches 'a/b'
      const isSegment = glob[i + 2] === '/';
      source += isSegment ? '(?:.*/)?' : '.*';
      i += isSegment ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{' && !inBraces) {
      inBraces = true;
      source += '(?:';
    } else if (char === '}' && inBraces) {
      inBraces = false;
      source += ')';
    } else if (char === ',' && inBraces) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  if (inBraces) throw new Error(`Unclosed "{" in glob "${glob}"`);
  return new RegExp(`^${source}$`);
};
