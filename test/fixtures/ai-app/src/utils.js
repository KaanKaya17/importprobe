export function formatDateTime(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
