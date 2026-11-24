import { getPackage, compareSemver } from './registry.js';
import { fetchForInspection } from './inspect.js';
import { namesInRoot } from './tsutil.js';
import { readCache, writeCache } from './cache.js';

const major = (v) => Number(v.split('.')[0]);
const MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Export names of `spec` in a published version, cached on disk: a published
 * version never changes, so this is computed once per (package, version, spec).
 */
export async function namesAt(name, version, spec) {
  const key = `${name}@${version}::${spec}`;
  const cached = readCache('exports', key, MONTH);
  if (cached !== undefined) return cached && { names: new Set(cached.names), values: new Set(cached.values) };
  const got = await fetchForInspection(name, version);
  const n = got ? namesInRoot(got.root, spec) : null;
  const plain = n && !n.any ? { names: [...n.names], values: [...n.values] } : null;
  writeCache('exports', key, plain);
  return plain && { names: new Set(plain.names), values: new Set(plain.values) };
}

/**
 * Was `name` exported by an older major (removed) or a newer one (added)?
 * `owner` is the package that provides the types we checked against
 * (e.g. @types/react-dom for react-dom).
 * @returns {Promise<null | {change:'removed'|'added', version:string, package:string}>}
 */
export async function findInHistory({ owner, spec, name }) {
  const pkg = await getPackage(owner.name).catch(() => null);
  if (!pkg) return null;
  const stable = Object.keys(pkg.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(compareSemver);
  const cur = major(owner.version);
  const latestOf = (m) => stable.filter((v) => major(v) === m).at(-1);

  const latest = pkg.distTags.latest;
  if (latest && /^\d/.test(latest) && major(latest) > cur) {
    const n = await namesAt(owner.name, latest, spec).catch(() => null);
    if (n?.names.has(name)) return { change: 'added', version: latest, package: owner.name };
  }

  const older = [...new Set(stable.map(major))].filter((m) => m < cur).sort((a, b) => b - a).slice(0, 3);
  for (const m of older) {
    const v = latestOf(m);
    const n = await namesAt(owner.name, v, spec).catch(() => null);
    if (n?.names.has(name)) return { change: 'removed', version: v, package: owner.name };
  }
  return null;
}
