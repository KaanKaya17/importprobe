# Releasing

Same model as accessprobe: npm Trusted Publishing (OIDC) in **stage-only** mode. No npm token is
stored anywhere, and nothing goes live on npm without a maintainer approving it with 2FA.

## One-time setup (done)

1. GitHub repository `KaanKaya17/importprobe` (public).
2. First version (0.1.0) published by hand — a trusted publisher can only be attached to a package that exists.
3. Trusted publisher: GitHub Actions, `KaanKaya17/importprobe`, `release.yml`, **stage publish only**
   (`npx -y npm@11.18.0 trust list importprobe` to check).
4. Publishing access: "Require two-factor authentication and disallow tokens".
5. `main` is protected: changes need the CI checks to pass.

## Every release

1. Bump `version` in **package.json and server.json** (both `version` fields) and add a
   `## [x.y.z] - date` section to CHANGELOG.md. CI fails if the versions disagree.
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```
3. The **Release** workflow checks the tag matches package.json, runs the tests and the
   packed-tarball smoke test, stages the version on npm and creates the GitHub release.
4. **Approve** it on https://www.npmjs.com/package/importprobe (Staged Packages) or with
   `npm stage approve <id>` — with 2FA. Only then is it live.
5. **MCP Registry**: after approving, run the **MCP Registry** workflow
   (Actions → MCP Registry → Run workflow). It checks that the live npm version carries the
   right `mcpName`, then publishes `server.json` with GitHub OIDC (no token).

## Refreshing generated files

- `node scripts/build-index.mjs` — the built-in "is exported by X" index (`src/data/export-index.json`).
- `node scripts/render-demo.mjs` — `docs/demo.svg` from a real run (needs `npm run demo:setup`).
