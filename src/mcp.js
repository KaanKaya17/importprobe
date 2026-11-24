import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPackage, weeklyDownloads, similarPackages, pickVersion } from './registry.js';
import { describeModule } from './exports.js';
import { collectFiles } from './project.js';
import { formatForAgent } from './report.js';

const DAY = 24 * 60 * 60 * 1000;

const TOOLS = [
  {
    name: 'list_exports',
    description:
      'Show the REAL API of an npm package or Node.js built-in: every export with its type signature, or the members of one export ' +
      '(methods, call signatures, what a call returns, instance members of a class). Use this before writing code against a ' +
      'library you are not 100% sure about, instead of guessing names. Uses the version installed in the project, or a given version from npm.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Import specifier, e.g. "zod", "date-fns", "react-dom/client", "node:fs".' },
        export: { type: 'string', description: 'Optional: one export to expand, e.g. "z" or "default" or "formatRelative".' },
        version: { type: 'string', description: 'Optional version or range to inspect from npm instead of the installed one, e.g. "18" or "^5.3.0".' },
        project_dir: { type: 'string', description: 'Optional project folder whose installed version should be used (default: current directory).' },
      },
      required: ['module'],
    },
  },
  {
    name: 'check_package',
    description:
      'Before adding or installing an npm package, check that it really exists, is not brand new or barely used (a sign of ' +
      'slopsquatting: attackers registering names that AIs invent), and is not deprecated. Returns similar real packages when the name does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Package name, e.g. "axios-retry".' },
        version: { type: 'string', description: 'Optional version or range.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'check_files',
    description:
      'Check source files for imports and API calls that do not exist: unknown packages, missing exports, invented methods ' +
      '(including chained calls like z.string().emailAddress()), missing files and undeclared dependencies. Run it on files you just wrote.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders to check.' },
      },
      required: ['paths'],
    },
  },
];

async function checkPackage({ name, version }) {
  const pkg = await getPackage(name);
  if (!pkg || pkg.unpublished || !Object.keys(pkg.versions).length) {
    return { name, exists: false, verdict: 'does-not-exist', advice: 'Do not install. This name is not a real package (or was unpublished).', similar: await similarPackages(name).catch(() => []) };
  }
  const v = pickVersion(pkg, version);
  const downloads = await weeklyDownloads(name);
  const ageDays = pkg.created ? Math.round((Date.now() - Date.parse(pkg.created)) / DAY) : null;
  const deprecated = pkg.versions[v]?.deprecated || null;
  let verdict = 'ok';
  let advice = 'Looks like an established package.';
  if ((ageDays !== null && ageDays < 30) || (downloads !== null && downloads < 100)) {
    verdict = 'suspicious';
    advice = 'Very new or barely used. Confirm this is the package you meant (check its repository and publisher) before installing.';
  } else if (deprecated) {
    verdict = 'deprecated';
    advice = `Deprecated: ${deprecated}`;
  }
  return { name, exists: true, version: v, latest: pkg.distTags.latest, created: pkg.created, ageDays, weeklyDownloads: downloads, deprecated, verdict, advice };
}

async function checkFiles({ paths }) {
  const { analyzeByProject } = await import('./cli.js');
  const targets = paths.map((p) => resolve(p)).filter((p) => existsSync(p));
  const files = collectFiles(targets);
  if (!files.length) return { text: 'No JavaScript or TypeScript files found at those paths.', errors: 0 };
  const result = await analyzeByProject(files, { offline: false, deep: true, hints: true });
  const real = result.findings.filter((f) => f.severity !== 'info');
  return {
    text: real.length ? formatForAgent({ ...result, findings: real }) : `All ${result.imports} imports in ${result.files} file(s) point at things that exist.`,
    errors: real.filter((f) => f.severity === 'error').length,
    warnings: real.filter((f) => f.severity === 'warning').length,
  };
}

async function callTool(name, args = {}) {
  if (name === 'list_exports') {
    return describeModule({ module: args.module, version: args.version, projectDir: args.project_dir, exportName: args.export });
  }
  if (name === 'check_package') return checkPackage(args);
  if (name === 'check_files') return checkFiles(args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
}

/** Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). */
export async function runMcp(version) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const handle = async (msg) => {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'importprobe', version },
          instructions: 'Use list_exports to look up a library\'s real API before using it, check_package before installing anything, and check_files after writing code.',
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        try {
          const out = await callTool(msg.params?.name, msg.params?.arguments);
          const text = typeof out.text === 'string' ? out.text : JSON.stringify(out, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: out, isError: false };
        } catch (e) {
          if (e.code === -32602) throw e;
          return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notification
    const p = handle(msg).then(
      (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
      (e) => send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
    );
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  await new Promise((r) => rl.on('close', r));
  await Promise.all(pending);
  return 0;
}
