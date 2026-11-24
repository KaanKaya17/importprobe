import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize, sep } from 'node:path';
import { cacheDir, touch } from './cache.js';

const MAX_TARBALL = 25 * 1024 * 1024;
const MAX_UNPACKED = 150 * 1024 * 1024;
// We only keep what the TypeScript checker needs to *read*. Nothing is ever run.
const KEEP = /(^|\/)package\.json$|\.d\.[cm]?ts$|\.[cm]?js$|\.json$/;

/**
 * Download a package tarball and unpack only declaration/JS/package.json files
 * into <cache>/pkgs/<name>@<version>/node_modules/<name>. Install scripts are
 * never executed: the files are parsed, not loaded.
 * @returns {string} the root folder that contains node_modules/
 */
export async function fetchPackageFiles(name, version, tarballUrl, root) {
  root ??= join(cacheDir(), 'pkgs', `${name.replace('/', '+')}@${version}`);
  const dest = join(root, 'node_modules', ...name.split('/'));
  const marker = join(dest, '.importprobe-complete');
  if (existsSync(marker)) {
    touch(marker); // least-recently-used pruning keeps what is still in use
    return root;
  }

  const res = await fetch(tarballUrl);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL) throw new Error('tarball too large to inspect');
  const tar = gunzipSync(buf, { maxOutputLength: MAX_UNPACKED });

  for (const entry of readTar(tar)) {
    // npm tarballs put everything under one top folder (usually "package/").
    const rel = entry.path.replace(/^[^/]+\//, '');
    if (!rel || !KEEP.test(rel)) continue;
    const out = normalize(join(dest, rel));
    if (!out.startsWith(dest + sep)) continue; // path traversal guard
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, entry.data);
  }
  mkdirSync(dest, { recursive: true });
  writeFileSync(marker, '');
  return root;
}

/** Minimal ustar/pax reader: yields regular files. */
export function* readTar(tar) {
  let off = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = cstr(h, 0, 100);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8) || 0;
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = h[257] === 0x75 /* 'u'star */ ? cstr(h, 345, 155) : '';
    const start = off + 512;
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      const p = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (p) longName = p[1];
      continue;
    }
    if (type === 'L') {
      longName = cstr(data, 0, size);
      continue;
    }
    if (type === 'g') continue;
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === '0' || type === '7') yield { path: path.replace(/\\/g, '/'), data };
  }
}

function cstr(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? slice.length : nul);
}
