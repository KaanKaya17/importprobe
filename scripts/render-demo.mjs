// Renders docs/demo.svg: a terminal-style picture of a REAL importprobe run on
// test/fixtures/real-app/src/bad (run `npm run demo:setup` first). Regenerate after output changes:
//   node scripts/render-demo.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', 'test', 'fixtures', 'real-app');
process.chdir(app);
Object.defineProperty(process.stdout, 'isTTY', { value: true }); // keep the colors
delete process.env.NO_COLOR;

const { analyzeByProject } = await import('../src/cli.js');
const { collectFiles } = await import('../src/project.js');
const { formatPretty } = await import('../src/report.js');
const version = JSON.parse((await import('node:fs')).readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const result = await analyzeByProject(collectFiles(['src/bad']), { offline: false, deep: true, hints: true });
const text = `$ npx importprobe src/bad\n` + formatPretty(result, { cwd: app, version });

const COLORS = { 1: null, 2: '#8b949e', 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 36: '#79c0ff', 90: '#6e7681' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const lines = text.split('\n');
const charW = 8.4;
const lineH = 20;
const pad = 20;
const width = Math.ceil(Math.max(...lines.map((l) => l.replace(/\x1b\[\d+m/g, '').length)) * charW + pad * 2);
const height = lines.length * lineH + pad * 2 + 28;

const rows = lines.map((line, i) => {
  let out = '';
  let color = null;
  let bold = false;
  for (const part of line.split(/(\x1b\[\d+m)/)) {
    const m = /^\x1b\[(\d+)m$/.exec(part);
    if (m) {
      const code = Number(m[1]);
      if (code === 0) { color = null; bold = false; } else if (code === 1) bold = true; else color = COLORS[code] ?? color;
      continue;
    }
    if (!part) continue;
    const prompt = i === 0 && part.startsWith('$');
    const attrs = [prompt ? 'fill="#7ee787"' : color ? `fill="${color}"` : '', bold ? 'font-weight="700"' : ''].filter(Boolean).join(' ');
    out += attrs ? `<tspan ${attrs}>${esc(part)}</tspan>` : esc(part);
  }
  return `<text x="${pad}" y="${pad + 28 + (i + 1) * lineH - 6}" xml:space="preserve">${out}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="importprobe output on code with made-up imports">
<rect width="100%" height="100%" rx="10" fill="#0d1117"/>
<circle cx="${pad + 6}" cy="${pad + 4}" r="6" fill="#ff5f57"/><circle cx="${pad + 26}" cy="${pad + 4}" r="6" fill="#febc2e"/><circle cx="${pad + 46}" cy="${pad + 4}" r="6" fill="#28c840"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14" fill="#e6edf3">
${rows.join('\n')}
</g>
</svg>
`;
const out = join(here, '..', 'docs', 'demo.svg');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(`${out} (${lines.length} lines, ${width}x${height})`);
