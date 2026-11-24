# Changelog

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
