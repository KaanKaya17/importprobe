// CI smoke test of the PUBLISHED package: npm pack → install the tarball into an empty
// folder (exactly what `npx importprobe` does) → run the installed binary.
// Usage: node test/package-smoke.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';
const npm = (args, cwd) => execFileSync(isWin ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: isWin });
const work = mkdtempSync(join(tmpdir(), 'importprobe-pkg-'));
let failed = false;
const fail = (m) => {
  console.error(`✖ ${m}`);
  failed = true;
  throw new Error(m);
};

try {
  const tgz = npm(['pack', '--silent', '--pack-destination', work], root).trim().split('\n').pop();
  console.log(`packed ${tgz}`);
  const app = join(work, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"smoke-app","private":true,"type":"module"}');
  npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', join(work, tgz)], app);

  const binDir = join(app, 'node_modules', '.bin');
  const bin = join(binDir, isWin ? 'importprobe.cmd' : 'importprobe');
  if (!existsSync(bin)) fail(`binary not installed at ${bin} (found: ${readdirSync(binDir).join(', ')})`);
  const run = (args, input) =>
    new Promise((resolve) => {
      const p = spawn(bin, args, { cwd: app, shell: isWin, env: { ...process.env, NO_COLOR: '1' } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => resolve({ code, out, err }));
      p.stdin.end(input ?? '');
    });

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ver = await run(['--version']);
  if (ver.out.trim() !== pkg.version) fail(`--version printed "${ver.out.trim()}", expected ${pkg.version}`);
  console.log(`✔ --version ${pkg.version}`);

  writeFileSync(join(app, 'src', 'util.js'), 'export const formatDateTime = (d) => d.toISOString();\n');
  writeFileSync(join(app, 'src', 'app.js'), [
    "import { readJsonSync } from 'node:fs';",
    "import { formatDate } from './util.js';",
    "import { log } from './missing.js';",
    'log(readJsonSync, formatDate);',
    '',
  ].join('\n'));
  const scan = await run(['--offline', '--json', 'src']);
  if (scan.code !== 1) fail(`scan exited ${scan.code}: ${scan.err.slice(-500)}`);
  const rules = JSON.parse(scan.out).findings.map((f) => f.rule).sort();
  for (const want of ['missing-file', 'unknown-export']) if (!rules.includes(want)) fail(`expected ${want}, got ${rules.join(', ')}`);
  console.log(`✔ scan via installed binary: ${rules.join(', ')}`);

  const hook = await run(['hook', '--offline'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(app, 'src', 'app.js') } }));
  if (hook.code !== 2 || !hook.err.includes('formatDateTime')) fail(`hook exited ${hook.code}: ${hook.err}`);
  console.log('✔ Claude Code hook gives feedback');

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } };
  const mcp = await run(['mcp'], JSON.stringify(init) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const tools = mcp.out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
  if (!tools.includes('list_exports')) fail(`MCP tools/list returned ${JSON.stringify(tools)}: ${mcp.err}`);
  console.log(`✔ MCP server: ${tools.join(', ')}`);
} catch (e) {
  if (!failed) console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true }); // never leave temp folders behind
}
