import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'importprobe.js');
const aiApp = join(here, 'fixtures', 'ai-app');
const skip = existsSync(join(aiApp, 'node_modules', 'axios')) ? false : 'run `npm run demo:setup` first';

function run(args, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
}

test('exit codes and JSON output', { skip }, async () => {
  const bad = await run(['--offline', '--json', join(aiApp, 'src', 'dates.ts')]);
  assert.equal(bad.code, 1);
  const j = JSON.parse(bad.out);
  assert.equal(j.summary.errors, 2);
  const clean = await run(['--offline', join(aiApp, 'src', 'clean.ts')]);
  assert.equal(clean.code, 0);
  assert.match(clean.out, /Every import points at something that exists/);
});

test('SARIF output', { skip }, async () => {
  const r = await run(['--offline', '--sarif', join(aiApp, 'src', 'dates.ts')]);
  const s = JSON.parse(r.out);
  assert.equal(s.version, '2.1.0');
  assert.equal(s.runs[0].results.length, 2);
  assert.equal(s.runs[0].results[0].locations[0].physicalLocation.region.startLine, 2);
});

test('GitHub annotations and SARIF file in one run', { skip }, async () => {
  const sarif = join(here, '..', 'node_modules', '.importprobe-test.sarif');
  const r = await run(['--offline', '--github', '--sarif-file', sarif, join(aiApp, 'src', 'dates.ts')]);
  assert.equal(r.code, 1);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^::error file=.*dates\.ts,line=2,col=10,title=importprobe%3A unknown-export::/);
  assert.match(lines.at(-1), /2 error\(s\), 0 warning\(s\)/);
  const { readFileSync, rmSync } = await import('node:fs');
  assert.equal(JSON.parse(readFileSync(sarif, 'utf8')).runs[0].results.length, 2);
  rmSync(sarif, { force: true });
});

test('Claude Code hook: exit 2 with feedback on bad files, silent on good ones', { skip }, async () => {
  const bad = await run(['hook', '--offline'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(aiApp, 'src', 'files.js') } }));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /readJsonSync/);
  assert.match(bad.err, /formatDateTime/);
  const good = await run(['hook', '--offline'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(aiApp, 'src', 'clean.ts') } }));
  assert.equal(good.code, 0);
  assert.equal(good.err, '');
  const other = await run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'README.md' } }));
  assert.equal(other.code, 0);
});

test('MCP server answers initialize, tools/list and list_exports', { skip }, async () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_exports', arguments: { module: 'dayjs', project_dir: aiApp } } },
    { jsonrpc: '2.0', id: 4, method: 'nope' },
  ];
  const r = await run(['mcp'], msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const out = Object.fromEntries(r.out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(out[1].result.serverInfo.name, 'importprobe');
  assert.deepEqual(out[2].result.tools.map((t) => t.name), ['list_exports', 'check_package', 'check_files']);
  const ex = out[3].result.structuredContent;
  assert.match(ex.source, /dayjs@.*installed/);
  assert.ok(ex.values.some((v) => v.name === 'extend'));
  assert.equal(out[4].error.code, -32601);
});
