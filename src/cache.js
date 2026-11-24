import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

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
