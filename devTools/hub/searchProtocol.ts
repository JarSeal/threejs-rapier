// No Node imports: the Hub's search (`hub/_assets/ts/_search.ts`) imports this, and
// `hub/tsconfig.json` checks it without Node's types.
import type { Options } from 'minisearch';

/**
 * What the search index's build (`search.ts`) and the Hub's search dialog share (p552 §2.4).
 * minisearch serializes the index but not its options, so both sides load it with these.
 */

/** One indexed section of a page: its text before the first heading, then each heading's */
export type HubSearchDoc = {
  id: number;
  /** The page's site path ('' never: the homepage isn't indexed) */
  path: string;
  /** The heading's id, '' for the page's own section (the text before its first heading) */
  anchor: string;
  /** The page's title and tags: on its own section only, so the title finds the page first */
  title: string;
  tags: string;
  /** The heading's text, '' for the page's own section */
  heading: string;
  /** The section's text without markup or code blocks */
  text: string;
  /** The identifiers in its code blocks, space separated (names, not the code) */
  code: string;
};

/** What a result carries: enough to link it and show a snippet */
export type HubSearchStored = Pick<HubSearchDoc, 'path' | 'anchor' | 'heading' | 'text'>;

/** `_assets/hub-search.js`: an ES module whose default export is the serialized index */
export const HUB_SEARCH_FILE = 'hub-search.js';

const SPACE_OR_PUNCTUATION = /[\n\r\p{Z}\p{P}]+/u;
/** `createMeshEntity` → `create`, `Mesh`, `Entity`; `GPUTimer` → `GPU`, `Timer` */
const CAMEL_CASE_PART = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+/gu;

/**
 * minisearch's own split (spaces and punctuation), plus, for indexed text, the camelCase parts
 * of each word: `mesh` finds `createMeshEntity`. A query (no field) isn't split further.
 */
export const tokenizeHubSearch = (text: string, fieldName?: string) => {
  const tokens = text.split(SPACE_OR_PUNCTUATION).filter(Boolean);
  if (fieldName === undefined) return tokens;
  const parts: string[] = [];
  for (const token of tokens) {
    const split = token.match(CAMEL_CASE_PART);
    if (split && split.length > 1) parts.push(...split);
  }
  return parts.length ? tokens.concat(parts) : tokens;
};

/** p553's API symbols add a `symbol` field (×4) */
export const HUB_SEARCH_BOOST = { title: 4, heading: 3, tags: 2 };

export const HUB_SEARCH_OPTIONS: Options<HubSearchDoc> = {
  fields: ['title', 'heading', 'tags', 'text', 'code'],
  storeFields: ['path', 'anchor', 'heading', 'text'],
  tokenize: tokenizeHubSearch,
  searchOptions: {
    boost: HUB_SEARCH_BOOST,
    // A one-letter prefix and a fuzzy short word match too much to be useful
    prefix: (term) => term.length > 1,
    fuzzy: (term) => (term.length > 3 ? 0.2 : false),
  },
};
