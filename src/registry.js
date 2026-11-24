import { readCache, writeCache } from './cache.js';
import { distance } from './suggest.js';

const REGISTRY = (process.env.IMPORTPROBE_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
const DAY = 24 * 60 * 60 * 1000;
const UA = 'importprobe (+https://www.npmjs.com/package/importprobe)';

const memo = new Map();
function once(key, fn) {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}

const enc = (name) => name.replace('/', '%2F');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Trimmed package document: versions (with dist + types info), dist-tags,
 * creation time. Returns null when the package does not exist.
 */
export function getPackage(name) {
  return once(`pkg:${name}`, async () => {
    const cached = readCache('packages', name, DAY);
    if (cached !== undefined) return cached;
    const doc = await getJson(`${REGISTRY}/${enc(name)}`);
    let slim = null;
    if (doc && doc.versions) {
      const versions = {};
      for (const [v, m] of Object.entries(doc.versions)) {
        versions[v] = {
          tarball: m.dist?.tarball,
          types: m.types || m.typings || null,
          hasExports: !!m.exports,
          deprecated: m.deprecated || null,
        };
      }
      slim = {
        name: doc.name,
        distTags: doc['dist-tags'] || {},
        created: doc.time?.created || null,
        modified: doc.time?.modified || null,
        versions,
      };
    } else if (doc) {
      // Unpublished packages keep a stub document without versions.
      slim = { name, unpublished: true, distTags: {}, versions: {} };
    }
    writeCache('packages', name, slim);
    return slim;
  });
}

/**
 * Deprecation message of one published version, from the small per-version
 * manifest (the full package document can be megabytes). null = not deprecated.
 */
export function deprecationOf(name, version) {
  return once(`dep:${name}@${version}`, async () => {
    const key = `${name}@${version}`;
    const cached = readCache('deprecations', key, 7 * DAY);
    if (cached !== undefined) return cached;
    const doc = await getJson(`${REGISTRY}/${enc(name)}/${encodeURIComponent(version)}`).catch(() => undefined);
    if (doc === undefined) return null; // network trouble: say nothing
    const msg = typeof doc?.deprecated === 'string' && doc.deprecated.trim() ? doc.deprecated.trim() : null;
    writeCache('deprecations', key, msg);
    return msg;
  });
}

export function weeklyDownloads(name) {
  return once(`dl:${name}`, async () => {
    const cached = readCache('downloads', name, DAY);
    if (cached !== undefined) return cached;
    const doc = await getJson(`${DOWNLOADS}/${enc(name)}`).catch(() => null);
    const n = doc?.downloads ?? null;
    writeCache('downloads', name, n);
    return n;
  });
}

// A suggestion must itself be safe to install: suggesting a barely used or
// brand-new name to an AI is exactly the slopsquatting risk we warn about.
const MIN_SUGGESTION_DOWNLOADS = 1000;
const MIN_SUGGESTION_AGE_DAYS = 30;

/** Latest version + its deprecation, from the small per-version manifest. */
export function latestManifest(name) {
  return once(`latest:${name}`, async () => {
    const cached = readCache('latest', name, DAY);
    if (cached !== undefined) return cached;
    const doc = await getJson(`${REGISTRY}/${enc(name)}/latest`).catch(() => undefined);
    if (doc === undefined) return null;
    const out = doc?.version ? { version: doc.version, deprecated: typeof doc.deprecated === 'string' && doc.deprecated ? doc.deprecated : null } : null;
    writeCache('latest', name, out);
    return out;
  });
}

async function suggestionInfo(n) {
  // Cheap checks only: the full package document of e.g. "react" is megabytes.
  const downloads = await weeklyDownloads(n);
  if (!downloads || downloads < MIN_SUGGESTION_DOWNLOADS) return null;
  const latest = await latestManifest(n);
  if (!latest) return null;
  return { name: n, downloads, deprecated: !!latest.deprecated };
}

/** Name variants with one or two words dropped: "react-query-helpers-pro" → "react-query", … */
function shorterNames(name) {
  const scope = name.startsWith('@') ? name.split('/')[0] + '/' : '';
  const words = name.slice(scope.length).split(/[-_.]/).filter(Boolean);
  const out = new Set();
  const n = words.length;
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const kept = words.filter((_, i) => mask & (1 << i));
    const dropped = n - kept.length;
    if (dropped > 2 || (kept.length === 1 && kept[0].length < 4)) continue;
    out.add(scope + kept.join('-'));
  }
  if (scope) out.add(name.slice(scope.length));
  out.delete(name);
  return { words, names: [...out] };
}

/** One-keystroke variants: a deleted, swapped, or separator character ("expresss" → "express"). */
export function typoVariants(name) {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/') + 1) : '';
  const s = name.slice(scope.length);
  const out = new Set();
  for (let i = 0; i < s.length; i++) out.add(s.slice(0, i) + s.slice(i + 1)); // deletion
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)); // swap
  out.add(s.replace(/[-_.]/g, '')); // react-dom vs reactdom
  for (const sep of ['-', '_', '.']) out.add(s.replace(/[-_.]/g, sep));
  for (let i = 1; i < s.length; i++) if (!/[-_.]/.test(s[i - 1] + s[i])) out.add(s.slice(0, i) + '-' + s.slice(i)); // missing hyphen
  out.delete(s);
  return [...out].filter((v) => v.length >= 2 && /^[a-z0-9][a-z0-9._-]*$/.test(v)).map((v) => scope + v);
}

/** Weekly downloads for many unscoped packages in one request (npm bulk API, max 128). */
async function bulkDownloads(names) {
  const out = new Map();
  const unscoped = names.filter((n) => !n.startsWith('@'));
  for (let i = 0; i < unscoped.length; i += 128) {
    const chunk = unscoped.slice(i, i + 128);
    const doc = await getJson(`${DOWNLOADS}/${chunk.join(',')}`).catch(() => null);
    if (chunk.length === 1 && doc?.downloads !== undefined) out.set(chunk[0], doc.downloads);
    else for (const [n, v] of Object.entries(doc || {})) if (v?.downloads) out.set(n, v.downloads);
  }
  for (const n of names.filter((x) => x.startsWith('@'))) {
    const d = await weeklyDownloads(n);
    if (d) out.set(n, d);
  }
  return out;
}

/**
 * Popular packages one keystroke away from `name` ("expresss" → express),
 * most popular first. Used to flag typosquats.
 */
export function lookalikes(name) {
  return once(`look:${name}`, async () => {
    const cached = readCache('lookalikes', name, 7 * DAY);
    if (cached !== undefined) return cached;
    const counts = await bulkDownloads(typoVariants(name));
    const scored = [...counts].map(([n, downloads]) => ({ name: n, downloads })).sort((a, b) => b.downloads - a.downloads).slice(0, 5);
    writeCache('lookalikes', name, scored);
    return scored;
  });
}

/**
 * Established packages with names close to `name`, best first.
 * AIs usually invent names by bolting words onto a real package
 * ("axios-retry-pro"), so names with one or two words dropped are tried first.
 * Only packages with real usage are suggested; deprecated ones go last, marked.
 */
export function similarPackages(name, max = 3) {
  return once(`sim:${name}`, async () => {
    const cached = readCache('search', name, 7 * DAY);
    if (cached !== undefined) return cached;

    const { words, names: derived } = shorterNames(name);
    // Closest first: names that keep more of the original words, then typo fixes,
    // then popularity. A deprecated match stays in place (it is what was meant) but is marked.
    const kept = (n) => n.replace(/^@[^/]+\//, '').split(/[-_.]/).length;
    const exact = (await Promise.all(derived.map(suggestionInfo))).filter(Boolean)
      .sort((a, b) => kept(b.name) - kept(a.name) || b.downloads - a.downloads);
    const typos = (await lookalikes(name).catch(() => [])).filter((l) => l.downloads >= MIN_SUGGESTION_DOWNLOADS);

    // Search results only count when they are actually close (few edits or most words shared).
    const found = new Set();
    const doc = await getJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(words.join(' '))}&size=20`).catch(() => null);
    for (const o of doc?.objects || []) if (o.package.name !== name && !derived.includes(o.package.name)) found.add(o.package.name);
    const wa = new Set(words.map((w) => w.toLowerCase()));
    const close = [...found].filter((n) => {
      if (distance(name, n) <= Math.max(2, Math.floor(name.length / 4))) return true;
      const wb = n.replace(/^@[^/]+\//, '').toLowerCase().split(/[-_.]/).filter(Boolean);
      const shared = wb.filter((w) => wa.has(w)).length;
      return shared >= 2 && shared / Math.max(wa.size, wb.length) >= 0.6;
    });
    const searched = (await Promise.all(close.slice(0, 6).map(suggestionInfo))).filter(Boolean);

    const seen = new Set();
    const ordered = [...exact.filter((e) => kept(e.name) > 1), ...typos, ...exact.filter((e) => kept(e.name) === 1), ...searched]
      .filter((e) => !seen.has(e.name) && seen.add(e.name));
    const result = ordered.slice(0, max).map((e) => (e.deprecated ? `${e.name} (deprecated)` : e.name));
    writeCache('search', name, result);
    return result;
  });
}

/** Pick the version a range would install. Handles exact, ^, ~, x-ranges, tags. */
export function pickVersion(pkg, range) {
  const all = Object.keys(pkg.versions).filter((v) => !v.includes('-')).sort(compareSemver);
  if (!range || range === '*' || range === 'latest' || range === '') return pkg.distTags.latest || all.at(-1);
  if (pkg.distTags[range]) return pkg.distTags[range];
  const r = range.trim().split(/\s*\|\|\s*/)[0].replace(/^[=v]+/, '');
  if (pkg.versions[r]) return r;
  const m = /^([\^~]|>=)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(r);
  if (!m) return pkg.distTags.latest || all.at(-1);
  const [, op, maj, min] = m;
  const ok = all.filter((v) => {
    const [a, b] = v.split('.').map(Number);
    if (op === '>=') return compareSemver(v, `${maj}.${min && /\d/.test(min) ? min : 0}.0`) >= 0;
    if (a !== Number(maj)) return false;
    if (op === '~' || (!op && min && /\d/.test(min))) return min && /\d/.test(min) ? b === Number(min) : true;
    return true;
  });
  return ok.at(-1) || pkg.distTags.latest || all.at(-1);
}

export function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** @types package name for a package: "@scope/pkg" → "@types/scope__pkg". */
export function typesPackageName(name) {
  return '@types/' + (name.startsWith('@') ? name.slice(1).replace('/', '__') : name);
}
