# importprobe

**Catch what your AI coding agent made up — before it runs.**

AI assistants write code that is *almost* right: an import from a package that
doesn't exist, a function the package never exported, a method from a different
library or an older major version, a dependency nobody added to `package.json`.
importprobe checks every import and API call against the real package.

```
$ npx importprobe

src/hallucinated.tsx
  2:26  ✖ error  react-router-dom@7.18.6 has no export named "useHistory".
                 → note: "useHistory" was removed: it last existed in v5 (react-router-dom@5.3.4).
  3:10  ✖ error  react-dom@19.3.1 has no export named "render".
                 → note: "render" was removed: it last existed in v18 (@types/react-dom@18.3.7).
  5:10  ✖ error  dayjs@1.11.23 has no export named "addDays".
                 → note: "addDays" is exported by date-fns (already in your package.json).
 16:33  ✖ error  "emailAddress" does not exist on ZodString (from zod@4.6.7).
                 → did you mean: .email
 18:5   ✖ error  "listenAsync" does not exist on Express (from @types/express-serve-static-core@5.1.3).
                 → did you mean: .listen
src/api.ts
  3:30  ✖ error  "axios-retry-pro" does not exist on npm — most likely made up by an AI.
                 → did you mean: axios-retry, axios-pro, retry-pro
```

## What it checks

| Problem | Example | Rule |
|---|---|---|
| Package doesn't exist | `import x from 'axios-retry-pro'` | `unknown-package` |
| Package is brand new / barely used (slopsquatting risk) | an invented name someone registered last week | `suspicious-package` |
| Real package, not in package.json, not installed | `import { nanoid } from 'nanoid'` | `missing-dependency` |
| Works only by accident (transitive) | `import mime from 'mime-types'` | `undeclared-dependency` |
| Export doesn't exist | `import { formatRelative } from 'dayjs'` | `unknown-export` |
| Method doesn't exist — directly or **in a chain** | `axios.fetch()`, `z.string().emailAddress()`, `express().listenAsync()` | `unknown-member` |
| Entry point doesn't exist | `dayjs/plugin/relativeTimes` | `unknown-subpath` |
| Node built-ins | `node:paths`, `readJsonSync` from `node:fs` | `unknown-builtin`, `unknown-export` |
| Local files | missing file, wrong export name, default import of a named-only module | `missing-file`, `unknown-export`, `no-default-export` |

And it explains *why*, so the fix is obvious:

- **"was removed in vX" / "was added in vY"** — checks older and newer majors of the package (or its `@types`).
- **"is exported by date-fns (already in your package.json)"** — the AI mixed up two libraries.
- **"did you mean"** — closest real names, preferring runnable values over type-only exports.

**It checks the real package without installing it.** When a package isn't
installed, importprobe downloads the published tarball, keeps only declaration /
JS / package.json files, and reads them with the TypeScript checker. Nothing from
the package is ever executed — no install scripts, no `require`.

Chained-call checks only report members missing from types that a **package's
own declaration files** define. Your project's types, augmentations
(`declare global`, `declare module`) and `tsconfig` `paths`/`types` are respected.

## Use it

```bash
npx importprobe                 # current folder
npx importprobe src/ app.tsx    # files or folders
npx importprobe --changed       # only files changed in git
npx importprobe --fast          # imports + direct members only, no network hints
npx importprobe --json          # for tools
npx importprobe --sarif > importprobe.sarif   # GitHub code scanning
```

Exit code `1` when errors are found (`--strict`: warnings too), `0` when clean.
In a monorepo each file is checked against its own nearest `package.json`.

### Let your AI agent fix its own mistakes (Claude Code hook)

Add to `.claude/settings.json`. After every file the agent writes, importprobe
checks it; if anything is invented, the agent gets the list back and fixes it.

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "npx -y importprobe hook" }] }
    ]
  }
}
```

### Let your agent look things up instead of guessing (MCP)

```bash
claude mcp add importprobe -- npx -y importprobe mcp
```

| Tool | What the agent gets |
|---|---|
| `list_exports` | The real API of a package or built-in, with signatures; or the members of one export (methods, what a call returns, class instance members). Installed version, or any version from npm. |
| `check_package` | Does it exist? How old, how popular, deprecated? Similar real names if not. |
| `check_files` | Everything the CLI checks, as agent-ready feedback. |

Works with any MCP client (Cursor, VS Code, Windsurf…): command `npx`, args `["-y", "importprobe", "mcp"]`.

### GitHub Actions

```yaml
- run: npx importprobe --sarif > importprobe.sarif || true
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: importprobe.sarif }
```

## How it works

1. Pre-scans files for module specifiers (static, dynamic `import()`, `require`, re-exports).
2. For each package: is it declared? installed? on npm? how old, how popular?
3. Fetches declarations for packages that aren't installed (+ matching-major `@types/*`).
4. Builds one TypeScript program (with your project's `.d.ts` files and resolution settings)
   and asks the checker what each module really exports and what each value really has.
5. For misses, looks at other major versions and your other dependencies to explain them.

Exports inferred from plain-JavaScript packages (no types) can be incomplete, so
those findings are warnings, not errors.

## Privacy

Only public registry endpoints are called (`registry.npmjs.org`,
`api.npmjs.org`), and only with package names. Your code never leaves your
machine. Results are cached in one folder (`%LOCALAPPDATA%\importprobe\cache`,
`$XDG_CACHE_HOME/importprobe` or `~/.cache/importprobe`; override with
`IMPORTPROBE_CACHE`). `--offline` disables the network entirely.

## Development

```bash
npm install
npm run demo:setup   # installs both sample apps' dependencies (scripts disabled)
npm run demo         # run against test/fixtures/ai-app
npm test
IMPORTPROBE_DEBUG=1 npx importprobe   # phase timings (=files: biggest packages loaded)
```

## License

MIT
