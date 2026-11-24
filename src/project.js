import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

export const SOURCE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', 'out', '.turbo', '.vercel', '.svelte-kit']);

export function isSourceFile(file) {
  return SOURCE_EXT.has(extname(file)) && !/\.d\.[cm]?ts$/.test(file);
}

/** Expand files and folders into a list of source files. */
export function collectFiles(targets) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
        walk(join(p, e));
      }
    } else if (isSourceFile(p)) out.push(resolve(p));
  };
  for (const t of targets) walk(t);
  return [...new Set(out)];
}

/** Changed + untracked source files in the git repo at cwd. */
export function changedFiles(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  const top = git(['rev-parse', '--show-toplevel'])[0];
  const files = [
    ...git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ];
  return [...new Set(files)].map((f) => resolve(top, f)).filter((f) => isSourceFile(f) && existsSync(f));
}

/** Nearest folder with a package.json, walking up from `start`. */
export function findRoot(start) {
  let dir = resolve(start);
  try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { dir = dirname(dir); }
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
    if (dirname(d) === d) return dir;
  }
}

export function loadProject(root) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  const deps = new Map();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [n, range] of Object.entries(pkg[field] || {})) if (!deps.has(n)) deps.set(n, range);
  }

  // tsconfig/jsconfig: we borrow what affects module resolution and which
  // declaration files (augmentations, `declare module '*.svg'`) are in play.
  let compilerOptions = {};
  let declarationFiles = [];
  const cfgFile = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') || ts.findConfigFile(root, ts.sys.fileExists, 'jsconfig.json');
  if (cfgFile && relative(root, cfgFile).split(/[\\/]/).every((s) => s !== '..')) {
    const read = ts.readConfigFile(cfgFile, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(cfgFile));
      const o = parsed.options;
      compilerOptions = { baseUrl: o.baseUrl, paths: o.paths, rootDirs: o.rootDirs, customConditions: o.customConditions, types: o.types, typeRoots: o.typeRoots };
      declarationFiles = parsed.fileNames.filter((f) => /\.d\.[cm]?ts$/.test(f));
    }
  }
  if (!cfgFile) declarationFiles = collectDeclarations([root]);
  return {
    root,
    name: pkg.name || null,
    deps,
    compilerOptions,
    declarationFiles: declarationFiles.map((f) => resolve(f)),
    aliasPatterns: Object.keys(compilerOptions.paths || {}),
  };
}

/** Project .d.ts files (never inside node_modules). */
export function collectDeclarations(targets) {
  const out = [];
  const walk = (p, depth) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 8) return;
      for (const e of readdirSync(p)) {
        if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
        walk(join(p, e), depth + 1);
      }
    } else if (/\.d\.[cm]?ts$/.test(p)) out.push(resolve(p));
  };
  for (const t of targets) walk(t, 0);
  return out;
}

/** Where a package is installed, looking up node_modules from `fromDir` to the filesystem root. */
export function findInstalled(name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    const p = join(d, 'node_modules', ...name.split('/'));
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(d) === d) return null;
  }
}
