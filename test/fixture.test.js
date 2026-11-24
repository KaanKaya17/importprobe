import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.js';
import { collectFiles, loadProject } from '../src/project.js';

const app = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ai-app');
const installed = existsSync(join(app, 'node_modules', 'axios'));
const skip = installed ? false : 'run `npm run demo:setup` first';

const summarize = (findings) =>
  findings.filter((f) => f.severity !== 'info').map((f) => `${basename(f.file)}:${f.line} ${f.rule}`).sort();

test('finds every planted mistake without the network', { skip }, async () => {
  const result = await analyze({ files: collectFiles([app]), project: loadProject(app), offline: true });
  const got = summarize(result.findings);
  for (const want of [
    'api.ts:4 undeclared-dependency',
    'api.ts:7 unknown-member',
    'dates.ts:2 unknown-export',
    'dates.ts:3 unknown-subpath',
    'files.js:1 unknown-export',
    'files.js:2 unknown-builtin',
    'files.js:3 unknown-export',
    'files.js:4 no-default-export',
    'files.js:5 missing-file',
  ]) assert.ok(got.includes(want), `missing ${want}\n got: ${got.join('\n      ')}`);
  assert.ok(!got.some((g) => g.startsWith('clean.ts')), 'clean.ts must have no findings');
});

test('checks the registry for packages that are not installed', { skip: skip || (process.env.IMPORTPROBE_NO_NETWORK && 'network disabled') }, async () => {
  const result = await analyze({ files: collectFiles([app]), project: loadProject(app) });
  const got = summarize(result.findings);
  assert.ok(got.includes('api.ts:3 unknown-package'), got.join('\n'));
  assert.ok(got.includes('ids.ts:2 missing-dependency'), got.join('\n'));
  assert.ok(got.includes('ids.ts:2 unknown-export'), 'nanoId should be checked against the downloaded nanoid types');
  const fake = result.findings.find((f) => f.rule === 'unknown-package');
  assert.equal(fake.suggestions[0], 'axios-retry (deprecated)', 'the closest real name comes first, marked when deprecated');
});
