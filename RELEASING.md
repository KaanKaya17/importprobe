# Releasing

Same model as accessprobe: npm Trusted Publishing (OIDC) in **stage-only** mode. No npm token is
stored anywhere, and nothing goes live on npm without a maintainer approving it with 2FA.

## One-time setup

1. **Create the GitHub repository** `KaanKaya17/importprobe` (public) and push `main`.
2. **Publish the very first version by hand** (a trusted publisher can only be attached to a
   package that exists):
   ```bash
   npm login
   npm publish --access public
   ```
3. **Attach the trusted publisher** on npmjs.com → importprobe → Settings → Trusted Publisher:
   GitHub Actions, repository `KaanKaya17/importprobe`, workflow `release.yml`,
   "Allow npm publish" **unchecked** (stage only).
4. **Lock down publishing** on the same page: "Require two-factor authentication and disallow tokens".
5. Optional: protect `main` (require the CI checks to pass), like accessprobe's ruleset.

## Every release

1. Bump `version` in package.json and add a `## [x.y.z] - date` section to CHANGELOG.md.
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```
3. The Release workflow checks the tag matches package.json, runs the tests and the
   packed-tarball smoke test, stages the version on npm and creates the GitHub release.
4. Approve it on https://www.npmjs.com/package/importprobe (Staged Packages) or with
   `npm stage approve <id>` — with 2FA. Only then is it live.
