import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/specifier.js';
import { suggest, distance } from '../src/suggest.js';
import { pickVersion, typesPackageName } from '../src/registry.js';
import { readTar } from '../src/tarball.js';

test('classify specifiers', () => {
  assert.equal(classify('node:fs').kind, 'builtin');
  assert.equal(classify('fs/promises').kind, 'builtin');
  assert.equal(classify('./a.js').kind, 'relative');
  assert.equal(classify('../a').kind, 'relative');
  assert.deepEqual(classify('@scope/pkg/sub/path'), { kind: 'package', spec: '@scope/pkg/sub/path', name: '@scope/pkg', subpath: 'sub/path', asset: false });
  assert.equal(classify('lodash/get').name, 'lodash');
  assert.equal(classify('@/components/x').kind, 'alias');
  assert.equal(classify('~/lib').kind, 'alias');
  assert.equal(classify('#internal').kind, 'alias');
  assert.equal(classify('virtual:pwa').kind, 'other');
  assert.equal(classify('src/x', ['src/*']).kind, 'alias');
  assert.equal(classify('bootstrap/dist/css/bootstrap.css').asset, true);
});

test('suggest finds close names and exact case matches', () => {
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.deepEqual(suggest('formatDate', ['formatDateTime', 'slugify']), ['formatDateTime']);
  assert.deepEqual(suggest('nanoId', ['nanoid', 'customAlphabet']), ['nanoid']);
  assert.deepEqual(suggest('config', ['config']), ['config']);
  assert.deepEqual(suggest('zzz', ['alpha', 'beta']), []);
});

test('pickVersion follows ranges', () => {
  const pkg = { distTags: { latest: '2.1.0', next: '3.0.0-beta.1' }, versions: Object.fromEntries(['1.0.0', '1.4.2', '1.10.0', '2.0.0', '2.1.0', '3.0.0-beta.1'].map((v) => [v, {}])) };
  assert.equal(pickVersion(pkg, '^1.0.0'), '1.10.0');
  assert.equal(pickVersion(pkg, '~1.4.0'), '1.4.2');
  assert.equal(pickVersion(pkg, '1.4.2'), '1.4.2');
  assert.equal(pickVersion(pkg, undefined), '2.1.0');
  assert.equal(pickVersion(pkg, 'next'), '3.0.0-beta.1');
  assert.equal(pickVersion(pkg, '>=2'), '2.1.0');
});

test('@types names', () => {
  assert.equal(typesPackageName('lodash'), '@types/lodash');
  assert.equal(typesPackageName('@babel/core'), '@types/babel__core');
});

function tarEntry(path, content, type = '0') {
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(path, 0, 100);
  h.write('0000644\0', 100);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

test('readTar reads ustar entries and pax long paths', () => {
  const longPath = 'package/' + 'a/'.repeat(60) + 'index.d.ts';
  const pax = `${30 + longPath.length} path=${longPath}\n`;
  const fixLen = (s) => { const body = s.replace(/^\d+ /, ''); let n = body.length + 3; while (`${n} ${body}`.length !== n) n++; return `${n} ${body}`; };
  const tar = Buffer.concat([
    tarEntry('package/package.json', '{"name":"x"}'),
    tarEntry('PaxHeader', fixLen(pax), 'x'),
    tarEntry('package/ignored-short-name', 'export {}'),
    Buffer.alloc(1024),
  ]);
  const entries = [...readTar(tar)];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'package/package.json');
  assert.equal(entries[0].data.toString(), '{"name":"x"}');
  assert.equal(entries[1].path, longPath);
});
