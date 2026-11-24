import { parseArgs } from 'node:util';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.js';
import { collectFiles, changedFiles, findRoot, loadProject, isSourceFile } from './project.js';
import { formatPretty, formatJson, formatForAgent, formatSarif, formatGithub } from './report.js';
import { cacheDir, cacheInfo, cleanCache, pruneCache } from './cache.js';

const VERSION = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;

const HELP = `importprobe ${VERSION}
Catch imports an AI made up: packages that don't exist, exports and methods
a package never had, and dependencies missing from package.json.

Usage
  importprobe [files or folders...]     check files (default: current folder)
  importprobe --changed                 check files changed in git
  importprobe hook                      run as a Claude Code PostToolUse hook (reads stdin)
  importprobe mcp                       run as an MCP server (list_exports, check_package, check_files)
  importprobe init [claude|cursor|vscode]  set up the hook and/or MCP server for your editor/agent
  importprobe cache [info|prune|clean]  show or clear the download cache

Options
  --json          machine-readable output
  --sarif         SARIF 2.1.0 for GitHub code scanning
  --sarif-file F  also write SARIF to file F
  --github        GitHub Actions annotations (+ job summary)
  --fast          skip chained-call checks and version/package hints
  --offline       never contact the npm registry
  --strict        exit 1 on warnings too
  --verbose       also show info messages
  -h, --help      show this help
  -v, --version   show version

Exit codes: 0 clean, 1 problems found, 2 usage or internal error.
`;

export async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        sarif: { type: 'boolean' },
        'sarif-file': { type: 'string' },
        github: { type: 'boolean' },
        fast: { type: 'boolean' },
        offline: { type: 'boolean' },
        strict: { type: 'boolean' },
        verbose: { type: 'boolean' },
        changed: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals } = args;
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (positionals[0] === 'hook') return runHook(o);
  if (positionals[0] === 'mcp') return (await import('./mcp.js')).runMcp(VERSION);
  if (positionals[0] === 'cache') return runCache(positionals[1]);
  if (positionals[0] === 'init') return (await import('./init.js')).runInit(positionals.slice(1), o);

  const cwd = process.cwd();
  let files;
  if (o.changed) {
    try { files = changedFiles(cwd); } catch { process.stderr.write('--changed needs a git repository.\n'); return 2; }
  } else {
    const targets = positionals.length ? positionals : ['.'];
    for (const t of targets) if (!existsSync(t)) { process.stderr.write(`Not found: ${t}\n`); return 2; }
    files = collectFiles(targets);
  }
  if (!files.length) {
    process.stdout.write(o.json ? formatJson({ files: 0, imports: 0, packages: 0, findings: [] }, { version: VERSION }) + '\n' : 'No JavaScript or TypeScript files to check.\n');
    return 0;
  }

  const result = await analyzeByProject(files, { offline: o.offline, deep: !o.fast, hints: !o.fast });
  let out;
  if (o.github) {
    const gh = formatGithub(result, { cwd, version: VERSION });
    out = gh.text;
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, gh.summary + '\n'); } catch { /* not in Actions */ }
    }
  } else if (o.sarif) out = formatSarif(result, { cwd, version: VERSION });
  else if (o.json) out = formatJson(result, { cwd, version: VERSION });
  else out = formatPretty(result, { cwd, verbose: o.verbose, version: VERSION });
  process.stdout.write(out + '\n');
  if (o['sarif-file']) writeFileSync(o['sarif-file'], formatSarif(result, { cwd, version: VERSION }) + '\n');
  try { pruneCache(); } catch { /* never fail a check because of the cache */ }
  const errors = result.findings.some((f) => f.severity === 'error');
  const warnings = result.findings.some((f) => f.severity === 'warning');
  return errors || (o.strict && warnings) ? 1 : 0;
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function runCache(sub = 'info') {
  if (sub === 'clean') {
    process.stdout.write(`Removed ${mb(cleanCache())} from ${cacheDir()}\n`);
    return 0;
  }
  if (sub === 'prune') {
    process.stdout.write(`Freed ${mb(pruneCache({ force: true }))}\n`);
    return 0;
  }
  if (sub !== 'info') {
    process.stderr.write('Usage: importprobe cache [info|prune|clean]\n');
    return 2;
  }
  const i = cacheInfo();
  process.stdout.write(`${i.dir}\n${mb(i.bytes)} in ${i.packages} downloaded package version(s) and ${i.entries - i.packages} registry answer(s); limit ${mb(i.limitBytes)} (IMPORTPROBE_CACHE_MAX_MB)\n`);
  return 0;
}

/**
 * Each file is judged against its own nearest package.json, so monorepos and
 * several projects in one run get the right dependency lists.
 */
export async function analyzeByProject(files, opts) {
  const groups = new Map();
  for (const f of files) {
    const root = findRoot(f);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  const merged = { files: 0, imports: 0, packages: 0, findings: [] };
  for (const [root, group] of groups) {
    const r = await analyze({ files: group, project: loadProject(root), ...opts });
    merged.files += r.files;
    merged.imports += r.imports;
    merged.packages += r.packages;
    merged.findings.push(...r.findings);
  }
  return merged;
}

/**
 * Claude Code PostToolUse hook. Reads the hook event from stdin, checks the
 * file that was just written, and exits 2 with feedback on stderr so the agent
 * fixes its own imports. Never blocks on its own failures.
 */
async function runHook(o) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const file = input.tool_input?.file_path || input.tool_input?.path;
    if (!file || !isSourceFile(file) || !existsSync(file)) return 0;
    const abs = resolve(input.cwd || process.cwd(), file);
    const project = loadProject(findRoot(abs));
    const result = await analyze({ files: [abs], project, offline: o.offline });
    const real = result.findings.filter((f) => f.severity === 'error' || (o.strict && f.severity === 'warning'));
    if (!real.length) return 0;
    process.stderr.write(formatForAgent({ ...result, findings: real }, { cwd: project.root }) + '\n');
    return 2;
  } catch (e) {
    process.stderr.write(`importprobe hook skipped: ${e.message}\n`);
    return 0;
  }
}
