import path from 'node:path';
import type MarkdownIt from 'markdown-it';
import type { Highlighter } from 'shiki';
import type { JSONOutput } from 'typedoc';
import type { ProjectMetadata } from '../../projectMetadata';
import { loadHubHighlighter } from '../code';
import { HubDiagnostics, type HubDiagnostic } from '../diagnostics';
import type { HubGeneratedPage, HubGeneratedSection, HubSlotGenerator } from '../generated/section';
import { hashContent } from '../hash';
import { escapeHtml } from '../html';
import {
  renderMarkdownText,
  uniqueId,
  type HubApiLinkResolver,
  type HubImageJob,
  type HubLinkRef,
  type HubMarkdownEnv,
} from '../markdown';
import { ROOT, TSCONFIG_FILE } from '../paths';
import type { HubSearchExtraDoc } from '../search';
import type { HubBuildMode, HubHeading } from '../types';
import {
  firstSentence,
  getBlockTags,
  hasBlockTag,
  hasModifierTag,
  linkName,
  partsToMarkdown,
  tagLabel,
  toInlineCode,
  type CommentLinkResolver,
  type CommentParts,
  type InlineTagPart,
} from './comments';
import { getLastApiModel, loadApiModel, type ApiExtractMessage } from './extract';
import { getApiLinks, type ApiLinks } from './links';
import {
  API_SECTION_PATH,
  API_SUBTREES,
  getOwnMembers,
  indexApiModel,
  isDocumented,
  Kind,
  listFolders,
  type ApiFolder,
  type ApiIndex,
  type ApiModule,
  type ApiTarget,
  type Comment,
  type Coverage,
  type DeclarationReflection,
  type SignatureReflection,
  type SomeType,
} from './model';
import {
  CodeWriter,
  getObjectMembers,
  getTabledMembers,
  MEMBER_POSITION_PREFIX,
  printHeritage,
  printSignature,
  printTypeAlias,
  printTypeOnly,
  printVariable,
  renderCodeBlock,
  renderInlineCode,
  type TargetHref,
} from './signature';

/**
 * The Documentation section (p553 §2.2): the engine's and the toolkit's API as Hub pages, from
 * the API model (`extract.ts`). A generated section on `documentation/`: its landing slot lists
 * the modules by folder with their coverage, then an A-Z index; each folder and each module gets
 * a page. A module page has a section per kind (functions, classes, interfaces, type aliases,
 * enums, variables), and each symbol its anchor (`#loadScene`), its signature, its comment, its
 * parameters, and a link to its source (GitHub at the build's commit, or the editor in dev).
 *
 * Rendering the whole API takes about a second (shiki and Markdown for every symbol), so each
 * slot's output is kept in memory for the same model, mode and commit: the dev plugin's
 * rebuilds of other pages stay fast.
 */

const LANDING_SLOT = 'generated-api';
const PAGE_SLOT = 'generated-api-page';
/** A comment's own headings (`# Usage`) start at h4: under the symbol, out of the TOC */
const COMMENT_HEADING_OFFSET = 3;
/** Object literal types are shown as nested rows (`props.mesh.castShadow`) this deep */
const MAX_ROW_DEPTH = 3;
const DESCRIPTION_LENGTH = 200;

/**
 * Where a build's API model comes from (§2.5): `current` converts when its inputs changed (the
 * public build), `last` takes the last good one whatever its inputs (the dev plugin, which
 * rebuilds it in a child process), `none` builds no API docs (`hub:build --no-api`)
 */
export type ApiModelSource = 'current' | 'last' | 'none';

export type ApiBuildStats = {
  isCached: boolean;
  extractMs: number;
  moduleCount: number;
  symbolCount: number;
  coverage: Coverage;
};

export type ApiSectionResult = {
  section: HubGeneratedSection;
  /** Null when the model didn't build or there's none (`none`, or `last` before any) */
  stats: ApiBuildStats | null;
  /** Every page's `api:` links (§2.3), null when the model didn't build */
  links: HubApiLinkResolver | null;
  /** `last`: the model is older than its inputs (an old cache file), or there's none yet */
  isStale: boolean;
};

// --- Memo ---

/** What a slot's render added to its page's env, so a memo hit replays it */
type SlotRecord = {
  html: string;
  headings: HubHeading[];
  ids: string[];
  links: HubLinkRef[];
  images: HubImageJob[];
  includes: string[];
  diagnostics: HubDiagnostic[];
};

let memoKey = '';
const memo = new Map<string, SlotRecord>();

/** Same model, mode and commit: the same pages. Anything else drops the memo. */
const resetMemo = (key: string) => {
  if (key === memoKey) return;
  memoKey = key;
  memo.clear();
};

/** The slot's output, rendered once per memo key and the ids the page already had */
const memoized =
  (key: string, generate: HubSlotGenerator): HubSlotGenerator =>
  (md, env) => {
    const fullKey = `${key}\0${hashContent([...env.ids].join('\0'))}`;
    const hit = memo.get(fullKey);
    if (hit) {
      env.headings.push(...hit.headings);
      for (const id of hit.ids) env.ids.add(id);
      env.links.push(...hit.links);
      env.images.push(...hit.images);
      env.includes.push(...hit.includes);
      replayDiagnostics(env.diag, hit.diagnostics);
      return hit.html;
    }
    const before = {
      headings: env.headings.length,
      ids: new Set(env.ids),
      links: env.links.length,
      images: env.images.length,
      includes: env.includes.length,
    };
    const diag = env.diag;
    const local = new HubDiagnostics();
    env.diag = local;
    let html: string;
    try {
      html = generate(md, env);
    } finally {
      env.diag = diag;
    }
    replayDiagnostics(diag, local.items);
    memo.set(fullKey, {
      html,
      headings: env.headings.slice(before.headings),
      ids: [...env.ids].filter((id) => !before.ids.has(id)),
      links: env.links.slice(before.links),
      images: env.images.slice(before.images),
      includes: env.includes.slice(before.includes),
      diagnostics: local.items,
    });
    return html;
  };

const replayDiagnostics = (diag: HubDiagnostics, items: HubDiagnostic[]) => {
  for (const { level, file, line, message } of items) {
    if (level === 'error') diag.error(file, line, message);
    else diag.warn(file, line, message);
  }
};

// --- Render context ---

type SourceLink = (source: JSONOutput.SourceReference) => string;

type Ctx = {
  index: ApiIndex;
  links: ApiLinks;
  highlighter: Highlighter;
  md: MarkdownIt;
  env: HubMarkdownEnv;
  /** The file the comments being rendered are from (their diagnostics) */
  file: string;
  sourceLink: SourceLink;
};

/** The shortest relative URL between two site paths: `../SceneLoader/`, `engine/core/` */
const relativeUrl = (from: string, to: string) => {
  const fromParts = from.split('/').filter(Boolean);
  const toParts = to.split('/').filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const up = '../'.repeat(fromParts.length - common);
  return (
    up +
      toParts
        .slice(common)
        .map((part) => `${part}/`)
        .join('') || './'
  );
};

/** A page of the section from the page being rendered, `#anchor` on the page itself */
const href = (ctx: Ctx, pagePath: string, anchor = '') => {
  if (pagePath === ctx.env.page.path) return `#${anchor}`;
  return `${relativeUrl(ctx.env.page.path, pagePath)}${anchor ? `#${anchor}` : ''}`;
};

const targetHref = (ctx: Ctx, target: ApiTarget) =>
  href(ctx, target.module.pagePath, target.anchor);

/** A type in a signature or a table links its symbol (or its nearest owner with an anchor) */
const typeHref =
  (ctx: Ctx): TargetHref =>
  (id) => {
    const target = ctx.links.resolveId(id);
    return target && targetHref(ctx, target);
  };

/** Another package's symbol (three's), which stays text */
const isForeignTarget = (index: ApiIndex, part: InlineTagPart) =>
  typeof part.target === 'object' && part.target.packageName !== index.project.packageName;

/**
 * A `{@link}`'s target: the reflection TypeDoc resolved it to, or a name in this package it
 * found no reflection for (not exported, or another file's), looked up like an `api:` link
 */
const resolveCommentLink = (index: ApiIndex, links: ApiLinks, part: InlineTagPart) => {
  const { target } = part;
  if (typeof target === 'number') return links.resolveId(target);
  if (typeof target !== 'object' || isForeignTarget(index, part)) return undefined;
  const result = links.resolveName(target.qualifiedName);
  return result.isOk ? result.target : undefined;
};

const commentLinks =
  (ctx: Ctx): CommentLinkResolver =>
  (part) => {
    if (typeof part.target === 'string') return part.target; // `{@link https://…}`
    const target = resolveCommentLink(ctx.index, ctx.links, part);
    return target && targetHref(ctx, target);
  };

/** A comment's parts as Markdown, its `{@link}`s linked from the page being rendered */
const commentMarkdown = (ctx: Ctx, parts: CommentParts) =>
  partsToMarkdown(parts, commentLinks(ctx));

/** JSDoc is text, not markup: `Array<Mesh>` in a comment is no tag */
const withoutHtml = <T>(md: MarkdownIt, fn: () => T) => {
  const html = md.options.html;
  md.set({ html: false });
  try {
    return fn();
  } finally {
    md.set({ html });
  }
};

/**
 * Comment Markdown as blocks. `line` (the symbol's) offsets it, so a diagnostic points near the
 * comment in its source file.
 */
const renderBlock = (ctx: Ctx, markdown: string, line = 1) => {
  if (!markdown.trim()) return '';
  const text = '\n'.repeat(Math.max(0, line - 1)) + markdown;
  return withoutHtml(ctx.md, () =>
    renderMarkdownText(ctx.md, text, ctx.file, ctx.env, COMMENT_HEADING_OFFSET)
  );
};

const renderInline = (ctx: Ctx, markdown: string) => {
  if (!markdown.trim()) return '';
  ctx.env.file = ctx.file;
  return withoutHtml(ctx.md, () => ctx.md.renderInline(markdown, ctx.env));
};

const heading = (ctx: Ctx, level: number, id: string, text: string, inner = escapeHtml(text)) => {
  ctx.env.headings.push({ level, id, text });
  return `<h${level} id="${escapeHtml(id)}">${inner} <a class="hubAnchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${level}>\n`;
};

/** A heading with an id the model gave (a symbol's or a member's anchor) */
const anchorHeading = (ctx: Ctx, level: number, anchor: string, text: string, inner: string) => {
  ctx.env.ids.add(anchor);
  return heading(ctx, level, anchor, text, inner);
};

const sectionHeading = (ctx: Ctx, title: string, id: string) =>
  heading(ctx, 2, uniqueId(ctx.env, id), title);

const inlineType = (ctx: Ctx, type: SomeType | undefined, collapseObjects = false) =>
  renderInlineCode(ctx.highlighter, printTypeOnly(type, { collapseObjects }), typeHref(ctx));

const codeBlock = (ctx: Ctx, w: CodeWriter, prefix?: string) =>
  renderCodeBlock(ctx.highlighter, w, typeHref(ctx), prefix);

// --- Coverage and summaries ---

const percent = ({ documented, total }: Coverage) =>
  total ? Math.round((documented / total) * 100) : 100;

const renderCoverage = (coverage: Coverage) => {
  const value = percent(coverage);
  const label = `${value}% documented: ${coverage.documented} of ${coverage.total} exports`;
  return `<span class="hubApiCoverage" title="${label}"><span class="hubApiCoverageBar" style="--hub-api-coverage: ${value}%" aria-hidden="true"></span><span class="hubApiCoverageText">${coverage.documented}/${coverage.total}</span><span class="hubVisuallyHidden"> exports documented</span></span>`;
};

const symbolSummary = (symbol: DeclarationReflection) =>
  symbol.comment?.summary.length
    ? symbol.comment.summary
    : symbol.signatures?.find((signature) => signature.comment?.summary.length)?.comment?.summary;

/** Functions and classes say what a module is for; its types and constants describe them */
const SUMMARY_KINDS: number[] = [Kind.Function, Kind.Class];

/**
 * A module's one line: its `@module` comment's first sentence, else its first documented function
 * or class's (by source line), else its first documented export's. Its `{@link}`s are code unless
 * `resolveLink` links them.
 */
const getModuleSummary = (module: ApiModule, resolveLink?: CommentLinkResolver) => {
  if (module.reflection.comment?.summary.length) {
    return firstSentence(partsToMarkdown(module.reflection.comment.summary, resolveLink));
  }
  const documented = module.symbols
    .filter((symbol) => symbol.kind !== Kind.Reference && symbolSummary(symbol))
    .sort((a, b) => (a.sources?.[0]?.line ?? 0) - (b.sources?.[0]?.line ?? 0));
  const first = documented.find((symbol) => SUMMARY_KINDS.includes(symbol.kind)) ?? documented[0];
  return first ? firstSentence(partsToMarkdown(symbolSummary(first), resolveLink)) : '';
};

/** Markdown to plain text, for `<meta name="description">` and the search's snippets */
const toPlainText = (markdown: string) =>
  markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const shorten = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;

// --- Comments ---

/** Tags shown in their own place, not in the list of other tags */
const PLACED_TAGS = ['@returns', '@example', '@see', '@remarks', '@deprecated', '@param'];
const DEFAULT_TAGS = ['@default', '@defaultValue'];

const isDeprecated = (symbol: DeclarationReflection) =>
  hasBlockTag(symbol.comment, '@deprecated') ||
  !!symbol.signatures?.some((signature) => hasBlockTag(signature.comment, '@deprecated'));

/** `Default: \`5\``, from `@default` / `@defaultValue` or a parameter's default value */
const renderDefault = (ctx: Ctx, comment: Comment | undefined, defaultValue?: string) => {
  const tag = (comment?.blockTags ?? []).find((block) => DEFAULT_TAGS.includes(block.tag));
  const value = tag
    ? commentMarkdown(ctx, tag.content).trim()
    : defaultValue && defaultValue !== '...'
      ? toInlineCode(defaultValue)
      : '';
  return value
    ? `<p class="hubApiDefault"><span class="hubApiLabel">Default</span> ${renderInline(ctx, value)}</p>`
    : '';
};

/** A comment's text: the deprecation, the summary and `@remarks` */
const renderCommentHead = (ctx: Ctx, comment: Comment | undefined, line?: number) => {
  if (!comment) return '';
  let html = '';
  for (const tag of getBlockTags(comment, '@deprecated')) {
    const note = commentMarkdown(ctx, tag.content);
    html += `<aside class="hubCallout hubCallout_warning"><p class="hubCalloutTitle">Deprecated</p>${renderBlock(ctx, note, line)}</aside>\n`;
  }
  html += renderBlock(ctx, commentMarkdown(ctx, comment.summary), line);
  for (const tag of getBlockTags(comment, '@remarks')) {
    html += renderBlock(ctx, commentMarkdown(ctx, tag.content), line);
  }
  return html;
};

/** The rest of a comment: its other tags, then examples and `@see` */
const renderCommentTail = (ctx: Ctx, comment: Comment | undefined, line?: number) => {
  if (!comment) return '';
  let html = '';
  for (const tag of comment.blockTags ?? []) {
    if (PLACED_TAGS.includes(tag.tag) || DEFAULT_TAGS.includes(tag.tag)) continue;
    html += `<div class="hubApiTag"><p class="hubApiLabel">${escapeHtml(tagLabel(tag.tag))}</p>${renderBlock(ctx, commentMarkdown(ctx, tag.content), line)}</div>\n`;
  }
  for (const tag of getBlockTags(comment, '@example')) {
    html += `<div class="hubApiTag"><p class="hubApiLabel">Example</p>${renderBlock(ctx, commentMarkdown(ctx, tag.content), line)}</div>\n`;
  }
  const sees = getBlockTags(comment, '@see');
  if (sees.length) {
    const items = sees.map(
      (tag) => `<li>${renderInline(ctx, commentMarkdown(ctx, tag.content).trim())}</li>`
    );
    html += `<div class="hubApiTag"><p class="hubApiLabel">See</p><ul>${items.join('')}</ul></div>\n`;
  }
  return html;
};

/** The comment in a table cell: its summary, `@remarks`, default and deprecation */
const renderCellComment = (ctx: Ctx, comment: Comment | undefined, defaultValue?: string) => {
  const html = renderCommentHead(ctx, comment) + renderDefault(ctx, comment, defaultValue);
  return html || '<span class="hubApiNone" aria-label="No description">—</span>';
};

// --- Tables ---

type Row = { name: string; badges: string[]; type: string; description: string };

const badge = (text: string, kind = '') =>
  `<span class="hubApiBadge${kind ? ` hubApiBadge_${kind}` : ''}">${escapeHtml(text)}</span>`;

const renderTable = (first: string, rows: Row[], label: string) => {
  if (!rows.length) return '';
  const body = rows.map(
    (row) =>
      `<tr><td><code class="hubApiMember">${escapeHtml(row.name)}</code>${row.badges.join('')}</td><td>${row.type}</td><td>${row.description}</td></tr>`
  );
  return `<p class="hubApiLabel">${escapeHtml(label)}</p>
<div class="hubTable hubApiTable"><table><thead><tr><th scope="col">${first}</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead><tbody>${body.join('')}</tbody></table></div>\n`;
};

/** An object literal type's members, or an array of one's (`items[].id`) */
const nestedMembers = (type: SomeType | undefined, name: string) => {
  const members = getObjectMembers(type);
  if (members.length) return { members, prefix: `${name}.` };
  if (type?.type === 'array') {
    const items = getObjectMembers(type.elementType);
    if (items.length) return { members: items, prefix: `${name}[].` };
  }
  return null;
};

/** A member's type: a method's as a function type, an accessor's from its signatures */
const memberType = (member: DeclarationReflection): SomeType | undefined => {
  if (member.signatures?.length) {
    return { type: 'reflection', declaration: { ...member, children: undefined } };
  }
  if (member.kind === Kind.Accessor) {
    return member.getSignature?.type ?? member.setSignature?.parameters?.[0]?.type;
  }
  return member.type;
};

/** Rows for members, with an object literal's members as nested rows (`props.mesh`) */
const memberRows = (ctx: Ctx, members: DeclarationReflection[], prefix = '', depth = 1): Row[] =>
  members.flatMap((member) => {
    const type = memberType(member);
    const name = `${prefix}${member.name}`;
    const nested = depth < MAX_ROW_DEPTH ? nestedMembers(type, name) : null;
    const badges = [
      member.flags.isOptional && badge('optional'),
      member.flags.isReadonly && badge('readonly'),
      member.flags.isStatic && badge('static'),
      member.getSignature && badge('get'),
      member.setSignature && badge('set'),
      member.flags.isProtected && badge('protected'),
      isDeprecated(member) && badge('deprecated', 'deprecated'),
    ].filter((b): b is string => !!b);
    const comment =
      member.comment ??
      member.signatures?.[0]?.comment ??
      member.getSignature?.comment ??
      member.setSignature?.comment;
    const row: Row = {
      name,
      badges,
      type: inlineType(ctx, type, !!nested),
      description: renderCellComment(ctx, comment, member.defaultValue),
    };
    return [row, ...(nested ? memberRows(ctx, nested.members, nested.prefix, depth + 1) : [])];
  });

const indexRows = (ctx: Ctx, declaration: DeclarationReflection): Row[] =>
  (declaration.indexSignatures ?? []).map((index) => {
    const [key] = index.parameters ?? [];
    const keyType = printTypeOnly(key?.type).text;
    return {
      name: `[${key?.name ?? 'key'}: ${keyType}]`,
      badges: [],
      type: inlineType(ctx, index.type),
      description: renderCellComment(ctx, index.comment),
    };
  });

const parameterRows = (ctx: Ctx, parameters: JSONOutput.ParameterReflection[]): Row[] =>
  parameters.flatMap((parameter) => {
    const name = `${parameter.flags.isRest ? '...' : ''}${parameter.name}`;
    const nested = nestedMembers(parameter.type, parameter.name);
    const row: Row = {
      name,
      badges: [
        (parameter.flags.isOptional || parameter.defaultValue !== undefined) && badge('optional'),
      ].filter((b): b is string => !!b),
      type: inlineType(ctx, parameter.type, !!nested),
      description: renderCellComment(ctx, parameter.comment, parameter.defaultValue),
    };
    return [row, ...(nested ? memberRows(ctx, nested.members, nested.prefix, 2) : [])];
  });

const typeParameterRows = (
  ctx: Ctx,
  typeParameters: JSONOutput.TypeParameterReflection[] | undefined
): Row[] =>
  (typeParameters ?? []).some((tp) => tp.comment)
    ? (typeParameters ?? []).map((tp) => ({
        name: tp.name,
        badges: [],
        type: tp.type ? inlineType(ctx, tp.type) : '',
        description: renderCellComment(ctx, tp.comment),
      }))
    : [];

/** `Promise<T>`'s `T`, for the rows of a returned object literal */
const unwrapPromise = (type: SomeType | undefined) =>
  type?.type === 'reference' && type.name === 'Promise' && type.typeArguments?.length === 1
    ? type.typeArguments[0]
    : type;

const renderReturns = (ctx: Ctx, signature: SignatureReflection, line?: number) => {
  const tags = getBlockTags(signature.comment, '@returns');
  const type = signature.type;
  const isVoid = type?.type === 'intrinsic' && type.name === 'void';
  if (!type || (isVoid && !tags.length)) return '';
  const members = getObjectMembers(unwrapPromise(type));
  const text = tags.map((tag) => commentMarkdown(ctx, tag.content)).join('\n\n');
  return `<div class="hubApiReturns"><p class="hubApiLabel">Returns</p><p>${inlineType(ctx, type)}</p>${renderBlock(ctx, text, line)}</div>\n${renderTable('Property', memberRows(ctx, members), 'Returned object')}`;
};

// --- Symbols ---

const KIND_LABELS: Record<number, string> = {
  [Kind.Function]: 'function',
  [Kind.Class]: 'class',
  [Kind.Interface]: 'interface',
  [Kind.TypeAlias]: 'type',
  [Kind.Enum]: 'enum',
  [Kind.Variable]: 'const',
  [Kind.Namespace]: 'namespace',
  [Kind.Module]: 'module',
  [Kind.Reference]: 're-export',
};

const SECTIONS: { title: string; id: string; kinds: number[] }[] = [
  { title: 'Functions', id: 'functions', kinds: [Kind.Function] },
  { title: 'Classes', id: 'classes', kinds: [Kind.Class] },
  { title: 'Interfaces', id: 'interfaces', kinds: [Kind.Interface] },
  { title: 'Type aliases', id: 'type-aliases', kinds: [Kind.TypeAlias] },
  { title: 'Enums', id: 'enums', kinds: [Kind.Enum] },
  { title: 'Variables', id: 'variables', kinds: [Kind.Variable] },
  { title: 'Namespaces', id: 'namespaces', kinds: [Kind.Namespace, Kind.Module] },
  { title: 'Re-exports', id: 're-exports', kinds: [Kind.Reference] },
];

const MEMBER_KIND_LABELS: Record<number, string> = {
  [Kind.Constructor]: 'constructor',
  [Kind.Method]: 'method',
  [Kind.Accessor]: 'property',
  [Kind.Property]: 'property',
};

const kindLabel = (symbol: DeclarationReflection) =>
  symbol.kind === Kind.Variable && !symbol.flags.isConst
    ? 'let'
    : KIND_LABELS[symbol.kind] ?? 'export';

const renderSource = (ctx: Ctx, reflection: { sources?: JSONOutput.SourceReference[] }) => {
  const source = reflection.sources?.[0];
  return source ? `<p class="hubApiSource">${ctx.sourceLink(source)}</p>\n` : '';
};

/** A call signature's docs: its comment, parameters, return value and tags */
const renderSignatureDocs = (ctx: Ctx, signature: SignatureReflection, hasReturns = true) => {
  const line = signature.sources?.[0]?.line;
  return (
    renderCommentHead(ctx, signature.comment, line) +
    renderTable(
      'Type parameter',
      typeParameterRows(ctx, signature.typeParameters),
      'Type parameters'
    ) +
    renderTable('Parameter', parameterRows(ctx, signature.parameters ?? []), 'Parameters') +
    (hasReturns ? renderReturns(ctx, signature, line) : '') +
    renderCommentTail(ctx, signature.comment, line)
  );
};

/** A class's or an interface's method, or a class's constructor, under its symbol (h4) */
const renderMember = (ctx: Ctx, member: DeclarationReflection) => {
  const target = ctx.index.targets.get(member.id);
  if (!target) return '';
  const isConstructor = member.kind === Kind.Constructor;
  const name = isConstructor ? 'constructor' : member.name;
  const inner = `<code>${escapeHtml(`${name}()`)}</code>${
    member.flags.isStatic ? badge('static') : ''
  }${isDeprecated(member) ? badge('deprecated', 'deprecated') : ''}`;
  let html = anchorHeading(ctx, 4, target.anchor, name, inner);
  for (const signature of member.signatures ?? []) {
    const w = printSignature(name, signature, {
      prefix: member.flags.isStatic ? 'static ' : '',
      returns: !isConstructor,
    });
    html +=
      codeBlock(ctx, w, MEMBER_POSITION_PREFIX) +
      renderSignatureDocs(ctx, signature, !isConstructor);
  }
  return `<div class="hubApiMemberBlock">${html}${renderSource(ctx, member)}</div>\n`;
};

/** A class's or an interface's own members: a table of properties, then each method */
const renderMembers = (ctx: Ctx, symbol: DeclarationReflection) => {
  const members = getOwnMembers(symbol).filter((member) => !member.flags.isPrivate);
  const constructors = members.filter((m) => m.kind === Kind.Constructor);
  const properties = members.filter((m) => m.kind === Kind.Property || m.kind === Kind.Accessor);
  const methods = members.filter((m) => m.kind === Kind.Method);
  return (
    constructors.map((member) => renderMember(ctx, member)).join('') +
    renderTable(
      'Property',
      [...indexRows(ctx, symbol), ...memberRows(ctx, properties)],
      'Properties'
    ) +
    methods.map((member) => renderMember(ctx, member)).join('')
  );
};

/** A function type's parameters and return value (a type alias's or a variable's type) */
const renderFunctionType = (ctx: Ctx, type: SomeType | undefined) => {
  const signature = type?.type === 'reflection' ? type.declaration.signatures?.[0] : undefined;
  if (!signature) return '';
  return (
    renderTable('Parameter', parameterRows(ctx, signature.parameters ?? []), 'Parameters') +
    renderReturns(ctx, signature)
  );
};

const renderReference = (ctx: Ctx, symbol: DeclarationReflection) => {
  const { target: targetId } = symbol as unknown as JSONOutput.ReferenceReflection;
  const target = ctx.index.targets.get(targetId);
  const original = ctx.index.reflections.get(targetId);
  if (!target || !original) {
    return `<p>Re-exports <code>${escapeHtml(symbol.name)}</code> from outside the documented API.</p>\n`;
  }
  const name = original.name === symbol.name ? '' : ` as <code>${escapeHtml(symbol.name)}</code>`;
  return `<p>Re-exports <a href="${escapeHtml(href(ctx, target.module.pagePath, target.anchor))}"><code>${escapeHtml(original.name)}</code></a>${name} from <a href="${escapeHtml(href(ctx, target.module.pagePath))}"><code>${escapeHtml(target.module.relPath)}</code></a>.</p>\n`;
};

const renderSymbol = (ctx: Ctx, symbol: DeclarationReflection) => {
  const target = ctx.index.targets.get(symbol.id);
  if (!target) return '';
  const kind = kindLabel(symbol);
  const badges = [
    isDeprecated(symbol) && badge('deprecated', 'deprecated'),
    hasModifierTag(symbol.comment, '@internal') && badge('internal'),
  ].filter(Boolean);
  const inner = `<span class="hubApiKind hubApiKind_${kind.replace(/\W/g, '')}">${escapeHtml(kind)}</span><code>${escapeHtml(symbol.name)}</code>${badges.join('')}`;
  let html = anchorHeading(ctx, 3, target.anchor, symbol.name, inner);
  const line = symbol.sources?.[0]?.line;
  const isMissing = symbol.kind !== Kind.Reference && !isDocumented(symbol);
  if (isMissing) html += '<p class="hubApiMissing">No description</p>\n';

  switch (symbol.kind) {
    case Kind.Function:
      for (const signature of symbol.signatures ?? []) {
        html += codeBlock(ctx, printSignature(symbol.name, signature, { prefix: 'function ' }));
        html += renderSignatureDocs(ctx, signature);
      }
      break;
    case Kind.Class:
    case Kind.Interface:
      html += codeBlock(
        ctx,
        printHeritage(symbol.kind === Kind.Class ? 'class' : 'interface', symbol)
      );
      html += renderCommentHead(ctx, symbol.comment, line);
      html += renderMembers(ctx, symbol);
      html += renderCommentTail(ctx, symbol.comment, line);
      break;
    case Kind.TypeAlias:
      html += codeBlock(ctx, printTypeAlias(symbol));
      html += renderCommentHead(ctx, symbol.comment, line);
      html += renderTable(
        'Type parameter',
        typeParameterRows(ctx, symbol.typeParameters),
        'Type parameters'
      );
      html += renderTable(
        'Property',
        [...indexRows(ctx, symbol), ...memberRows(ctx, getTabledMembers(symbol))],
        'Properties'
      );
      html += renderFunctionType(ctx, symbol.type);
      html += renderCommentTail(ctx, symbol.comment, line);
      break;
    case Kind.Enum:
      html += codeBlock(ctx, new CodeWriter().write(`enum ${symbol.name}`));
      html += renderCommentHead(ctx, symbol.comment, line);
      html += renderTable(
        'Member',
        (symbol.children ?? []).map((member) => ({
          name: member.name,
          badges: [],
          type: inlineType(ctx, member.type),
          description: renderCellComment(ctx, member.comment),
        })),
        'Members'
      );
      html += renderCommentTail(ctx, symbol.comment, line);
      break;
    case Kind.Variable:
      html += codeBlock(ctx, printVariable(symbol));
      html += renderCommentHead(ctx, symbol.comment, line);
      html += renderTable('Property', memberRows(ctx, getObjectMembers(symbol.type)), 'Properties');
      html += renderFunctionType(ctx, symbol.type);
      html += renderCommentTail(ctx, symbol.comment, line);
      break;
    case Kind.Reference:
      html += renderReference(ctx, symbol);
      break;
    default:
      html += codeBlock(
        ctx,
        new CodeWriter().write(
          symbol.kind === Kind.Module
            ? `declare module '${symbol.name}'`
            : `namespace ${symbol.name}`
        )
      );
      html += renderCommentHead(ctx, symbol.comment, line);
      html += renderCommentTail(ctx, symbol.comment, line);
  }
  return `<section class="hubApiSymbol">\n${html}${symbol.kind === Kind.Reference ? '' : renderSource(ctx, symbol)}</section>\n`;
};

// --- Pages ---

const renderModuleList = (ctx: Ctx, modules: ApiModule[]) => {
  if (!modules.length) return '';
  const items = modules.map((module) => {
    ctx.file = module.file;
    const summary = renderInline(ctx, getModuleSummary(module, commentLinks(ctx)));
    return `<li><div class="hubApiListHead"><a href="${escapeHtml(href(ctx, module.pagePath))}"><code>${escapeHtml(path.posix.basename(module.relPath))}</code></a>${renderCoverage(module.coverage)}</div>${summary ? `<p class="hubApiSummary">${summary}</p>` : ''}</li>`;
  });
  return `<ul class="hubApiList">${items.join('')}</ul>\n`;
};

const renderFolderList = (ctx: Ctx, folders: ApiFolder[]) => {
  if (!folders.length) return '';
  const items = folders.map((folder) => {
    const count = listFolders(folder).reduce((n, f) => n + f.modules.length, 0);
    return `<li><div class="hubApiListHead"><a href="${escapeHtml(href(ctx, folder.pagePath))}"><code>${escapeHtml(path.posix.basename(folder.relPath))}/</code></a>${renderCoverage(folder.totalCoverage)}</div><p class="hubApiSummary">${count} module${count === 1 ? '' : 's'}</p></li>`;
  });
  return `<ul class="hubApiList">${items.join('')}</ul>\n`;
};

/** A folder's contents: its subfolders and its modules */
const renderFolderContents = (ctx: Ctx, folder: ApiFolder, ownModule: ApiModule | null) => {
  const modules = folder.modules.filter((module) => module !== ownModule);
  let html = '';
  if (folder.folders.length) {
    html += sectionHeading(ctx, 'Folders', 'folders') + renderFolderList(ctx, folder.folders);
  }
  if (modules.length) {
    html += sectionHeading(ctx, 'Modules', 'modules') + renderModuleList(ctx, modules);
  }
  return html;
};

const renderPathLine = (sourcePath: string, coverage: Coverage) =>
  `<p class="hubApiPath"><code>${escapeHtml(sourcePath)}</code>${renderCoverage(coverage)}</p>\n`;

const renderModulePage = (ctx: Ctx, module: ApiModule, folder: ApiFolder | null) => {
  ctx.file = module.file;
  let html = renderPathLine(module.sourcePath, module.coverage);
  if (folder) {
    html += `<p>This module sits next to its folder, <code>${escapeHtml(folder.sourcePath)}/</code>, so its page lists the folder too.</p>\n`;
    html += renderFolderContents(ctx, folder, module);
  }
  if (!module.symbols.length) html += '<p>This module exports nothing.</p>\n';
  for (const section of SECTIONS) {
    const symbols = module.symbols
      .filter((symbol) => section.kinds.includes(symbol.kind))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!symbols.length) continue;
    html += sectionHeading(ctx, section.title, section.id);
    for (const symbol of symbols) {
      ctx.file = module.file;
      html += renderSymbol(ctx, symbol);
    }
  }
  return `<div class="hubApi">\n${html}</div>\n`;
};

const renderFolderPage = (ctx: Ctx, folder: ApiFolder) => {
  ctx.file = path.join(ROOT, folder.sourcePath);
  const html =
    renderPathLine(`${folder.sourcePath}/`, folder.totalCoverage) +
    renderFolderContents(ctx, folder, null);
  return `<div class="hubApi">\n${html}</div>\n`;
};

/** Every symbol, A-Z by first letter, with its module */
const renderAzIndex = (ctx: Ctx) => {
  const entries = ctx.index.modules
    .flatMap((module) =>
      module.symbols
        .filter((symbol) => symbol.kind !== Kind.Reference)
        .map((symbol) => ({ symbol, module, target: ctx.index.targets.get(symbol.id)! }))
    )
    .sort(
      (a, b) =>
        a.symbol.name.localeCompare(b.symbol.name, 'en', { sensitivity: 'base' }) ||
        a.module.pagePath.localeCompare(b.module.pagePath)
    );
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const first = entry.symbol.name.charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : '#';
    groups.set(letter, [...(groups.get(letter) ?? []), entry]);
  }
  const letters = [...groups.keys()].sort((a, b) =>
    a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)
  );
  const ids = new Map(
    letters.map((letter) => [
      letter,
      uniqueId(ctx.env, `az-${letter === '#' ? 'other' : letter.toLowerCase()}`),
    ])
  );
  const bar = letters
    .map((letter) => `<a href="#${ids.get(letter)}">${escapeHtml(letter)}</a>`)
    .join('');
  const lists = letters.map((letter) => {
    const items = groups
      .get(letter)!
      .map(
        ({ symbol, module, target }) =>
          `<li><a href="${escapeHtml(href(ctx, module.pagePath, target.anchor))}">${escapeHtml(symbol.name)}</a><span class="hubApiAzModule">${escapeHtml(module.subtree === 'engine' ? module.relPath : `${module.subtree}/${module.relPath}`)}</span></li>`
      );
    return `<p class="hubApiAzLetter" id="${ids.get(letter)}">${escapeHtml(letter)}</p><ul class="hubApiAzList">${items.join('')}</ul>`;
  });
  return `${sectionHeading(ctx, 'A–Z index', 'a-z-index')}<p class="hubApiLetters">${bar}</p>\n${lists.join('\n')}\n`;
};

/** `documentation/`'s slot: each subtree's modules by folder, then the A-Z index */
const renderLanding = (ctx: Ctx) => {
  let html = '';
  for (const { id, title, sourceDir } of API_SUBTREES) {
    const root = ctx.index.roots[id];
    const total = ctx.index.coverage[id];
    html += sectionHeading(ctx, title, id);
    html += `<p class="hubApiPath"><a href="${escapeHtml(href(ctx, root.pagePath))}"><code>${escapeHtml(sourceDir)}/</code></a>${renderCoverage(total)}</p>\n`;
    for (const folder of listFolders(root)) {
      const modules = folder.module ? [folder.module, ...folder.modules] : folder.modules;
      if (!modules.length) continue;
      const label = folder.relPath ? `${folder.relPath}/` : 'Top level';
      const inner = `<a href="${escapeHtml(href(ctx, folder.pagePath))}">${escapeHtml(label)}</a>${renderCoverage(folder.coverage)}`;
      html += heading(
        ctx,
        3,
        uniqueId(
          ctx.env,
          `${id}-${folder.relPath || 'top-level'}`.replace(/[^\w-]+/g, '-').toLowerCase()
        ),
        label,
        inner
      );
      html += renderModuleList(ctx, modules);
    }
  }
  html += renderAzIndex(ctx);
  // The section's symbols get their own search entries (Phase 2): the lists aren't indexed
  return `<div class="hubApi hubSearchSkip">\n${html}</div>\n`;
};

// --- The section ---

/** `https://github.com/JarSeal/aekasha-js.git` → `https://github.com/JarSeal/aekasha-js` */
const toRepoWebUrl = (url: string) =>
  url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

/**
 * A symbol's source: GitHub at the build's commit (`public`), or the file at its line in the
 * editor through Vite's `/__open-in-editor` (`dev`, which `hub.ts` fetches instead of following)
 */
const createSourceLink = (mode: HubBuildMode, meta: ProjectMetadata): SourceLink => {
  const repo = toRepoWebUrl(meta.engine.repoUrl);
  const ref = meta.build.commit || 'main';
  return ({ fileName, line }) => {
    const label = escapeHtml(`${fileName}:${line}`);
    if (mode === 'dev') {
      const file = encodeURIComponent(`${path.join(ROOT, fileName)}:${line}`);
      return `<a href="/__open-in-editor?file=${file}" data-hub-open-in-editor title="Open in your editor">${label}</a>`;
    }
    const url = `${repo}/blob/${ref}/${fileName}#L${line}`;
    return `<a class="hubApiSourceGitHub" href="${escapeHtml(url)}" title="The source on GitHub" rel="noopener">${label}</a>`;
  };
};

/**
 * The `{@link}`s that link nowhere, once per build (not per render: a module's summary is on
 * several pages). Another package's symbol (three's) is fine as text.
 */
const reportCommentLinks = (diag: HubDiagnostics, index: ApiIndex, links: ApiLinks) => {
  for (const { part, ownerId, fileName, line } of links.namedLinks) {
    if (typeof part.target === 'string' || isForeignTarget(index, part)) continue;
    // A member inherited from three: its comment is three's, and the pages leave it out
    if (fileName?.startsWith('node_modules/')) continue;
    if (resolveCommentLink(index, links, part)) continue;
    const owner = links.resolveId(ownerId);
    if (!owner) continue; // Not on any page
    const file = fileName ? path.join(ROOT, fileName) : owner.module.file;
    const why = part.target ? 'it isn’t in the API docs' : 'TypeDoc found no such symbol';
    diag.warn(file, line, `{@link ${linkName(part)}} links nowhere (${why}): shown as text`);
  }
};

/** `api:` links on every page, by name (§2.3) */
const createLinkResolver =
  (links: ApiLinks): HubApiLinkResolver =>
  (ref) => {
    const result = links.resolveName(ref);
    return result.isOk
      ? { pagePath: result.target.module.pagePath, anchor: result.target.anchor }
      : { error: result.message };
  };

/**
 * The search's API documents (§2.4): each module, symbol and class or interface member, found by
 * its name, with its kind and its summary's first sentence for the result (stored, not indexed:
 * the index stays under p552's 1 MB). Empty values are left out, not stored.
 */
const createSearchDocs = (index: ApiIndex): HubSearchExtraDoc[] => {
  const doc = (
    pagePath: string,
    anchor: string,
    symbol: string,
    kind: string,
    summary: string
  ): HubSearchExtraDoc => {
    const text = toPlainText(summary);
    return {
      path: pagePath,
      ...(anchor && { anchor }),
      symbol,
      kind,
      ...(text && { summary: text }),
    };
  };
  const sentence = (reflection: DeclarationReflection) => {
    const summary =
      symbolSummary(reflection) ??
      reflection.getSignature?.comment?.summary ??
      reflection.setSignature?.comment?.summary;
    return summary ? firstSentence(partsToMarkdown(summary)) : '';
  };
  const docs: HubSearchExtraDoc[] = [];
  for (const module of index.modules) {
    const name = path.posix.basename(module.relPath);
    docs.push(doc(module.pagePath, '', name, 'module', getModuleSummary(module)));
    for (const symbol of module.symbols) {
      if (symbol.kind === Kind.Reference) continue;
      const target = index.targets.get(symbol.id);
      if (!target) continue;
      docs.push(
        doc(module.pagePath, target.anchor, symbol.name, kindLabel(symbol), sentence(symbol))
      );
      if (symbol.kind !== Kind.Class && symbol.kind !== Kind.Interface) continue;
      for (const member of getOwnMembers(symbol)) {
        const memberTarget = index.targets.get(member.id);
        if (!memberTarget || member.flags.isPrivate) continue;
        const memberName = member.kind === Kind.Constructor ? 'constructor' : member.name;
        const kind = MEMBER_KIND_LABELS[member.kind] ?? 'property';
        docs.push(
          doc(
            module.pagePath,
            memberTarget.anchor,
            `${symbol.name}.${memberName}`,
            kind,
            sentence(member)
          )
        );
      }
    }
  }
  return docs;
};

const reportMessages = (diag: HubDiagnostics, messages: ApiExtractMessage[]) => {
  for (const { level, message, file, line } of messages) {
    const text = `TypeDoc: ${message}`;
    if (level === 'error') diag.error(file ?? TSCONFIG_FILE, line, text);
    else diag.warn(file ?? TSCONFIG_FILE, line, text);
  }
};

const pageBody = (title: string) =>
  `<h1 class="hubApiTitle">${escapeHtml(title)}</h1>\n<div id="${PAGE_SLOT}"></div>\n`;

/** The index, its links and its search documents are the model's: built once per model */
const indexes = new WeakMap<ApiIndex['project'], ApiIndex>();
const searchDocs = new WeakMap<ApiIndex, HubSearchExtraDoc[]>();

const getIndex = (project: ApiIndex['project']) => {
  let index = indexes.get(project);
  if (!index) indexes.set(project, (index = indexApiModel(project)));
  return index;
};

const getSearchDocs = (index: ApiIndex) => {
  let docs = searchDocs.get(index);
  if (!docs) searchDocs.set(index, (docs = createSearchDocs(index)));
  return docs;
};

export type ApiSectionOptions = {
  mode: HubBuildMode;
  diag: HubDiagnostics;
  meta: ProjectMetadata;
  model: ApiModelSource;
};

/** The section without API pages: its landing slot says why */
const createEmptySection = (
  text: string,
  links: HubApiLinkResolver | null,
  isStale = false
): ApiSectionResult => ({
  section: {
    path: API_SECTION_PATH,
    slots: { [LANDING_SLOT]: () => `<p>${text}</p>\n` },
    pages: [],
    files: [TSCONFIG_FILE],
    dirs: [],
  },
  stats: null,
  links,
  isStale,
});

/** `api:` links when there's no model to check them against: they point at the landing page */
const uncheckedLinks: HubApiLinkResolver = () => ({ pagePath: API_SECTION_PATH, anchor: '' });

/**
 * The Documentation section: the API model (`model` says from where), its pages, and the landing
 * slot on `documentation/`. A failed conversion is an error on the section's page, which then says
 * the API docs didn't build. Without a model (`none`, or `last` before the first), `api:` links
 * aren't checked.
 */
export const createApiSection = async ({
  mode,
  diag,
  meta,
  model,
}: ApiSectionOptions): Promise<ApiSectionResult> => {
  if (model === 'none') {
    diag.warn(
      TSCONFIG_FILE,
      undefined,
      'The API docs are not built (--no-api), and api: links are not checked'
    );
    return createEmptySection(
      'The API documentation isn’t in this build (<code>yarn hub:build --no-api</code>).',
      uncheckedLinks
    );
  }
  const extract =
    model === 'last' ? getLastApiModel() : { ...(await loadApiModel()), isStale: false };
  const { isStale } = extract;
  reportMessages(diag, extract.messages);
  if (!extract.model) {
    // `last` with no conversion yet: the dev plugin converts on the first API page request
    return extract.messages.length
      ? createEmptySection(
          'The API documentation didn’t build: the errors are listed above and in the terminal.',
          null
        )
      : createEmptySection('The API documentation isn’t built yet.', uncheckedLinks, isStale);
  }

  const index = getIndex(extract.model.project);
  const links = getApiLinks(index);
  reportCommentLinks(diag, index, links);
  const highlighter = await loadHubHighlighter();
  const sourceLink = createSourceLink(mode, meta);
  resetMemo(
    hashContent([extract.model.hash, mode, meta.build.commit, meta.engine.repoUrl].join('\0'))
  );
  const generator = (key: string, render: (ctx: Ctx) => string): HubSlotGenerator =>
    memoized(key, (md, env) =>
      render({ index, links, highlighter, md, env, file: env.page.file, sourceLink })
    );

  const pages: HubGeneratedPage[] = [];
  for (const folder of index.folders.values()) {
    if (folder.module) continue; // Its module's page is the folder's
    const subtree = API_SUBTREES.find((s) => s.id === folder.subtree)!;
    const name = path.posix.basename(folder.relPath);
    const title = folder.relPath ? `${name}/` : `${subtree.title} API`;
    pages.push({
      path: folder.pagePath,
      file: path.join(ROOT, folder.sourcePath),
      title,
      menu: folder.relPath ? name : subtree.title,
      description: `The modules in ${folder.sourcePath}/.`,
      tags: ['api', folder.subtree],
      isInMenu: true,
      isSearchable: false,
      body: pageBody(title),
      slots: { [PAGE_SLOT]: generator(folder.pagePath, (ctx) => renderFolderPage(ctx, folder)) },
    });
  }
  for (const module of index.modules) {
    const folder = index.folders.get(module.pagePath) ?? null;
    const name = path.posix.basename(module.relPath);
    pages.push({
      path: module.pagePath,
      file: module.file,
      title: name,
      menu: name,
      description: shorten(toPlainText(getModuleSummary(module)), DESCRIPTION_LENGTH),
      tags: ['api', module.subtree],
      isInMenu: !!folder,
      isSearchable: false,
      body: pageBody(name),
      slots: {
        [PAGE_SLOT]: generator(module.pagePath, (ctx) => renderModulePage(ctx, module, folder)),
      },
    });
  }

  const symbolCount = index.modules.reduce(
    (n, module) => n + module.symbols.filter((s) => s.kind !== Kind.Reference).length,
    0
  );
  const coverage = {
    documented: index.coverage.engine.documented + index.coverage.toolkit.documented,
    total: index.coverage.engine.total + index.coverage.toolkit.total,
  };
  return {
    section: {
      path: API_SECTION_PATH,
      slots: { [LANDING_SLOT]: generator(API_SECTION_PATH, renderLanding) },
      pages,
      files: [TSCONFIG_FILE],
      dirs: [],
      searchDocs: getSearchDocs(index),
    },
    links: createLinkResolver(links),
    isStale,
    stats: {
      isCached: extract.isCached,
      extractMs: extract.durationMs,
      moduleCount: index.modules.length,
      symbolCount,
      coverage,
    },
  };
};
