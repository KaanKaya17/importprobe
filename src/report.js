import { relative } from 'node:path';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code) => (s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { red: paint(31), yellow: paint(33), cyan: paint(36), dim: paint(2), bold: paint(1), green: paint(32), gray: paint(90) };

const ICON = { error: () => c.red('✖ error  '), warning: () => c.yellow('⚠ warning'), info: () => c.cyan('ℹ info   ') };

export function formatPretty(result, { cwd = process.cwd(), verbose = false, version = '' } = {}) {
  const shown = result.findings.filter((f) => verbose || f.severity !== 'info');
  const lines = [];
  lines.push(c.bold(`importprobe ${version}`) + c.dim(` — ${result.files} file(s), ${result.imports} import(s), ${result.packages} package(s)`));
  lines.push('');

  let lastFile = null;
  for (const f of shown) {
    const file = relative(cwd, f.file) || f.file;
    if (file !== lastFile) {
      if (lastFile !== null) lines.push('');
      lines.push(c.bold(file.replace(/\\/g, '/')));
      lastFile = file;
    }
    const pos = c.gray(`${f.line}:${f.column}`.padEnd(7));
    const more = f.count > 1 ? c.dim(` (+${f.count - 1} more use${f.count > 2 ? 's' : ''})`) : '';
    lines.push(`  ${pos} ${ICON[f.severity]()} ${f.message}${more} ${c.dim(`[${f.rule}]`)}`);
    if (f.hint) lines.push(`  ${' '.repeat(7)} ${' '.repeat(10)} ${c.cyan('→ note:')} ${f.hint}`);
    if (f.suggestions?.length) lines.push(`  ${' '.repeat(7)} ${' '.repeat(10)} ${c.green('→ did you mean:')} ${f.suggestions.join(', ')}`);
    if (f.fix) lines.push(`  ${' '.repeat(7)} ${' '.repeat(10)} ${c.green('→ fix:')} ${f.fix}`);
  }

  const n = (s) => result.findings.filter((f) => f.severity === s).length;
  const errors = n('error');
  const warnings = n('warning');
  if (shown.length) lines.push('');
  if (!errors && !warnings) lines.push(c.green('✔ Every import points at something that exists.'));
  else lines.push(`${errors ? c.red(`${errors} error(s)`) : '0 errors'}, ${warnings ? c.yellow(`${warnings} warning(s)`) : '0 warnings'}`);
  return lines.join('\n');
}

export function formatJson(result, { cwd = process.cwd(), version = '' } = {}) {
  return JSON.stringify({
    tool: 'importprobe',
    version,
    ...result,
    findings: result.findings.map((f) => ({ ...f, file: relative(cwd, f.file).replace(/\\/g, '/') })),
    summary: {
      errors: result.findings.filter((f) => f.severity === 'error').length,
      warnings: result.findings.filter((f) => f.severity === 'warning').length,
    },
  }, null, 2);
}

const RULES = {
  'unknown-package': 'Package does not exist on npm',
  'suspicious-package': 'Package is brand new or barely used (possible slopsquatting)',
  'missing-dependency': 'Package is neither in package.json nor installed',
  'undeclared-dependency': 'Package works only because another package installed it',
  'unknown-export': 'Module has no such export',
  'unknown-member': 'Value has no such property or method',
  'unknown-subpath': 'Package has no such entry point',
  'unknown-builtin': 'Not a Node.js built-in module',
  'missing-file': 'Imported file does not exist',
  'no-default-export': 'Module has no default export',
  'unresolved-alias': 'Path alias does not resolve',
  'not-verified': 'Could not be verified',
  'not-installed': 'Declared but not installed',
};

/** SARIF 2.1.0, for GitHub code scanning (github/codeql-action/upload-sarif). */
export function formatSarif(result, { cwd = process.cwd(), version = '' } = {}) {
  const used = [...new Set(result.findings.map((f) => f.rule))];
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'importprobe',
          version,
          informationUri: 'https://www.npmjs.com/package/importprobe',
          rules: used.map((id) => ({ id, shortDescription: { text: RULES[id] || id } })),
        },
      },
      results: result.findings.map((f) => ({
        ruleId: f.rule,
        level: f.severity === 'info' ? 'note' : f.severity,
        message: { text: [f.message, f.hint, f.suggestions?.length ? `Did you mean: ${f.suggestions.join(', ')}?` : '', f.fix ? `Fix: ${f.fix}` : ''].filter(Boolean).join(' ') },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: relative(cwd, f.file).replace(/\\/g, '/') },
            region: { startLine: f.line, startColumn: f.column },
          },
        }],
      })),
    }],
  }, null, 2);
}

const ghData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * GitHub Actions workflow commands: each finding becomes an annotation on the
 * changed line of the pull request. Also returns a Markdown job summary.
 */
export function formatGithub(result, { cwd = process.cwd(), version = '' } = {}) {
  const lines = [];
  const rows = [];
  for (const f of result.findings) {
    if (f.severity === 'info') continue;
    const file = relative(cwd, f.file).replace(/\\/g, '/');
    const extra = [f.hint, f.suggestions?.length ? `Did you mean: ${f.suggestions.join(', ')}?` : '', f.fix ? `Fix: ${f.fix}` : ''].filter(Boolean).join(' ');
    const level = f.severity === 'error' ? 'error' : 'warning';
    lines.push(`::${level} file=${ghProp(file)},line=${f.line},col=${f.column},title=${ghProp(`importprobe: ${f.rule}`)}::${ghData(extra ? `${f.message}\n${extra}` : f.message)}`);
    rows.push(`| ${level === 'error' ? '✖' : '⚠'} | \`${file}:${f.line}\` | ${f.message.replace(/\|/g, '\\|')}${extra ? `<br>${extra.replace(/\|/g, '\\|')}` : ''} |`);
  }
  const errors = result.findings.filter((f) => f.severity === 'error').length;
  const warnings = result.findings.filter((f) => f.severity === 'warning').length;
  lines.push(`importprobe ${version}: ${result.files} file(s), ${result.imports} import(s) — ${errors} error(s), ${warnings} warning(s)`);
  const summary = [
    `### importprobe ${version}`,
    '',
    rows.length
      ? `${errors} error(s), ${warnings} warning(s) in ${result.files} file(s).\n\n| | Where | What |\n|---|---|---|\n${rows.join('\n')}`
      : `✔ All ${result.imports} imports in ${result.files} file(s) point at things that exist.`,
    '',
  ].join('\n');
  return { text: lines.join('\n'), summary };
}

/** Short plain text an AI agent can act on (used by the hook). */
export function formatForAgent(result, { cwd = process.cwd() } = {}) {
  const lines = ['importprobe found imports that do not match reality. Fix them before continuing:'];
  for (const f of result.findings) {
    if (f.severity === 'info') continue;
    let line = `- ${relative(cwd, f.file).replace(/\\/g, '/')}:${f.line}:${f.column} ${f.message}`;
    if (f.hint) line += ` ${f.hint}`;
    if (f.suggestions?.length) line += ` Did you mean: ${f.suggestions.join(', ')}?`;
    if (f.fix) line += ` Fix: ${f.fix}`;
    lines.push(line);
  }
  lines.push("Do not install a package you cannot verify exists and is the one you meant. Check the package's real API instead of guessing.");
  return lines.join('\n');
}
