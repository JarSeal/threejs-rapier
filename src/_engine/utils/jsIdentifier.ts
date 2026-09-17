/**
 * Utilities for turning arbitrary asset ids (material ids, file basenames, etc.)
 * into safe JavaScript identifiers for generated code (e.g. generatedAppFns.ts).
 *
 * Strategy:
 * - Registry/object KEYS should NOT be sanitized — emit them quoted instead
 *   (JSON.stringify(matId)), so the runtime lookup by props.id keeps working.
 * - Only VARIABLE names (import namespaces like `${matId}Fn`) go through this.
 */

// Words that cannot (or should not) be used as identifiers.
const RESERVED_WORDS = new Set([
  // ES keywords
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  // strict-mode / contextual
  'let',
  'static',
  'yield',
  'await',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'arguments',
  'eval',
  // common globals worth avoiding in generated module scope
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
]);

/**
 * Converts an arbitrary string into a valid camelCase JS identifier.
 * - Strips diacritics ("café" -> "cafe")
 * - Splits on any non [A-Za-z0-9_$] run and camelCases the parts
 *   ("my-cool mat.2" -> "myCoolMat2")
 * - Prefixes with the fallback if the result starts with a digit or is empty
 * - Suffixes "_" if the result is a reserved word
 *
 * Deterministic: same input always yields the same output.
 */
export const toJsIdentifier = (name: string, fallback = 'asset'): string => {
  const parts = name
    .normalize('NFKD') // decompose accented chars so the accent can be stripped
    .replace(/[\u0300-\u036f]/g, '') // remove combining diacritical marks
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean);

  let id = parts
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');

  if (!id) id = fallback;
  if (/^[0-9]/.test(id)) id = `${fallback}${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  if (RESERVED_WORDS.has(id)) id = `${id}_`;

  return id;
};

/**
 * Like toJsIdentifier, but guarantees uniqueness within the given set by
 * appending a counter ("myMatFn", "myMatFn2", "myMatFn3", ...).
 * The chosen identifier is added to `used` as a side effect.
 *
 * Create one Set per generated file and pass it to every call:
 *   const usedNamespaces = new Set<string>();
 *   const ns = toUniqueJsIdentifier(`${matId}Fn`, usedNamespaces);
 */
export const toUniqueJsIdentifier = (
  name: string,
  used: Set<string>,
  fallback?: string
): string => {
  const base = toJsIdentifier(name, fallback);
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}${counter++}`;
  }
  used.add(candidate);
  return candidate;
};
