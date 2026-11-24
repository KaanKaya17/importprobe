import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.js';
import { collectFiles, loadProject } from '../src/project.js';

const app = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-app');
const skip = existsSync(join(app, 'node_modules', 'react-router-dom')) ? false : 'run `npm run demo:setup` first';
const noNet = process.env.IMPORTPROBE_NO_NETWORK ? 'network disabled' : false;
const project = () => loadProject(app);

test('no false positives on correct real-world code', { skip }, async () => {
  const files = collectFiles([join(app, 'src', 'good'), join(app, 'src', 'components'), join(app, 'src', 'types.ts')]);
  const result = await analyze({ files, project: project(), offline: true });
  const shown = result.findings.filter((f) => f.severity !== 'info');
  assert.deepEqual(shown.map((f) => `${basename(f.file)}:${f.line} ${f.rule} ${f.message}`), []);
});

test('catches direct and chained API inventions', { skip }, async () => {
  const result = await analyze({ files: collectFiles([join(app, 'src', 'bad')]), project: project(), offline: true });
  const at = (line) => result.findings.filter((f) => f.line === line).map((f) => f.rule);
  assert.ok(at(2).includes('unknown-export'), 'useQueryParams / useHistory');
  assert.ok(at(3).includes('unknown-export'), 'render from react-dom 19');
  assert.ok(at(4).includes('unknown-export'), 'formatRelativeTime');
  for (const line of [12, 13, 14]) assert.ok(at(line).includes('unknown-member'), `direct member on line ${line}`);
  for (const line of [16, 18, 19]) assert.ok(at(line).includes('unknown-member'), `chained call on line ${line}`);

  const s = (name) => result.findings.find((f) => f.message.includes(`"${name}"`))?.suggestions || [];
  assert.ok(s('useQueryParams').includes('useSearchParams'));
  assert.equal(s('formatRelativeTime')[0], 'formatRelative');
  assert.ok(!s('formatRelativeTime').some((n) => /^[A-Z]/.test(n)), 'type-only exports must not be suggested for value imports');
  assert.ok(s('emailAddress').includes('.email'));
  assert.ok(s('listenAsync').includes('.listen'));
  assert.ok(s('parseArgsAsync').includes('.parseAsync'));
});

test('chained inventions in plain JS are caught; JS-style narrowing is not reported', { skip }, async () => {
  const bad = await analyze({ files: collectFiles([join(app, 'src', 'bad-js')]), project: project(), offline: true });
  assert.deepEqual(bad.findings.filter((f) => f.severity === 'error').map((f) => `${f.line} ${f.rule}`), ['4 unknown-member', '6 unknown-member']);

  // `sf.statements[0].moduleSpecifier`: fine at runtime, typed on a subtype only (uses importprobe's own typescript)
  const narrowing = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'js-narrowing');
  const ok = await analyze({ files: collectFiles([narrowing]), project: loadProject(join(narrowing, '..', '..', '..')), offline: true });
  assert.deepEqual(ok.findings, []);
});

test('Vue, Svelte and Astro: correct components are clean, mistakes are found at exact positions', { skip }, async () => {
  const good = await analyze({ files: collectFiles([join(app, 'src', 'sfc-good')]), project: project(), offline: true });
  assert.deepEqual(good.findings, []);
  const bad = await analyze({ files: collectFiles([join(app, 'src', 'sfc-bad')]), project: project(), offline: true });
  assert.deepEqual(bad.findings.map((f) => `${basename(f.file)}:${f.line}:${f.column} ${f.rule}`).sort(), [
    'Bad.svelte:2:12 unknown-export',
    'Bad.svelte:4:28 unknown-member',
    'Page.astro:10:18 unknown-export',
    'Page.astro:5:3 unknown-member',
  ]);
});

test('fast mode skips chained checks', { skip }, async () => {
  const result = await analyze({ files: collectFiles([join(app, 'src', 'bad')]), project: project(), offline: true, deep: false, hints: false });
  assert.ok(!result.findings.some((f) => f.line === 16), 'z.string().emailAddress() is a deep check');
});

test('explains removed APIs and names that live in another dependency', { skip: skip || noNet }, async () => {
  const result = await analyze({ files: collectFiles([join(app, 'src', 'bad')]), project: project() });
  const hint = (name) => result.findings.find((f) => f.message.includes(`"${name}"`))?.hint || '';
  assert.match(hint('useHistory'), /removed: it last existed in v5/);
  assert.match(hint('render'), /removed: it last existed in v18/);
  assert.match(hint('addDays'), /exported by date-fns/);
});
