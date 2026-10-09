/**
 * The repo's import graph from the TypeScript AST (p602 Phase 2): every import, re-export and
 * dynamic `import()` of a module with the names it takes, and every name a module exports, so a
 * name imported through a re-export resolves to the module that declares it.
 */
import path from 'path';
import ts from 'typescript';

/** `type`: every binding is type-only; `dynamic`: an `import()` */
export type ImportKind = 'runtime' | 'type' | 'dynamic';

export type RawImport = {
  specifier: string;
  kind: ImportKind;
  /** The imported names; `*` for a namespace, a star re-export or a dynamic import */
  names: string[];
  isReexport: boolean;
  line: number;
};

export type RawExports = {
  /** Names declared in the module */
  local: string[];
  /** Exported name → where it comes from (`export { a } from`, or an exported import binding) */
  named: Record<string, { specifier: string; imported: string }>;
  /** `export * from` specifiers */
  star: string[];
  /** The local names that are only types (interfaces and type aliases) */
  types: string[];
};

export type ParsedModule = { imports: RawImport[]; exports: RawExports };

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);

const bindingNames = (name: ts.BindingName, out: string[]) => {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
};

/** Parses one module's source; specifiers are left as written */
export const parseModuleSource = (fileName: string, text: string): ParsedModule => {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: RawImport[] = [];
  const exports: RawExports = { local: [], named: {}, star: [], types: [] };
  const importBindings = new Map<string, { specifier: string; imported: string }>();
  const localExportSpecs: { local: string; exported: string }[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const specifier = st.moduleSpecifier.text;
      const clause = st.importClause;
      const names: string[] = [];
      let allType = !!clause?.isTypeOnly;
      if (clause) {
        let hasValue = false;
        if (clause.name) {
          names.push('default');
          importBindings.set(clause.name.text, { specifier, imported: 'default' });
          hasValue = true;
        }
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          names.push('*');
          importBindings.set(nb.name.text, { specifier, imported: '*' });
          hasValue = true;
        } else if (nb) {
          for (const el of nb.elements) {
            const imported = (el.propertyName ?? el.name).text;
            names.push(imported);
            importBindings.set(el.name.text, { specifier, imported });
            if (!el.isTypeOnly) hasValue = true;
          }
        }
        if (!clause.isTypeOnly) allType = !hasValue && names.length > 0;
      }
      imports.push({
        specifier,
        kind: allType ? 'type' : 'runtime',
        names,
        isReexport: false,
        line: lineOf(st),
      });
    } else if (ts.isExportDeclaration(st)) {
      const spec =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      const clause = st.exportClause;
      if (spec) {
        const names: string[] = [];
        let allType = st.isTypeOnly;
        if (!clause) {
          exports.star.push(spec);
          names.push('*');
        } else if (ts.isNamespaceExport(clause)) {
          exports.named[clause.name.text] = { specifier: spec, imported: '*' };
          names.push('*');
        } else {
          let hasValue = false;
          for (const el of clause.elements) {
            const imported = (el.propertyName ?? el.name).text;
            exports.named[el.name.text] = { specifier: spec, imported };
            names.push(imported);
            if (!el.isTypeOnly) hasValue = true;
          }
          if (!st.isTypeOnly) allType = !hasValue;
        }
        imports.push({
          specifier: spec,
          kind: allType ? 'type' : 'runtime',
          names,
          isReexport: true,
          line: lineOf(st),
        });
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          localExportSpecs.push({
            local: (el.propertyName ?? el.name).text,
            exported: el.name.text,
          });
        }
      }
    } else if (ts.isExportAssignment(st)) {
      exports.local.push('default');
    } else if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) exports.local.push('default');
      else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) bindingNames(decl.name, exports.local);
      } else if (
        (ts.isFunctionDeclaration(st) ||
          ts.isClassDeclaration(st) ||
          ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isEnumDeclaration(st) ||
          ts.isModuleDeclaration(st)) &&
        st.name &&
        ts.isIdentifier(st.name)
      ) {
        exports.local.push(st.name.text);
        if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
          exports.types.push(st.name.text);
        }
      }
    }
  }

  // `export { x }` of an imported binding is a re-export
  for (const { local, exported } of localExportSpecs) {
    const binding = importBindings.get(local);
    if (binding) exports.named[exported] = binding;
    else exports.local.push(exported);
  }

  // Dynamic imports anywhere in the module
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push({
        specifier: node.arguments[0].text,
        kind: 'dynamic',
        names: ['*'],
        isReexport: false,
        line: lineOf(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { imports, exports };
};

const RESOLVE_SUFFIXES = ['', '.ts', '.d.ts', '/index.ts'];

/**
 * A relative specifier as a repo-relative file (its query, `?worker` / `?raw` / `?url`, dropped);
 * `null` for a package, `undefined` for a relative path that isn't a file
 */
export const resolveSpecifier = (
  fromFile: string,
  specifier: string,
  exists: (file: string) => boolean
): string | null | undefined => {
  if (!specifier.startsWith('.')) return null;
  const bare = specifier.replace(/\?.*$/, '');
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), bare));
  for (const suffix of RESOLVE_SUFFIXES) {
    if (exists(base + suffix)) return base + suffix;
  }
  if (base.endsWith('.js') && exists(base.replace(/\.js$/, '.ts'))) {
    return base.replace(/\.js$/, '.ts');
  }
  return undefined;
};

export type ResolvedImport = RawImport & { from: string; resolved: string | null | undefined };

export type ImportGraph = {
  modules: Map<string, ParsedModule>;
  imports: ResolvedImport[];
  /** The module and name that declare an exported name, through re-exports */
  resolveExport: (file: string, name: string) => { file: string; name: string } | undefined;
  /** Every name a module exports, through star re-exports */
  allExports: (file: string) => Set<string>;
  /** Whether an exported name is declared as a type only (an import of it emits nothing) */
  isTypeExport: (file: string, name: string) => boolean;
};

export const buildImportGraph = (
  sources: Map<string, string>,
  exists: (file: string) => boolean
): ImportGraph => {
  const modules = new Map<string, ParsedModule>();
  const imports: ResolvedImport[] = [];
  for (const [file, text] of sources) {
    const parsed = parseModuleSource(file, text);
    modules.set(file, parsed);
    for (const imp of parsed.imports) {
      imports.push({ ...imp, from: file, resolved: resolveSpecifier(file, imp.specifier, exists) });
    }
  }
  const resolveIn = (file: string, specifier: string) => resolveSpecifier(file, specifier, exists);

  const resolveExport = (
    file: string,
    name: string,
    seen = new Set<string>()
  ): { file: string; name: string } | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const mod = modules.get(file);
    if (!mod) return undefined;
    if (mod.exports.local.includes(name)) return { file, name };
    const named = mod.exports.named[name];
    if (named) {
      const target = resolveIn(file, named.specifier);
      if (!target) return undefined;
      if (named.imported === '*') return { file: target, name: '*' };
      return resolveExport(target, named.imported, seen) ?? { file: target, name: named.imported };
    }
    if (name === 'default') return undefined;
    for (const spec of mod.exports.star) {
      const target = resolveIn(file, spec);
      const found = target ? resolveExport(target, name, seen) : undefined;
      if (found) return found;
    }
    return undefined;
  };

  const allExports = (file: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(file)) return out;
    seen.add(file);
    const mod = modules.get(file);
    if (!mod) return out;
    for (const n of mod.exports.local) out.add(n);
    for (const n of Object.keys(mod.exports.named)) out.add(n);
    for (const spec of mod.exports.star) {
      const target = resolveIn(file, spec);
      if (target) for (const n of allExports(target, seen)) if (n !== 'default') out.add(n);
    }
    return out;
  };

  return {
    modules,
    imports,
    resolveExport: (file, name) => resolveExport(file, name),
    allExports: (file) => allExports(file),
    isTypeExport: (file, name) => {
      const decl = resolveExport(file, name);
      return !!decl && !!modules.get(decl.file)?.exports.types.includes(decl.name);
    },
  };
};
