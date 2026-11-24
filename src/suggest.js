/** Damerau-free Levenshtein distance, case-insensitive. */
export function distance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** "useQueryParams" → ["use", "query", "params"]; "axios-retry" → ["axios", "retry"]. */
export function words(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Closest candidates to `name`. Exact case-insensitive matches first, then
 * small edit distances, then names that share most of their words
 * (useQueryParams → useSearchParams) or contain each other.
 */
export function suggest(name, candidates, max = 3) {
  const limit = Math.max(2, Math.floor(name.length / 3));
  const lower = name.toLowerCase();
  const wa = new Set(words(name));
  const scored = [];
  for (const c of new Set(candidates)) {
    if (c === 'default' || c.startsWith('__')) continue;
    const cl = c.toLowerCase();
    let score = distance(name, c);
    if (cl === lower) score = -1;
    else if (score > limit) {
      const wb = new Set(words(c));
      const shared = [...wa].filter((w) => wb.has(w)).length;
      const first = words(name)[0] === words(c)[0];
      if (wa.size >= 2 && shared / Math.max(wa.size, wb.size) >= 0.6) score = limit + 0.4;
      // "emailAddress" → "email", "parseArgsAsync" → "parseArgs": the real name is the start of the invented one.
      else if (first && shared === wb.size && wb.size >= 1 && cl.length >= 4) score = limit + 0.45;
      else if (lower.length >= 4 && cl.length * 2 >= lower.length && (cl.includes(lower) || lower.includes(cl))) score = limit + 0.5;
      else continue;
    }
    scored.push([score, c]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1].length - y[1].length || x[1].localeCompare(y[1]));
  return scored.slice(0, max).map(([, c]) => c);
}
