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

/**
 * Real packages with names close to `name`, best first.
 * AIs usually invent names by bolting a word onto a real package
 * ("axios-retry-pro"), so names with one word dropped are tried first.
 */
export function similarPackages(name, max = 3) {
  return once(`sim:${name}`, async () => {
    const cached = readCache('search', name, 7 * DAY);
    if (cached !== undefined) return cached;

    const scope = name.startsWith('@') ? name.split('/')[0] + '/' : '';
    const words = name.slice(scope.length).split(/[-_.]/).filter(Boolean);
    const derived = new Set();
    for (let i = 0; i < words.length && words.length > 1; i++) {
      derived.add(scope + words.filter((_, j) => j !== i).join('-'));
    }
    if (scope) derived.add(name.slice(scope.length));
    // Real names derived by dropping one word, most-downloaded first: the real
    // package (axios-retry) should beat lookalikes (retry-pro, axios-pro).
    const exactScored = [];
    for (const d of derived) {
      if (d === name) continue;
      const pkg = await getPackage(d).catch(() => null);
      if (pkg && !pkg.unpublished) exactScored.push([(await weeklyDownloads(d)) ?? 0, d]);
    }
    const exact = exactScored.sort((a, b) => b[0] - a[0]).map(([, d]) => d);

    const texts = [words.join(' '), words.slice(0, -1).join(' ')].filter(Boolean);
    const found = new Set();
    for (const text of new Set(texts)) {
      const doc = await getJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=20`).catch(() => null);
      for (const o of doc?.objects || []) if (o.package.name !== name) found.add(o.package.name);
    }
    const ranked = [...found]
      .filter((n) => !exact.includes(n))
      .map((n) => [distance(name, n), n])
      .sort((a, b) => a[0] - b[0])
      .map(([, n]) => n);
    const result = [...exact, ...ranked].slice(0, max);
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
