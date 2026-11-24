import ts from 'typescript';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { isBuiltin } from 'node:module';
import { classify, builtinNames, packageNameOf } from './specifier.js';
import { suggest } from './suggest.js';
import { getPackage, weeklyDownloads, similarPackages } from './registry.js';
import { fetchForInspection } from './inspect.js';
import { findInstalled } from './project.js';
import { moduleNames, ownerOf, isDeclarationFile, virtualHost, lineStartsOf, lineCol } from './tsutil.js';
import { findInHistory } from './history.js';

const DAY = 24 * 60 * 60 * 1000;
const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];
// Built-ins we may import to look for a name that the AI put in the wrong module.
const COMMON_BUILTINS = ['fs', 'fs/promises', 'path', 'util', 'os', 'crypto', 'stream', 'stream/promises', 'events', 'url', 'child_process', 'http', 'https', 'net', 'zlib', 'buffer', 'timers', 'timers/promises', 'assert', 'querystring', 'readline', 'worker_threads', 'process', 'module', 'perf_hooks', 'string_decoder', 'dns'];
const MAX_HISTORY_LOOKUPS = 12;
// TS2339 "Property 'x' does not exist on type 'Y'", TS2551 "... Did you mean 'z'?"
const MISSING_PROPERTY = new Set([2339, 2551]);
/**
 * Check every import in `files` against what really exists.
 * @param {{files:string[], project:ReturnType<import('./project.js').loadProject>,
 *   offline?:boolean, deep?:boolean, hints?:boolean}} opts
 *   deep: also check chained calls on library types; hints: look up other versions/packages
 */
export async function analyze({ files, project, offline = false, deep = true, hints = true }) {
  const T0 = Date.now();
  const debug = process.env.IMPORTPROBE_DEBUG ? (label) => process.stderr.write(`[importprobe] ${label}: ${Date.now() - T0}ms\n`) : () => {};
  const findings = [];
  const add = (f) => { findings.push(f); return f; };

  // ── 1. Find every package the files use (fast pre-scan, no type checking) ──
  const uses = new Map(); // package name -> [{file, line, column}]
  const builtinsUsed = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lineStarts = lineStartsOf(text);
    for (const imp of ts.preProcessFile(text, true, true).importedFiles) {
      const c = classify(imp.fileName, project.aliasPatterns);
      if (c.kind === 'builtin' && isBuiltin(imp.fileName)) builtinsUsed.add(c.name);
      if (c.kind !== 'package') continue;
      if (!uses.has(c.name)) uses.set(c.name, []);
      uses.get(c.name).push({ file, ...lineCol(lineStarts, imp.pos) });
    }
  }

  // ── 2. Package level: does it exist? is it declared? is it installed? ──
  const status = new Map();
  const fetchedRoots = new Map();
  await pool([...uses.keys()], 8, async (name) => {
    status.set(name, await checkPackage(name, uses.get(name)));
  });

  async function checkPackage(name, at) {
    const first = at[0];
    const declared = project.deps.has(name) || name === project.name;
    const where = { file: first.file, line: first.line, column: first.column, count: at.length };

    const installedPath = findInstalled(name, dirname(first.file));
    if (installedPath) {
      let version = null;
      try { version = JSON.parse(readFileSync(join(installedPath, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
      if (!declared) {
        add({
          ...where, severity: 'warning', rule: 'undeclared-dependency',
          message: `"${name}" is not in package.json. It only works because another package pulled it in — a clean install or deploy can break.`,
          fix: `npm install ${name}`,
        });
      }
      return { state: 'installed', version };
    }

    if (offline) {
      add({ ...where, severity: 'warning', rule: 'not-verified', message: `"${name}" is not installed and --offline is set, so it could not be checked.` });
      return { state: 'unknown' };
    }

    let pkg;
    try {
      pkg = await getPackage(name);
    } catch (e) {
      add({ ...where, severity: 'warning', rule: 'not-verified', message: `Could not reach the npm registry for "${name}": ${e.message}` });
      return { state: 'unknown' };
    }

    if (!pkg || pkg.unpublished || !Object.keys(pkg.versions).length) {
      const sims = await similarPackages(name).catch(() => []);
      add({
        ...where, severity: 'error', rule: 'unknown-package',
        message: pkg
          ? `"${name}" was unpublished from npm. Anyone could register this name again.`
          : `"${name}" does not exist on npm — most likely made up by an AI.${declared ? ' It is listed in package.json too.' : ''}`,
        suggestions: sims,
      });
      return { state: 'missing' };
    }

    const ageDays = pkg.created ? (Date.now() - Date.parse(pkg.created)) / DAY : null;
    const downloads = await weeklyDownloads(name);
    const young = ageDays !== null && ageDays < 30;
    const obscure = downloads !== null && downloads < 100;

    if (!declared && (young || obscure)) {
      const bits = [];
      if (young) bits.push(`was first published ${Math.max(0, Math.round(ageDays))} day(s) ago`);
      if (downloads !== null) bits.push(`had ${downloads} download(s) last week`);
      add({
        ...where, severity: 'error', rule: 'suspicious-package',
        message: `"${name}" exists on npm but ${bits.join(' and ')}. Names that AIs invent get registered by attackers ("slopsquatting") — check who published it before installing.`,
        suggestions: await similarPackages(name).catch(() => []),
      });
      return { state: 'suspicious' };
    }

    if (!declared) {
      add({
        ...where, severity: 'error', rule: 'missing-dependency',
        message: `"${name}" is not in package.json and not installed, so this code cannot run. It is a real package (${fmt(downloads)} downloads/week).`,
        fix: `npm install ${name}`,
      });
    } else {
      add({ ...where, severity: 'info', rule: 'not-installed', message: `"${name}" is declared but not installed — checked against the published package instead.` });
    }

    // Fetch the published files (types + JS, never executed) so exports can be checked without installing.
    const range = project.deps.get(name);
    try {
      const got = await fetchForInspection(name, range);
      if (!got) throw new Error('no downloadable version');
      fetchedRoots.set(name, got.root);
      return { state: 'fetched', version: got.version };
    } catch (e) {
      add({ ...where, severity: 'info', rule: 'not-verified', message: `Could not download "${name}${range ? `@${range}` : ''}" to check its exports: ${e.message}` });
      return { state: 'unknown' };
    }
  }

  debug('packages checked');
  // Runtime export names of Node built-ins (safe: these are Node's own modules).
  const builtinExports = new Map();
  const loadBuiltin = async (b) => {
    if (builtinExports.has(b)) return builtinExports.get(b);
    let names = null;
    try { names = new Set(Object.keys(await import(`node:${b}`))); } catch { /* not importable */ }
    builtinExports.set(b, names);
    return names;
  };
  for (const b of builtinsUsed) await loadBuiltin(b);

  // ── 3. Build one TypeScript program and check every import against real declarations ──
  const projectOptions = Object.fromEntries(Object.entries(project.compilerOptions).filter(([, v]) => v !== undefined));
  const options = {
    allowJs: true,
    checkJs: deep,
    noEmit: true,
    skipLibCheck: true,
    maxNodeModuleJsDepth: 1,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    allowImportingTsExtensions: true,
    allowArbitraryExtensions: true,
    ...projectOptions,
  };
  const depsProbe = join(project.root, '__importprobe_deps__.ts');
  const declaredDeps = [...project.deps.keys()].filter((d) => !d.startsWith('@types/'));
  const host = virtualHost(options, new Map([[depsProbe, declaredDeps.map((d, i) => `import * as __d${i} from ${JSON.stringify(d)};`).join('\n')]]));
  // Same resolution cache tsc uses; without it every lookup walks node_modules again (~3x slower).
  const resolutionCache = ts.createModuleResolutionCache(project.root, (f) => host.getCanonicalFileName(f), options);
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, opts, containingSourceFile) =>
    literals.map((lit) => {
      const mode = ts.getModeForUsageLocation(containingSourceFile, lit, opts);
      let r = ts.resolveModuleName(lit.text, containingFile, opts, host, resolutionCache, redirectedReference, mode);
      if (!r.resolvedModule) {
        const root = fetchedRoots.get(packageNameOf(lit.text));
        if (root) r = ts.resolveModuleName(lit.text, join(root, '__importprobe__.ts'), opts, host, resolutionCache, undefined, mode);
      }
      return r;
    });
  host.getModuleResolutionCache = () => resolutionCache;

  const fileSet = new Set(files.map((f) => resolve(f)));
  const rootNames = [...files, ...project.declarationFiles.filter((f) => !fileSet.has(f))];
  const program = ts.createProgram({ rootNames, options, host });
  debug(`program created (${program.getSourceFiles().length} files)`);
  if (process.env.IMPORTPROBE_DEBUG === 'files') {
    const by = new Map();
    for (const s of program.getSourceFiles()) {
      const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(s.fileName);
      const k = m ? m[1] : s.fileName.includes('typescript/lib') ? 'typescript lib' : 'project';
      by.set(k, (by.get(k) || 0) + s.text.length);
    }
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 12)) process.stderr.write(`  ${(v / 1024).toFixed(0).padStart(6)} KB  ${k}\n`);
  }
  const checker = program.getTypeChecker();
  debug('checker ready');
  let importCount = 0;
  const historyJobs = []; // findings that may have been valid in another major version
  const elsewhereJobs = []; // export names that might live in another package
  const declaredNames = new Map(); // package dir -> text of its declaration files (for JS files)

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const bindings = new Map(); // local symbol -> module info
    const reported = new Set(); // positions already reported (avoid duplicates from the deep pass)
    const accesses = new Map(); // start of property name -> PropertyAccessExpression
    const loc = (node) => {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return { file, line: line + 1, column: character + 1 };
    };

    const bind = (nameNode, mod, whole) => {
      const sym = checker.getSymbolAtLocation(nameNode);
      if (sym) bindings.set(sym, { ...mod, local: nameNode.text, whole });
    };

    const checkModule = (specNode) => {
      importCount++;
      const spec = specNode.text;
      const c = classify(spec, project.aliasPatterns);
      if (c.kind === 'other') return null;

      if (c.kind === 'builtin') {
        if (!isBuiltin(spec)) {
          add({ ...loc(specNode), severity: 'error', rule: 'unknown-builtin', message: `"${spec}" is not a Node.js built-in module.`, suggestions: suggest(c.name, builtinNames()).map((n) => `node:${n}`) });
          return null;
        }
        const names = builtinExports.get(c.name);
        return names ? { kind: 'builtin', spec, names, values: names, display: spec, exact: true } : null;
      }

      const st = c.kind === 'package' ? status.get(c.name) : null;
      if (st && ['missing', 'suspicious', 'unknown'].includes(st.state)) return null; // already reported
      const display = c.kind === 'package' ? `${c.name}${st?.version ? `@${st.version}` : ''}` : `"${spec}"`;

      const info = moduleNames(checker, specNode);
      if (!info) {
        if (c.asset) return null;
        if (c.kind === 'relative') {
          const target = resolve(dirname(file), spec);
          if (!existsAny(target)) {
            add({ ...loc(specNode), severity: 'error', rule: 'missing-file', message: `"${spec}" does not exist.`, suggestions: siblingSuggestions(target) });
          }
        } else if (c.kind === 'alias') {
          add({ ...loc(specNode), severity: 'warning', rule: 'unresolved-alias', message: `"${spec}" does not resolve through your tsconfig/jsconfig paths.` });
        } else if (c.kind === 'package' && c.subpath && !/\.(js|mjs|cjs|json)$/.test(c.subpath)) {
          add({
            ...loc(specNode), severity: 'error', rule: 'unknown-subpath',
            message: `${display} has no "${c.subpath}" entry point.`,
            suggestions: suggest(c.subpath, subpathsOf(c.name, c.subpath, dirname(file), fetchedRoots.get(c.name))).map((s) => `${c.name}/${s}`),
          });
        }
        return null;
      }
      if (info.any) return null; // `export = any` – nothing to check against

      const declFile = info.sym.declarations?.[0]?.getSourceFile().fileName || '';
      const typed = /\.(d\.[cm]?ts|[cm]?tsx?)$/.test(declFile);
      return {
        kind: c.kind === 'package' ? 'package' : 'local',
        spec,
        names: info.names,
        values: info.values,
        exportEquals: info.exportEquals,
        display,
        // Exports inferred from plain JS can be incomplete, so those findings are warnings.
        exact: c.kind !== 'package' || typed,
        declFile,
        owner: c.kind === 'package' && isDeclarationFile(declFile) ? ownerOf(declFile) : null,
      };
    };

    const checkNamed = (mod, nameNode, reportNode, typeOnly) => {
      const name = nameNode.text;
      if (name === 'default' || mod.names.has(name)) return;
      const f = add({
        ...loc(reportNode), severity: mod.exact ? 'error' : 'warning', rule: 'unknown-export',
        message: `${mod.display} has no export named "${name}".`,
        suggestions: suggest(name, typeOnly || !mod.values.size ? mod.names : mod.values),
      });
      reported.add(reportNode.getStart(sf));
      if (mod.owner) historyJobs.push({ finding: f, owner: mod.owner, spec: mod.spec, name });
      if (mod.kind !== 'local') elsewhereJobs.push({ finding: f, name, from: mod });
    };

    const checkDefault = (mod, nameNode) => {
      // Packages: TypeScript allows synthetic defaults for CommonJS, so only local ES modules are checked.
      if (mod.kind !== 'local' || mod.exportEquals || mod.names.has('default') || !mod.names.size) return;
      if (isDeclarationFile(mod.declFile)) return;
      add({
        ...loc(nameNode), severity: 'error', rule: 'no-default-export',
        message: `${mod.display} has no default export.`,
        suggestions: suggest(nameNode.text, mod.values).map((n) => `{ ${n} }`),
      });
    };

    const checkMember = (node) => {
      const sym = checker.getSymbolAtLocation(node.expression);
      const b = sym && bindings.get(sym);
      if (!b) return;
      const name = node.name.text;
      if (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return;

      let candidates;
      if (b.kind === 'builtin') {
        // Only `import fs from 'node:fs'` / `import * as fs` bind the module itself.
        if (!b.whole || b.names.has(name)) return;
        candidates = [...b.names];
      } else {
        const t = checker.getTypeAtLocation(node.expression);
        if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
        const app = checker.getApparentType(t);
        if (checker.getPropertyOfType(app, name) || checker.getIndexInfosOfType(app).length) return;
        candidates = checker.getPropertiesOfType(app).map((p) => p.name);
        if (!candidates.length) return;
      }
      reported.add(node.name.getStart(sf));
      const f = add({
        ...loc(node.name), severity: b.exact ? 'error' : 'warning', rule: 'unknown-member',
        message: `${b.display} has no "${name}" (used as ${b.local}.${name}).`,
        suggestions: suggest(name, candidates).map((n) => `${b.local}.${n}`),
      });
      if (b.whole && b.owner) historyJobs.push({ finding: f, owner: b.owner, spec: b.spec, name });
    };

    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const mod = checkModule(node.moduleSpecifier);
        const clause = node.importClause;
        if (mod && clause) {
          if (clause.name) { checkDefault(mod, clause.name); bind(clause.name, mod, true); }
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) bind(nb.name, mod, true);
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              checkNamed(mod, el.propertyName ?? el.name, el, clause.isTypeOnly || el.isTypeOnly);
              bind(el.name, mod, false);
            }
          }
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const mod = checkModule(node.moduleSpecifier);
        if (mod && node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) checkNamed(mod, el.propertyName ?? el.name, el, node.isTypeOnly || el.isTypeOnly);
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
        const mod = checkModule(node.moduleReference.expression);
        if (mod) bind(node.name, mod, true);
      } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamic) {
          const mod = checkModule(node.arguments[0]);
          const decl = node.parent;
          if (mod && isRequire && ts.isVariableDeclaration(decl) && decl.initializer === node) {
            if (ts.isObjectBindingPattern(decl.name)) {
              for (const el of decl.name.elements) {
                const key = el.propertyName ?? el.name;
                if (ts.isIdentifier(key)) checkNamed(mod, key, el, false);
              }
            } else if (ts.isIdentifier(decl.name)) bind(decl.name, mod, true);
          }
        }
      } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        accesses.set(node.name.getStart(sf), node);
        if (ts.isIdentifier(node.expression)) checkMember(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // ── Deep pass: chained calls on library types, e.g. z.string().emailAddress() ──
    // We let TypeScript find missing properties and keep only those on types a
    // *package's declaration files* define — your own types are your business.
    if (deep) {
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (!MISSING_PROPERTY.has(d.code) || d.start === undefined || reported.has(d.start)) continue;
        const node = accesses.get(d.start);
        if (!node) continue;
        const t = checker.getTypeAtLocation(node.expression);
        const owner = typeOwner(t);
        if (!owner) continue;
        // Plain JS doesn't narrow (`stmt.moduleSpecifier` on a Statement is fine at runtime).
        // There, only names the package never declares anywhere are reported.
        if (isJsFile(file) && ownerDeclares(owner, node.name.text)) continue;
        reported.add(d.start);
        const app = checker.getApparentType(t);
        const typeName = checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation).replace(/<.*>$/s, '<…>');
        add({
          ...loc(node.name), severity: 'error', rule: 'unknown-member',
          message: `"${node.name.text}" does not exist on ${typeName} (from ${owner.name}@${owner.version}).`,
          suggestions: suggest(node.name.text, checker.getPropertiesOfType(app).map((p) => p.name).filter((n) => !n.startsWith('_'))).map((n) => `.${n}`),
        });
      }
    }
  }

  function ownerDeclares(owner, name) {
    if (!declaredNames.has(owner.dir)) {
      const prefix = owner.dir.replace(/\\/g, '/').toLowerCase() + '/';
      declaredNames.set(owner.dir, program.getSourceFiles()
        .filter((s) => isDeclarationFile(s.fileName) && s.fileName.replace(/\\/g, '/').toLowerCase().startsWith(prefix))
        .map((s) => s.text).join('\n'));
    }
    const esc = name.replace(/[$]/g, '\\$');
    return new RegExp(`(^|[\\s{;,(])(readonly\\s+)?${esc}\\??\\s*[:(<]`, 'm').test(declaredNames.get(owner.dir));
  }

  function typeOwner(t) {
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return null;
    const sym = t.aliasSymbol || t.getSymbol();
    const decls = sym?.declarations || [];
    if (!decls.length) return null;
    for (const decl of decls) {
      const df = decl.getSourceFile().fileName;
      if (!isDeclarationFile(df) || !program.isSourceFileFromExternalLibrary(decl.getSourceFile())) return null;
    }
    // Merged with a project augmentation? Then the project may add members we can't see as "the library's".
    return ownerOf(decls[0].getSourceFile().fileName);
  }

  debug('files checked');
  // ── 4. Hints: was it valid in another major version? does it live in another package? ──
  if (!offline && hints) {
    await pool(historyJobs.slice(0, MAX_HISTORY_LOOKUPS), 4, async (job) => {
      const h = await findInHistory(job).catch(() => null);
      if (!h) return;
      const v = h.version.split('.')[0];
      const have = `${job.owner.name}@${job.owner.version}`;
      job.finding.hint = h.change === 'removed'
        ? `"${job.name}" was removed: it last existed in v${v} (${h.package}@${h.version}); you have ${have}.`
        : `"${job.name}" was added in v${v} (${h.package}@${h.version}); you have ${have}. Upgrade or use what your version offers.`;
    });
  }

  debug('history hints');
  if (elsewhereJobs.length && hints) {
    // Export lists of every declared dependency, from a second program that reuses the first one's files.
    const depExports = [];
    if (declaredDeps.length) {
      const p2 = ts.createProgram({ rootNames: [...rootNames, depsProbe], options, host, oldProgram: program });
      const c2 = p2.getTypeChecker();
      const sf2 = p2.getSourceFile(depsProbe);
      sf2?.statements.forEach((st, i) => {
        if (!ts.isImportDeclaration(st)) return;
        const n = moduleNames(c2, st.moduleSpecifier);
        if (n && !n.any) depExports.push({ name: declaredDeps[i], values: n.values });
      });
    }
    for (const job of elsewhereJobs) {
      if (job.finding.hint) continue;
      const fromName = job.from.kind === 'builtin' ? null : packageNameOf(job.from.spec);
      const inDeps = depExports.filter((d) => d.name !== fromName && d.values.has(job.name)).map((d) => d.name);
      if (inDeps.length) {
        job.finding.hint = `"${job.name}" is exported by ${inDeps.slice(0, 3).join(', ')} (already in your package.json).`;
        continue;
      }
      if (job.from.kind === 'builtin') {
        const homes = [];
        for (const b of COMMON_BUILTINS) {
          if (`node:${b}` === job.from.spec || b === job.from.spec) continue;
          const names = await loadBuiltin(b);
          if (names?.has(job.name)) homes.push(`node:${b}`);
        }
        if (homes.length) job.finding.hint = `"${job.name}" is exported by ${homes.slice(0, 3).join(', ')}.`;
        else if (/Json|Sync$|copy|move|ensure|remove|outputFile|pathExists|emptyDir/i.test(job.name) && /fs/.test(job.from.spec)) {
          job.finding.hint = `"${job.name}" looks like fs-extra, not Node's fs.`;
        }
      }
    }
  }

  debug('elsewhere hints');
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || order[a.severity] - order[b.severity]);
  return { files: files.length, imports: importCount, packages: uses.size, findings };
}

// ── helpers ──

export async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function isJsFile(file) {
  return /\.[cm]?jsx?$/.test(file);
}

function fmt(n) {
  return n === null || n === undefined ? 'unknown' : n.toLocaleString('en-US');
}

function existsAny(target) {
  if (existsSync(target)) return true;
  const noJs = target.replace(/\.[cm]?jsx?$/, '');
  return RESOLVE_EXT.some((e) => existsSync(target + e) || existsSync(noJs + e) || existsSync(join(target, 'index' + e)));
}

function siblingSuggestions(target) {
  const dir = dirname(target);
  const want = basename(target).replace(/\.[^.]+$/, '');
  try {
    const entries = readdirSync(dir).filter((e) => !e.startsWith('.'));
    const byStem = new Map(entries.map((e) => [e.replace(/\.[^.]+$/, ''), e]));
    return suggest(want, [...byStem.keys()]).map((s) => `./${byStem.get(s)}`);
  } catch {
    return [];
  }
}


/**
 * Entry points a package offers near `wanted`: "exports" keys, or the files in
 * the folder the wanted subpath points into (e.g. "plugin/" for "plugin/relativeTimes").
 */
function subpathsOf(name, wanted, fromDir, fetchedRoot) {
  const dir = findInstalled(name, fromDir) || (fetchedRoot && join(fetchedRoot, 'node_modules', ...name.split('/')));
  if (!dir) return [];
  const out = new Set();
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
      for (const k of Object.keys(pkg.exports)) if (k.startsWith('./') && k !== './package.json' && !k.includes('*')) out.add(k.slice(2));
    }
    if (!out.size) {
      const parent = wanted.includes('/') ? wanted.slice(0, wanted.lastIndexOf('/')) : '';
      for (const sub of new Set([parent, ''])) {
        let entries;
        try { entries = readdirSync(join(dir, sub)); } catch { continue; }
        for (const e of entries) {
          if (e === 'node_modules' || e.startsWith('.') || e === 'package.json') continue;
          out.add((sub ? `${sub}/` : '') + e.replace(/(\.d)?\.[cm]?[jt]s$/, ''));
        }
      }
    }
  } catch { /* ignore */ }
  return [...out];
}
