import type { Highlighter } from 'shiki';
import type { JSONOutput } from 'typedoc';
import { HUB_CODE_THEMES } from '../code';
import { escapeHtml } from '../html';
import { Kind, type DeclarationReflection, type SignatureReflection, type SomeType } from './model';

/**
 * Signatures and types as TypeScript (p553 §2.2), printed from TypeDoc's model and highlighted
 * with the Hub's shiki themes. The printer writes segments: a named type remembers the reflection
 * it refers to, so the highlighted code can link it.
 */

/** A piece of printed code; `target` is the reflection id a named type refers to */
export type CodeSegment = { text: string; target?: number };

export class CodeWriter {
  readonly segments: CodeSegment[] = [];
  length = 0;

  write(text: string, target?: number) {
    if (!text) return this;
    const last = this.segments.at(-1);
    if (target === undefined && last && last.target === undefined) last.text += text;
    else this.segments.push({ text, target });
    this.length += text.length;
    return this;
  }

  append(other: CodeWriter) {
    for (const segment of other.segments) this.write(segment.text, segment.target);
    return this;
  }

  get text() {
    return this.segments.map((segment) => segment.text).join('');
  }
}

/** An object literal type longer than this prints as `{ … }`; its members are in a table */
const OBJECT_INLINE_MAX = 60;
/** A signature longer than this puts each parameter on its own line */
const SIGNATURE_LINE_MAX = 90;
/** A type alias's union or conditional type longer than this gets a line per member or branch */
const TYPE_LINE_MAX = 90;

export const COLLAPSED_OBJECT = '{ … }';

/** Where a type sits: what it needs parentheses around */
const Prec = {
  /** A union is fine */
  Top: 0,
  /** In a union or an intersection: a function or a conditional type needs parentheses */
  Union: 1,
  /** In an intersection: a union does too */
  Intersection: 2,
  /** An array's element, an operator's operand: anything compound does */
  Postfix: 3,
} as const;
type Prec = (typeof Prec)[keyof typeof Prec];

export type PrintOptions = {
  /** Object literal types with members print as `{ … }` (a table shows them) */
  collapseObjects?: boolean;
};

const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const printLiteral = (value: JSONOutput.LiteralType['value']) => {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'object') return `${value.negative ? '-' : ''}${value.value}n`;
  return String(value);
};

/** An object literal type's members (not a function type's) */
export const getObjectMembers = (type: SomeType | undefined) =>
  type?.type === 'reflection' && !type.declaration.signatures?.length
    ? type.declaration.children ?? []
    : [];

const isCollapsible = (type: SomeType | undefined) =>
  type?.type === 'reflection' && getObjectMembers(type).length > 0;

export const printType = (
  w: CodeWriter,
  type: SomeType | undefined,
  options: PrintOptions = {},
  prec: Prec = Prec.Top
): CodeWriter => {
  if (!type) return w.write('unknown');
  const sub = (t: SomeType | undefined, p: Prec) => printType(w, t, options, p);
  const list = (types: SomeType[], separator: string, p: Prec) =>
    types.forEach((t, i) => {
      if (i) w.write(separator);
      sub(t, p);
    });
  const wrap = (needs: boolean, body: () => void) => {
    if (needs) w.write('(');
    body();
    if (needs) w.write(')');
  };

  switch (type.type) {
    case 'intrinsic':
    case 'unknown':
      return w.write(type.name);
    case 'literal':
      return w.write(printLiteral(type.value));
    case 'reference': {
      // A type parameter's target is its declaration's: `T` would link the function it's on
      const isLinked = typeof type.target === 'number' && !type.refersToTypeParameter;
      w.write(type.name, isLinked ? (type.target as number) : undefined);
      if (type.typeArguments?.length) {
        w.write('<');
        list(type.typeArguments, ', ', Prec.Top);
        w.write('>');
      }
      return w;
    }
    case 'array':
      sub(type.elementType, Prec.Postfix);
      return w.write('[]');
    case 'union':
      wrap(prec >= Prec.Intersection, () => list(type.types, ' | ', Prec.Union));
      return w;
    case 'intersection':
      wrap(prec >= Prec.Postfix, () => list(type.types, ' & ', Prec.Intersection));
      return w;
    case 'tuple':
      w.write('[');
      list(type.elements ?? [], ', ', Prec.Top);
      return w.write(']');
    case 'namedTupleMember':
      w.write(`${type.name}${type.isOptional ? '?' : ''}: `);
      return sub(type.element, Prec.Top);
    case 'optional':
      sub(type.elementType, Prec.Postfix);
      return w.write('?');
    case 'rest':
      w.write('...');
      return sub(type.elementType, Prec.Postfix);
    case 'reflection':
      wrap(prec >= Prec.Union && !!type.declaration.signatures?.length, () =>
        printReflectionType(w, type.declaration, options)
      );
      return w;
    case 'conditional':
      wrap(prec >= Prec.Union, () => {
        sub(type.checkType, Prec.Union);
        w.write(' extends ');
        sub(type.extendsType, Prec.Union);
        w.write(' ? ');
        sub(type.trueType, Prec.Top);
        w.write(' : ');
        sub(type.falseType, Prec.Top);
      });
      return w;
    case 'indexedAccess':
      sub(type.objectType, Prec.Postfix);
      w.write('[');
      sub(type.indexType, Prec.Top);
      return w.write(']');
    case 'inferred':
      w.write(`infer ${type.name}`);
      if (type.constraint) {
        w.write(' extends ');
        sub(type.constraint, Prec.Union);
      }
      return w;
    case 'mapped': {
      const readonly = type.readonlyModifier
        ? `${type.readonlyModifier === '+' ? '' : '-'}readonly `
        : '';
      const optional = type.optionalModifier ? `${type.optionalModifier === '+' ? '' : '-'}?` : '';
      w.write(`{ ${readonly}[${type.parameter} in `);
      sub(type.parameterType, Prec.Top);
      if (type.nameType) {
        w.write(' as ');
        sub(type.nameType, Prec.Top);
      }
      w.write(`]${optional}: `);
      sub(type.templateType, Prec.Top);
      return w.write(' }');
    }
    case 'predicate':
      w.write(`${type.asserts ? 'asserts ' : ''}${type.name}`);
      if (type.targetType) {
        w.write(' is ');
        sub(type.targetType, Prec.Top);
      }
      return w;
    case 'query':
      w.write('typeof ');
      return sub(type.queryType, Prec.Postfix);
    case 'templateLiteral':
      w.write(`\`${type.head}`);
      for (const [t, text] of type.tail) {
        w.write('${');
        sub(t, Prec.Top);
        w.write(`}${text}`);
      }
      return w.write('`');
    case 'typeOperator':
      w.write(`${type.operator} `);
      return sub(type.target, Prec.Postfix);
  }
  return w;
};

/** A parameter list's `name?: Type`, `...rest: Type[]` */
const printParameter = (
  w: CodeWriter,
  parameter: JSONOutput.ParameterReflection,
  options: PrintOptions
) => {
  w.write(
    `${parameter.flags.isRest ? '...' : ''}${parameter.name}${parameter.flags.isOptional ? '?' : ''}: `
  );
  return printType(w, parameter.type, options);
};

const printTypeParameters = (
  w: CodeWriter,
  typeParameters: JSONOutput.TypeParameterReflection[] | undefined,
  options: PrintOptions
) => {
  if (!typeParameters?.length) return w;
  w.write('<');
  typeParameters.forEach((tp, i) => {
    if (i) w.write(', ');
    w.write(tp.name);
    if (tp.type) {
      w.write(' extends ');
      printType(w, tp.type, options);
    }
    if (tp.default) {
      w.write(' = ');
      printType(w, tp.default, options);
    }
  });
  return w.write('>');
};

/**
 * `(a: A, b?: B)`, each parameter on its own line when `prefix` and the list together are too
 * long (`multiline`)
 */
const printParameters = (
  w: CodeWriter,
  parameters: JSONOutput.ParameterReflection[] | undefined,
  options: PrintOptions,
  multiline: boolean
) => {
  const params = parameters ?? [];
  if (!multiline || !params.length) {
    w.write('(');
    params.forEach((p, i) => {
      if (i) w.write(', ');
      printParameter(w, p, options);
    });
    return w.write(')');
  }
  w.write('(\n');
  params.forEach((p, i) => {
    w.write('  ');
    printParameter(w, p, options);
    w.write(i < params.length - 1 ? ',\n' : '\n');
  });
  return w.write(')');
};

/** An object literal or function type, inline: `{ a: A; b?: B }`, `(a: A) => R` */
const printReflectionType = (
  w: CodeWriter,
  declaration: DeclarationReflection,
  options: PrintOptions
) => {
  const signatures = declaration.signatures ?? [];
  if (signatures.length === 1 && !declaration.children?.length) {
    const signature = signatures[0];
    if (signature.kind === Kind.ConstructorSignature) w.write('new ');
    printTypeParameters(w, signature.typeParameters, options);
    printParameters(w, signature.parameters, options, false);
    w.write(' => ');
    return printType(w, signature.type, options);
  }

  const members = new CodeWriter();
  const items: (() => void)[] = [];
  for (const signature of signatures) {
    items.push(() => {
      printTypeParameters(members, signature.typeParameters, options);
      printParameters(members, signature.parameters, options, false);
      members.write(': ');
      printType(members, signature.type, options);
    });
  }
  for (const index of declaration.indexSignatures ?? []) {
    items.push(() => {
      const [key] = index.parameters ?? [];
      members.write(`[${key?.name ?? 'key'}: `);
      printType(members, key?.type, options);
      members.write(']: ');
      printType(members, index.type, options);
    });
  }
  for (const child of declaration.children ?? []) {
    items.push(() => {
      members.write(
        `${child.flags.isReadonly ? 'readonly ' : ''}${child.name}${child.flags.isOptional ? '?' : ''}`
      );
      const signature = child.signatures?.[0];
      if (child.kind === Kind.Method && signature) {
        printParameters(members, signature.parameters, options, false);
        members.write(': ');
        printType(members, signature.type, options);
      } else {
        members.write(': ');
        printType(members, child.type ?? child.getSignature?.type, options);
      }
    });
  }
  if (!items.length) return w.write('{}');
  if (options.collapseObjects && declaration.children?.length) return w.write(COLLAPSED_OBJECT);
  items.forEach((item, i) => {
    members.write(i ? '; ' : '{ ');
    item();
  });
  members.write(' }');
  return members.length > OBJECT_INLINE_MAX ? w.write(COLLAPSED_OBJECT) : w.append(members);
};

/** A type on its own: a table cell's, a return value's */
export const printTypeOnly = (type: SomeType | undefined, options: PrintOptions = {}) =>
  printType(new CodeWriter(), type, options);

/**
 * A call signature as a declaration: `function name<T>(a: A): R` (`prefix` 'function '),
 * `constructor(a: A)`, `static name(a: A): R`. Long ones get a parameter per line.
 */
export const printSignature = (
  name: string,
  signature: SignatureReflection,
  { prefix = '', returns = true }: { prefix?: string; returns?: boolean } = {}
) => {
  const print = (multiline: boolean) => {
    const w = new CodeWriter().write(`${prefix}${name}`);
    printTypeParameters(w, signature.typeParameters, {});
    printParameters(w, signature.parameters, {}, multiline);
    if (returns) {
      w.write(': ');
      printType(w, signature.type, {});
    }
    return w;
  };
  const single = print(false);
  return single.length > SIGNATURE_LINE_MAX && signature.parameters?.length ? print(true) : single;
};

/**
 * The members a type alias's table shows: its own (TypeDoc puts an object literal alias's
 * members on the alias, with no `type`), else its type's object literal parts
 */
export const getTabledMembers = (symbol: DeclarationReflection): DeclarationReflection[] => {
  if (!symbol.type) return symbol.children ?? [];
  const type = symbol.type;
  if (type.type === 'reflection') return getObjectMembers(type);
  if (type.type === 'intersection') return type.types.flatMap((t) => getObjectMembers(t));
  return [];
};

/**
 * A union alias's object variants, each with its own table (`CameraProps`: one per camera type,
 * as `typedoc-plugin-zod` expands a `z.union`), labelled by the discriminant when every variant has
 * the same literal-typed key (`type: 'PERSPECTIVE'`), else by its position
 */
export const getTabledVariants = (symbol: DeclarationReflection) => {
  if (symbol.type?.type !== 'union') return [];
  const variants = symbol.type.types
    .map((t) =>
      t.type === 'intersection'
        ? t.types.flatMap((part) => getObjectMembers(part))
        : getObjectMembers(t)
    )
    .filter((members) => members.length);
  const literalOf = (members: DeclarationReflection[], name: string) => {
    const type = members.find((member) => member.name === name)?.type;
    return type?.type === 'literal' ? printLiteral(type.value) : null;
  };
  const key = variants[0]
    ?.map((member) => member.name)
    .find((name) => variants.every((members) => literalOf(members, name) !== null));
  return variants.map((members, i) => ({
    members,
    label: key ? `${key}: ${literalOf(members, key)}` : `variant ${i + 1} of ${variants.length}`,
  }));
};

/** A conditional type a branch per line: `A extends B\n  ? T\n  : F`, nested ones indented */
const printConditionalLines = (
  w: CodeWriter,
  type: JSONOutput.ConditionalType,
  options: PrintOptions,
  indent: string
) => {
  printType(w, type.checkType, options, Prec.Union);
  w.write(' extends ');
  printType(w, type.extendsType, options, Prec.Union);
  const inner = `${indent}  `;
  for (const [mark, branch] of [
    ['?', type.trueType],
    [':', type.falseType],
  ] as const) {
    w.write(`\n${inner}${mark} `);
    if (branch.type === 'conditional') printConditionalLines(w, branch, options, inner);
    else printType(w, branch, options);
  }
};

/**
 * `type Name<T> = …`: a tabled object prints as `{ … }`, and a long union or conditional type
 * gets a line per member or branch
 */
export const printTypeAlias = (symbol: DeclarationReflection) => {
  const options: PrintOptions = {
    collapseObjects: getTabledMembers(symbol).length > 0 || getTabledVariants(symbol).length > 0,
  };
  const w = new CodeWriter().write(`type ${symbol.name}`);
  printTypeParameters(w, symbol.typeParameters, {});
  w.write(' = ');
  const type = symbol.type;
  if (!type) return w.write(symbol.children?.length ? COLLAPSED_OBJECT : '{}');
  if (type.type !== 'union' && type.type !== 'conditional') return printType(w, type, options);
  const single = printTypeOnly(type, options);
  if (w.length + single.length <= TYPE_LINE_MAX) return w.append(single);
  if (type.type === 'conditional') {
    w.write('\n  ');
    printConditionalLines(w, type, options, '  ');
    return w;
  }
  for (const member of type.types) {
    w.write('\n  | ');
    printType(w, member, options, Prec.Union);
  }
  return w;
};

/** `class Name<T> extends Base implements A, B`, `interface Name<T> extends A` */
export const printHeritage = (keyword: 'class' | 'interface', symbol: DeclarationReflection) => {
  const w = new CodeWriter().write(`${keyword} ${symbol.name}`);
  printTypeParameters(w, symbol.typeParameters, {});
  const clause = (word: string, types: SomeType[] | undefined) => {
    if (!types?.length) return;
    w.write(` ${word} `);
    types.forEach((t, i) => {
      if (i) w.write(', ');
      printType(w, t, {});
    });
  };
  clause('extends', symbol.extendedTypes);
  clause('implements', symbol.implementedTypes);
  return w;
};

/** `const NAME: Type`, or `const NAME = 'value'` for a literal */
export const printVariable = (symbol: DeclarationReflection) => {
  const keyword = symbol.flags.isConst ? 'const' : 'let';
  const w = new CodeWriter().write(`${keyword} ${symbol.name}`);
  if (symbol.type?.type === 'literal') return w.write(` = ${printLiteral(symbol.type.value)}`);
  w.write(': ');
  return printType(w, symbol.type, { collapseObjects: isCollapsible(symbol.type) });
};

// --- Highlighting ---

/** Resolves a segment's target to an href, or leaves it unlinked (undefined) */
export type TargetHref = (target: number) => string | undefined;

type Highlighted = { lines: string[]; rootStyle: string };

const styleAttr = (style: Record<string, string> | undefined) =>
  style
    ? ` style="${escapeHtml(
        Object.entries(style)
          .map(([key, value]) => `${key}:${value}`)
          .join(';')
      )}"`
    : '';

/**
 * The code's tokens as HTML lines, with the segments that have a resolvable target wrapped in a
 * link (a token is split where a link starts or ends)
 */
const highlight = (
  highlighter: Highlighter,
  w: CodeWriter,
  href?: TargetHref,
  prefix = ''
): Highlighted => {
  const code = w.text;
  const links: { start: number; end: number; href: string }[] = [];
  let offset = 0;
  for (const segment of w.segments) {
    const url = segment.target !== undefined ? href?.(segment.target) : undefined;
    if (url) links.push({ start: offset, end: offset + segment.text.length, href: url });
    offset += segment.text.length;
  }
  const result = highlighter.codeToTokens(prefix + code, {
    lang: 'typescript',
    themes: HUB_CODE_THEMES,
    defaultColor: false,
  });
  const rootStyle = result.rootStyle;
  // The prefix's tokens are dropped, and the others' offsets moved back to the code's
  const tokens = result.tokens.map((line) =>
    line.flatMap((token) => {
      const end = token.offset + token.content.length;
      if (end <= prefix.length) return [];
      const cut = Math.max(0, prefix.length - token.offset);
      return [
        {
          ...token,
          content: token.content.slice(cut),
          offset: token.offset + cut - prefix.length,
        },
      ];
    })
  );
  const lines = tokens.map((line) => {
    let html = '';
    for (const token of line) {
      const style = styleAttr(token.htmlStyle as Record<string, string> | undefined);
      const end = token.offset + token.content.length;
      // The token's pieces between link edges
      const cuts = new Set([token.offset, end]);
      for (const link of links) {
        if (link.start > token.offset && link.start < end) cuts.add(link.start);
        if (link.end > token.offset && link.end < end) cuts.add(link.end);
      }
      const points = [...cuts].sort((a, b) => a - b);
      for (let i = 0; i < points.length - 1; i++) {
        const text = code.slice(points[i], points[i + 1]);
        const link = links.find((l) => l.start <= points[i] && points[i] < l.end);
        const span = `<span${style}>${escapeHtml(text)}</span>`;
        html += link
          ? `<a class="hubApiTypeLink" href="${escapeHtml(link.href)}">${span}</a>`
          : span;
      }
    }
    return html;
  });
  return { lines, rootStyle: rootStyle || '' };
};

/**
 * A member's signature (`addSystem(stage: X): void`, `constructor(…)`) reads as a call outside a
 * class: highlighted in one, which is left out
 */
export const MEMBER_POSITION_PREFIX = 'class C { ';

/** A highlighted code block: a symbol's signature or declaration */
export const renderCodeBlock = (
  highlighter: Highlighter,
  w: CodeWriter,
  href?: TargetHref,
  prefix = ''
) => {
  const { lines, rootStyle } = highlight(highlighter, w, href, prefix);
  const code = lines.map((line) => `<span class="line">${line}</span>`).join('');
  return `<div class="hubCode hubApiSignature"><pre class="shiki" style="${escapeHtml(rootStyle)}" tabindex="0"><code>${code}</code></pre></div>\n`;
};

/**
 * A type alone reads as an expression to the grammar (`Mesh` would be a variable): it's
 * highlighted as an alias's type, and the alias is left out
 */
const TYPE_POSITION_PREFIX = 'type T = ';

/** Highlighted inline code: a type in a table */
export const renderInlineCode = (highlighter: Highlighter, w: CodeWriter, href?: TargetHref) =>
  `<code class="hubCodeInline hubApiType">${highlight(highlighter, w, href, TYPE_POSITION_PREFIX).lines.join(' ')}</code>`;
