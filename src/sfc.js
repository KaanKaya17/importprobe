import { extname } from 'node:path';

export const SFC_EXT = new Set(['.vue', '.svelte', '.astro']);

export const isSfc = (file) => SFC_EXT.has(extname(file).toLowerCase());

/**
 * The script parts of a Vue/Svelte/Astro file as one JS/TS text, with everything
 * else blanked out (newlines kept), so every position maps 1:1 to the original
 * file and reported line/column numbers are exact.
 * @returns {{ code: string, lang: 'ts' | 'js' }}
 */
export function extractScripts(file, text) {
  const ranges = [];
  let lang = 'js';
  const ext = extname(file).toLowerCase();

  if (ext === '.astro') {
    const fm = /^(﻿?\s*)---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (fm) {
      const start = fm.index + fm[1].length + 3;
      ranges.push([start, start + fm[2].length + 1]);
    }
    lang = 'ts'; // Astro frontmatter and <script> tags are TypeScript
  }

  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m; (m = re.exec(text));) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[^"'\s>]+/i.test(attrs)) continue; // external or non-JS (e.g. JSON-LD)
    if (/\blang\s*=\s*["']?(ts|typescript)\b/i.test(attrs)) lang = 'ts';
    const start = m.index + m[0].indexOf('>') + 1;
    ranges.push([start, start + m[2].length]);
  }

  let code = '';
  let pos = 0;
  const blank = (s) => s.replace(/[^\r\n]/g, ' ');
  for (const [a, b] of ranges.sort((x, y) => x[0] - y[0])) {
    if (a < pos) continue;
    code += blank(text.slice(pos, a)) + text.slice(a, b);
    pos = b;
  }
  code += blank(text.slice(pos));
  return { code, lang };
}

/** The in-memory TS/JS file name used for an SFC's scripts. */
export const virtualNameOf = (file, lang) => `${file}.${lang === 'ts' ? 'ts' : 'js'}`;
