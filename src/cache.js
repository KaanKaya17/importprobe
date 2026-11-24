import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
// Everything importprobe ever writes lives in these sub-folders of the cache dir;
// `cache clean` only ever removes these, never the folder itself.
export const CACHE_KINDS = ['pkgs', 'packages', 'downloads', 'search', 'exports', 'deprecations', 'latest', 'lookalikes'];

/** One stable cache folder (never a fresh temp dir per run). */
export function cacheDir() {
  const base = process.env.IMPORTPROBE_CACHE
    || (process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, 'importprobe'))
    || (process.platform === 'win32' && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'importprobe', 'cache'))
    || join(homedir(), '.cache', 'importprobe');
  mkdirSync(base, { recursive: true });
  return base;
}

function keyPath(kind, key) {
  const dir = join(cacheDir(), kind);
  mkdirSync(dir, { recursive: true });
  return join(dir, createHash('sha1').update(key).digest('hex') + '.json');
}

export function readCache(kind, key, ttlMs) {
  const file = keyPath(kind, key);
  try {
    if (Date.now() - statSync(file).mtimeMs > ttlMs) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeCache(kind, key, value) {
  try {
    writeFileSync(keyPath(kind, key), JSON.stringify(value));
  } catch {
    /* cache is best-effort */
  }
}

/** Mark a cache entry as recently used (for least-recently-used pruning). */
export function touch(path) {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch { /* ignore */ }
}

function sizeOf(path) {
  let total = 0;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    for (const e of readdirSync(path, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) {
        try { total += statSync(join(e.parentPath ?? e.path, e.name)).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}

/** Every cache entry with its size and last use, oldest first. */
function entries() {
  const out = [];
  const base = cacheDir();
  for (const kind of CACHE_KINDS) {
    const dir = join(base, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let used;
      try {
        // extracted packages: the completion marker is touched on every use
        const marker = kind === 'pkgs' ? findMarker(path) : path;
        used = statSync(marker || path).mtimeMs;
      } catch { continue; }
      out.push({ kind, path, used, size: sizeOf(path) });
    }
  }
  return out.sort((a, b) => a.used - b.used);
}

function findMarker(pkgRoot) {
  try {
    for (const e of readdirSync(pkgRoot, { withFileTypes: true, recursive: true })) {
      if (e.name === '.importprobe-complete') return join(e.parentPath ?? e.path, e.name);
    }
  } catch { /* ignore */ }
  return null;
}

export function cacheInfo() {
  const all = entries();
  return {
    dir: cacheDir(),
    bytes: all.reduce((s, e) => s + e.size, 0),
    packages: all.filter((e) => e.kind === 'pkgs').length,
    entries: all.length,
    limitBytes: cacheLimit(),
  };
}

export function cacheLimit() {
  const mb = Number(process.env.IMPORTPROBE_CACHE_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 200) * 1024 * 1024;
}

/** Remove everything importprobe cached. Returns bytes freed. */
export function cleanCache() {
  const { bytes } = cacheInfo();
  const base = cacheDir();
  for (const kind of CACHE_KINDS) rmSync(join(base, kind), { recursive: true, force: true });
  rmSync(join(base, '.last-prune'), { force: true });
  return bytes;
}

/**
 * Keep the cache under its limit (default 200 MB, IMPORTPROBE_CACHE_MAX_MB):
 * drop entries unused for 30 days, then least-recently-used ones until it is
 * under 80% of the limit. Runs at most once a day.
 * @returns {number} bytes freed
 */
export function pruneCache({ force = false } = {}) {
  const stamp = join(cacheDir(), '.last-prune');
  try {
    if (!force && Date.now() - statSync(stamp).mtimeMs < DAY) return 0;
  } catch { /* never pruned */ }
  writeFileSync(stamp, '');
  const all = entries();
  let total = all.reduce((s, e) => s + e.size, 0);
  let freed = 0;
  const target = cacheLimit() * 0.8;
  for (const e of all) {
    const stale = Date.now() - e.used > 30 * DAY;
    if (!stale && total <= cacheLimit()) break;
    if (!stale && total <= target) break;
    rmSync(e.path, { recursive: true, force: true });
    total -= e.size;
    freed += e.size;
  }
  return freed;
}
