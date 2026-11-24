import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** Small, fast options for programs that only list a module's exports. */
export const MINI_OPTIONS = {
  noLib: true,
  types: [],
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  resolveJsonModule: true,
};

const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

/** A compiler host that also serves in-memory files. */
export function virtualHost(options, files) {
  // Parent pointers are set by the binder once a checker exists, so the parser can skip them.
  const host = ts.createCompilerHost(options, false);
  const v = new Map([...files].map(([p, t]) => [norm(p), t]));
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (f, lang, onErr, create) =>
    v.has(norm(f)) ? ts.createSourceFile(f, v.get(norm(f)), lang, true) : getSourceFile.call(host, f, lang, onErr, create);
  host.fileExists = (f) => v.has(norm(f)) || fileExists.call(host, f);
  host.readFile = (f) => (v.has(norm(f)) ? v.get(norm(f)) : readFile.call(host, f));
  return host;
}

/**
 * The symbol behind `export = x` (CommonJS-style typings such as lodash or express),
 * using only public API (`checker.resolveExternalModuleSymbol` is internal).
 */
export function exportEqualsTarget(checker, moduleSymbol) {
  const s = moduleSymbol.exports?.get('export=');
  if (!s) return null;
  if (s.flags & ts.SymbolFlags.Alias) {
    try { return checker.getAliasedSymbol(s); } catch { return s; }
  }
  return s;
}

/** Line/column (1-based) of `pos` in `text`, without TypeScript internals. */
export function lineCol(lineStarts, pos) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: pos - lineStarts[lo] + 1 };
}

export function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (ch === 10 /* \n */ || ch === 0x2028 || ch === 0x2029) starts.push(i + 1);
  }
  return starts;
}

/** The module specifier of a statement we generated ourselves (`import * as x from "..."`). */
export function specifierOf(statement) {
  return ts.isImportDeclaration(statement) ? statement.moduleSpecifier : null;
}

/**
 * What a module exports, as the checker sees it.
 * `values` excludes type-only exports, so `import { x }` suggestions stay runnable.
 */
export function moduleNames(checker, specNode) {
  const sym = checker.getSymbolAtLocation(specNode);
  if (!sym) return null;
  const names = new Set();
  const values = new Set();
  for (const s of checker.getExportsOfModule(sym)) {
    names.add(s.name);
    let r = s;
    if (s.flags & ts.SymbolFlags.Alias) {
      try { r = checker.getAliasedSymbol(s); } catch { r = null; }
    }
    if (!r || r.flags & ts.SymbolFlags.Value) values.add(s.name);
  }
  let exportEquals = false;
  const target = exportEqualsTarget(checker, sym);
  if (target) {
    exportEquals = true;
    const t = checker.getTypeOfSymbolAtLocation(target, specNode);
    if (t.flags & ts.TypeFlags.Any) return { sym, any: true, names, values, exportEquals };
    for (const p of checker.getPropertiesOfType(t)) {
      names.add(p.name);
      values.add(p.name);
    }
  }
  return { sym, any: false, names, values, exportEquals };
}

/** Export names of `spec` resolved from `<root>/node_modules`. */
export function namesInRoot(root, spec) {
  const file = join(root, '__importprobe__.ts');
  const host = virtualHost(MINI_OPTIONS, new Map([[file, `import * as __m from ${JSON.stringify(spec)};\n`]]));
  const program = ts.createProgram({ rootNames: [file], options: MINI_OPTIONS, host });
  const sf = program.getSourceFile(file);
  const spec0 = sf && specifierOf(sf.statements[0]);
  return spec0 ? moduleNames(program.getTypeChecker(), spec0) : null;
}

const ownerCache = new Map();
/** The installed package a file belongs to: {name, version, dir}, or null for project files. */
export function ownerOf(fileName) {
  let d = dirname(fileName);
  if (ownerCache.has(d)) return ownerCache.get(d);
  const start = d;
  let found = null;
  for (;;) {
    const parent = dirname(d);
    const inNodeModules = basename(parent) === 'node_modules' || (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules');
    if (inNodeModules) {
      try {
        const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
        if (pkg.name && pkg.version) found = { name: pkg.name, version: pkg.version, dir: d };
      } catch { /* not a package root */ }
      break;
    }
    if (parent === d) break;
    d = parent;
  }
  ownerCache.set(start, found);
  return found;
}

export function isDeclarationFile(fileName) {
  return /\.d\.[cm]?ts$/.test(fileName);
}
