# Changelog

## [0.1.1] - 2026-11-24

- **Typosquats**: packages one keystroke away from a far more popular one (`expresss`, `reactdom`,
  `loadsh`) are reported as `suspicious-package`.
- **Deprecated packages** are reported (`deprecated-package`).
- **Safer suggestions**: suggested packages need ≥ 1,000 downloads/week (a barely used name is
  exactly what slopsquatting looks like); deprecated ones are marked; names with one or two words
  dropped are tried (`react-query-helpers-pro` → `react-query`).
- **`importprobe init`** sets up the Claude Code hook and the MCP server for Claude Code, Cursor
  and VS Code, merging into existing config files.
- **Vue, Svelte and Astro** files: their scripts are checked, with exact line/column numbers.
- **"is exported by X"** hints also come from a built-in index of ~100 popular packages, so mix-ups
  are explained even when the right package isn't installed.
- **Cache**: kept under 200 MB automatically (`IMPORTPROBE_CACHE_MAX_MB`); `importprobe cache`
  and `importprobe cache clean`. Export lists of published versions are cached, so repeat runs
  with version hints are about twice as fast.
- **GitHub Action** (`uses: KaanKaya17/importprobe@…`) with PR annotations, job summary, SARIF,
  and `errors`/`warnings` outputs. New CLI flags `--github` and `--sarif-file`.
- **MCP Registry**: `server.json` and `mcpName`, published as `io.github.KaanKaya17/importprobe`.
- Uses only public TypeScript compiler APIs.

## [0.1.0] - 2026-11-24

First release.

- Checks every import against reality: packages that don't exist on npm, brand-new or barely used
  packages (slopsquatting risk), packages missing from package.json, transitive-only dependencies,
  missing exports, missing entry points, Node.js built-ins, and local files.
- Checks members of imported values (`axios.fetch`) and **chained calls on library types**
  (`z.string().emailAddress()`, `express().listenAsync()`), respecting your project's own
  declarations and augmentations.
- Explains misses: "was removed: it last existed in v5", "was added in v8", "is exported by
  date-fns (already in your package.json)", "looks like fs-extra", plus "did you mean" suggestions.
- Verifies packages that aren't installed by reading their published declarations — nothing from
  the package is ever executed.
- Output as text, `--json` or `--sarif`; `--fast`, `--offline`, `--strict`, `--changed`.
- Claude Code `PostToolUse` hook (`importprobe hook`) so the agent fixes its own imports.
- MCP server (`importprobe mcp`) with `list_exports`, `check_package` and `check_files`.
- Monorepos: each file is checked against its nearest package.json.
