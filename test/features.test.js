import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { typoVariants } from '../src/registry.js';
import { extractScripts } from '../src/sfc.js';
import { analyze } from '../src/analyze.js';
import { collectFiles, loadProject } from '../src/project.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'importprobe.js');
const temps = [];
const tempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); }); // never leave temp folders behind
const noNet = process.env.IMPORTPROBE_NO_NETWORK ? 'network disabled' : false;

test('typo variants cover doubled letters, swaps and separators', () => {
  assert.ok(typoVariants('expresss').includes('express'));
  assert.ok(typoVariants('loadsh').includes('lodash'));
  assert.ok(typoVariants('reactdom').includes('react-dom'));
  assert.ok(typoVariants('react_dom').includes('react-dom'));
  assert.ok(typoVariants('@scope/fooo').includes('@scope/foo'));
});

test('SFC scripts keep exact positions; non-JS scripts are ignored', () => {
  const vue = '<template>\n  <p/>\n</template>\n<script setup lang="ts">\nimport { a } from "x";\n</script>\n<script type="application/ld+json">{"b":1}</script>\n';
  const { code, lang } = extractScripts('C.vue', vue);
  assert.equal(lang, 'ts');
  assert.equal(code.length, vue.length);
  assert.equal(code.split('\n')[4], 'import { a } from "x";');
  assert.ok(!code.includes('ld+json') && !code.includes('"b":1'));
  const astro = '---\nimport b from "y";\n---\n<div/>\n<script>\nimport c from "z";\n</script>\n';
  const a = extractScripts('P.astro', astro);
  assert.equal(a.code.split('\n')[1], 'import b from "y";');
  assert.equal(a.code.split('\n')[5], 'import c from "z";');
  assert.ok(!a.code.includes('<div/>'));
});

test('built-in index explains names from popular packages (offline)', async () => {
  const dir = tempDir('importprobe-idx-');
  writeFileSync(join(dir, 'package.json'), '{"name":"t","private":true,"type":"module"}');
  writeFileSync(join(dir, 'a.js'), "import { readJsonSync, promisify } from 'node:fs';\nexport default [readJsonSync, promisify];\n");
  const r = await analyze({ files: collectFiles([dir]), project: loadProject(dir), offline: true });
  const hint = (n) => r.findings.find((f) => f.message.includes(`"${n}"`))?.hint || '';
  assert.match(hint('readJsonSync'), /fs-extra/);
  assert.match(hint('promisify'), /node:util/);
});

test('init merges into existing config, is idempotent, and leaves commented files alone', () => {
  const dir = tempDir('importprobe-init-');
  mkdirSync(join(dir, '.claude'));
  mkdirSync(join(dir, '.vscode'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const commented = '{\n  // mine\n  "servers": {}\n}\n';
  writeFileSync(join(dir, '.vscode', 'mcp.json'), commented);
  const run = (...a) => spawnSync(process.execPath, [bin, 'init', ...a], { cwd: dir, encoding: 'utf8' });

  const dry = run('--dry-run');
  assert.match(dry.stdout, /would add/);
  assert.ok(!existsSync(join(dir, '.mcp.json')), 'dry run writes nothing');

  const first = run();
  assert.equal(first.status, 1, 'the commented VS Code file is reported, not rewritten');
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
  assert.equal(settings.hooks.PostToolUse.length, 2);
  assert.match(JSON.stringify(settings.hooks.PostToolUse[1]), /importprobe hook/);
  assert.ok(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers.importprobe);
  assert.equal(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf8'), commented);

  run('claude');
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse.length, 2, 'running twice adds nothing');
});

test('cache: info, prune to the limit (least recently used first), clean', () => {
  const cache = tempDir('importprobe-cache-');
  const env = { ...process.env, IMPORTPROBE_CACHE: cache };
  const pkg = (name, kb, ageDays) => {
    const d = join(cache, 'pkgs', name, 'node_modules', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'index.d.ts'), 'x'.repeat(kb * 1024));
    const marker = join(d, '.importprobe-complete');
    writeFileSync(marker, '');
    const t = new Date(Date.now() - ageDays * 864e5);
    utimesSync(marker, t, t);
  };
  pkg('old', 600, 3);
  pkg('mid', 600, 2);
  pkg('new', 600, 1);
  const run = (...a) => spawnSync(process.execPath, [bin, 'cache', ...a], { encoding: 'utf8', env: { ...env, IMPORTPROBE_CACHE_MAX_MB: '1.5' } });
  assert.match(run('info').stdout, /3 downloaded package/);
  run('prune');
  assert.ok(!existsSync(join(cache, 'pkgs', 'old')), 'least recently used goes first');
  assert.ok(existsSync(join(cache, 'pkgs', 'new')), 'recently used stays');
  run('clean');
  assert.ok(!existsSync(join(cache, 'pkgs')));
  assert.ok(existsSync(cache), 'clean removes importprobe\'s folders, not the cache dir itself');
});

test('typosquats and deprecated packages are reported', { skip: noNet }, async () => {
  const dir = tempDir('importprobe-net-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', private: true, type: 'module', dependencies: { request: '^2.88.2' } }));
  writeFileSync(join(dir, 'a.js'), "import c from 'expresss';\nimport r from 'request';\nimport x from 'axios-retry-pro';\nexport default [c, r, x];\n");
  const r = await analyze({ files: collectFiles([dir]), project: loadProject(dir), hints: false });
  const at = (line) => r.findings.filter((f) => f.line === line);
  assert.ok(at(1).some((f) => f.rule === 'suspicious-package' && f.suggestions.includes('express')), 'expresss → express');
  assert.ok(at(2).some((f) => f.rule === 'deprecated-package'), 'request is deprecated');
  const fake = at(3).find((f) => f.rule === 'unknown-package');
  assert.ok(fake.suggestions.length, 'has suggestions');
  assert.ok(!fake.suggestions.some((s) => /^(axios-pro|retry-pro)$/.test(s)), 'barely used names are never suggested');
});
