import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HOOK_COMMAND = 'npx -y importprobe hook';
// Native Windows needs a shell to find npx.cmd when an MCP client spawns a process directly.
const MCP_LAUNCH = process.platform === 'win32'
  ? { command: 'cmd', args: ['/c', 'npx', '-y', 'importprobe', 'mcp'] }
  : { command: 'npx', args: ['-y', 'importprobe', 'mcp'] };

const TARGETS = {
  claude: {
    label: 'Claude Code',
    detect: (root) => existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md')),
    edits: [
      {
        file: '.claude/settings.json',
        what: 'PostToolUse hook: check every file the agent writes',
        apply(json) {
          json.hooks ??= {};
          json.hooks.PostToolUse ??= [];
          const already = json.hooks.PostToolUse.some((m) => (m.hooks || []).some((h) => String(h.command || '').includes('importprobe')));
          if (already) return false;
          json.hooks.PostToolUse.push({ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 60 }] });
          return true;
        },
      },
      {
        file: '.mcp.json',
        what: 'MCP server: list_exports, check_package, check_files',
        apply(json) {
          json.mcpServers ??= {};
          if (json.mcpServers.importprobe) return false;
          json.mcpServers.importprobe = { ...MCP_LAUNCH };
          return true;
        },
      },
    ],
  },
  cursor: {
    label: 'Cursor',
    detect: (root) => existsSync(join(root, '.cursor')),
    edits: [
      {
        file: '.cursor/mcp.json',
        what: 'MCP server: list_exports, check_package, check_files',
        apply(json) {
          json.mcpServers ??= {};
          if (json.mcpServers.importprobe) return false;
          json.mcpServers.importprobe = { ...MCP_LAUNCH };
          return true;
        },
      },
    ],
  },
  vscode: {
    label: 'VS Code (Copilot agent mode)',
    detect: (root) => existsSync(join(root, '.vscode')),
    edits: [
      {
        file: '.vscode/mcp.json',
        what: 'MCP server: list_exports, check_package, check_files',
        apply(json) {
          json.servers ??= {};
          if (json.servers.importprobe) return false;
          json.servers.importprobe = { type: 'stdio', ...MCP_LAUNCH };
          return true;
        },
      },
    ],
  },
};

/**
 * `importprobe init [claude|cursor|vscode...] [--dry-run]`
 * Merges importprobe into the project's agent/editor config. Never drops
 * existing settings; refuses to touch a file it cannot parse.
 */
export async function runInit(args, o = {}) {
  const root = process.cwd();
  const unknown = args.filter((a) => !TARGETS[a]);
  if (unknown.length) {
    process.stderr.write(`Unknown target: ${unknown.join(', ')}. Use: ${Object.keys(TARGETS).join(', ')}\n`);
    return 2;
  }
  let chosen = args.length ? args : Object.keys(TARGETS).filter((k) => TARGETS[k].detect(root));
  if (!chosen.length) chosen = ['claude']; // the default when nothing is detected
  const dry = o['dry-run'];
  let failures = 0;

  for (const key of chosen) {
    const t = TARGETS[key];
    process.stdout.write(`${t.label}\n`);
    for (const edit of t.edits) {
      const path = join(root, edit.file);
      let json = {};
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8');
        try {
          json = text.trim() ? JSON.parse(text) : {};
        } catch {
          // JSON with comments (common in VS Code files): rewriting it would delete them, so show what to add.
          const loose = ts.parseConfigFileTextToJson(path, text);
          const snippet = {};
          edit.apply(snippet);
          if (!loose.error && loose.config && !edit.apply(loose.config)) {
            process.stdout.write(`  ✔ ${edit.file}: already set up\n`);
            continue;
          }
          process.stdout.write(`  ✖ ${edit.file}: ${loose.error ? 'is not valid JSON' : 'has comments that rewriting would delete'}, so it was left unchanged. Add this to it:\n`);
          process.stdout.write(JSON.stringify(snippet, null, 2).replace(/^/gm, '      ') + '\n');
          failures++;
          continue;
        }
      }
      const changed = edit.apply(json);
      if (!changed) {
        process.stdout.write(`  ✔ ${edit.file}: already set up\n`);
        continue;
      }
      if (!dry) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
      }
      process.stdout.write(`  ${dry ? '•' : '✔'} ${edit.file}: ${dry ? 'would add' : 'added'} ${edit.what}\n`);
    }
  }
  if (process.platform === 'win32' && chosen.length) {
    process.stdout.write('\nMCP entries use "cmd /c npx" (needed on native Windows). Teammates on macOS/Linux can use "npx" directly.\n');
  }
  if (dry) process.stdout.write('\nDry run: nothing was written.\n');
  else process.stdout.write('\nDone. Restart your agent/editor so it picks up the changes.\n');
  return failures ? 1 : 0;
}
