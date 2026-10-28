# Releasing vibrissa

Versioning and publishing are automated with [changesets](https://github.com/changesets/changesets)
and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC: no publish tokens
exist anywhere). This document covers the one-time setup and the day-to-day flow.

## One-time setup (manual, npm side)

1. **Harden the npm account**
   - Enable 2FA with a **passkey/FIDO** authenticator (TOTP is being phased out).
   - Do not create any long-lived automation tokens; none are needed.

2. **First publish must be local**: trusted publishing cannot bootstrap a package that does not
   exist yet ([npm/cli#8544](https://github.com/npm/cli/issues/8544), still open as of Aug 2026);
   the trusted-publisher config can only be created on an existing package.

   ```bash
   npm login
   npm publish --access public --provenance false
   ```

   `--provenance false` is required for this one local publish: `publishConfig.provenance` is
   enabled in package.json for CI, and provenance generation fails outside a supported CI
   environment. `prepublishOnly` builds, typechecks, and tests automatically, so a stale `dist/`
   cannot ship. Local publishes use a short-lived (2-hour) session with 2FA; classic tokens no
   longer exist on npm (revoked Dec 2025).

3. **Configure the trusted publisher** on the package's npmjs.com settings page
   (Settings → Trusted Publisher):
   - Provider: GitHub Actions
   - Organization/user: `JMoak`
   - Repository: `vibrissa`
   - Workflow filename: `release.yml`
   - Environment: leave blank (or create one and add it here *and* in the workflow)
   - **Allowed actions**: configs created after May 20, 2026 must explicitly select
     `npm publish`, `npm stage publish`, or both. Select **`npm stage publish`** (see step 4).

4. **Lock it down** (package Settings → Publishing access):
   - Set publishing access to **"Require two-factor authentication and disallow tokens"**
     equivalent; with trusted publishing configured, choose the option that disallows tokens.
   - Enable [staged publishing](https://docs.npmjs.com/staged-publishing/), **GA since
     May 2026** (npm CLI >= 11.15.0): CI runs `npm stage publish` via OIDC, then a human
     approves with 2FA (`npm stage list` / `npm stage view` / `npm stage approve`) before the
     version goes live. This is the single best defense against CI-credential-theft worms
     (Shai-Hulud class), which republish instantly with stolen credentials. When enabling,
     change the workflow publish command to `npm stage publish` semantics per the docs.

## Day-to-day flow

1. Land changes on `main` via PR. Any PR that should ship includes a changeset:

   ```bash
   npx changeset
   ```

   Pick the bump (patch/minor/major) and write the changelog entry. Commit the generated
   `.changeset/*.md` file with the PR.

2. On merge to `main`, the Release workflow opens (or updates) a **"Version Packages"** PR that
   applies all pending changesets: bumps the version, updates `CHANGELOG.md`.

3. Merging the Version Packages PR triggers the actual publish: CI builds, tests, and runs
   `changeset publish`, authenticating via OIDC. Provenance attestations are generated
   automatically (npm ≥ 11.5.1) and appear on the npm package page, linking the artifact to the
   exact commit and workflow run.

4. With staged publishing enabled, the CI publish lands in the staging queue instead of going
   live. Review and release it with 2FA:

   ```bash
   npm stage list
   npm stage view @jmoak/vibrissa@<version>
   npm stage approve @jmoak/vibrissa@<version>
   ```

## Invariants

- No `NPM_TOKEN` secret exists in the repo. If a workflow ever asks for one, something is wrong.
- `files` in package.json whitelists what ships (`dist`, `bin`, `schema`, README, LICENSE);
  verify with `npm pack --dry-run` before big releases.
- Node ≥ 20 consumers only (`engines`), ESM only.

## 2.0.0 release checklist

v2 is one breaking release with one migration story. It ships as alphas first, then GA.
The published `0.1.0` line is "v1"; the major jumps to 2 to match the product generation.

**Version math.** `package.json` is already `2.0.0-alpha.0`, on purpose: a `major` changeset
on `0.1.0` would produce `1.0.0`. Do not reset the version field. From `2.0.0-alpha.0`, a
`major` changeset resolves to `2.0.0` (and to `2.0.0-alpha.N` in pre mode).

### Before the first alpha

- [ ] `.changeset/v2-mcp-2026-07-28.md` is present (`major`, title "v2: MCP 2026-07-28,
      flows, manifest lock, fuzz, check, tap, reporters").
- [ ] `npm run typecheck && npx biome ci . && npm test && npm run e2e` green on ubuntu and
      windows (CI matrix).
- [ ] `npm pack --dry-run` lists only `dist`, `bin`, `schema`, `README.md`, `LICENSE`, and
      both schemas are in it.
- [ ] Every doc in the README "Docs" list exists and its examples run against
      `tests/fixtures/echo-server`.
- [ ] `vib migrate` run against a real v1 suite (chrono-mcp) leaves it green.

### Alphas (pre mode, tag `alpha`)

1. Enter pre mode and commit the generated `.changeset/pre.json`:

   ```bash
   npx changeset pre enter alpha
   npx changeset status --verbose   # must say 2.0.0-alpha.N, never 1.0.0 or 3.0.0
   ```

2. Merge to `main`. The Version Packages PR bumps to `2.0.0-alpha.N`. Merging it publishes
   under the npm dist-tag `alpha` (changesets uses the pre tag as the dist-tag), so
   `latest` keeps pointing at `0.1.0`.
3. Approve the staged publish (`npm stage list` / `view` / `approve`, see above).
4. Point `next` at the newest alpha, so `npm i -D @jmoak/vibrissa@next` works:

   ```bash
   npm dist-tag add @jmoak/vibrissa@2.0.0-alpha.N next
   npm dist-tag ls @jmoak/vibrissa
   ```

5. Dogfood: switch chrono-mcp and ts-mcp-template to `@jmoak/vibrissa@next`, run
   `vib migrate`, `vib manifest record`, `vib run --profile ci`. Fix forward with more
   changesets; each merge cuts another alpha. Repeat step 4 after each.

### GA (`latest`)

1. Exit pre mode and commit the change to `.changeset/pre.json`:

   ```bash
   npx changeset pre exit
   npx changeset status --verbose   # must say 2.0.0
   ```

2. Merge. The Version Packages PR bumps to `2.0.0` and collapses the alpha changelog
   entries. Merging it publishes `2.0.0` under `latest`. Approve the staged publish.
3. Move `next` off the prerelease line:

   ```bash
   npm dist-tag add @jmoak/vibrissa@2.0.0 next
   npm dist-tag ls @jmoak/vibrissa      # latest: 2.0.0, next: 2.0.0, alpha: 2.0.0-alpha.N
   ```

4. Verify provenance on the npm page, then `npx -y @jmoak/vibrissa@latest --help` from a
   clean directory.
5. Release notes: link [docs/MIGRATION.md](./docs/MIGRATION.md) prominently.

## Future: more packages

When a second package lands, convert to pnpm workspaces (`packages/*`). Changesets already
handles multi-package versioning and internal dependency bumps; each new package needs its own
first local publish + trusted publisher configuration (step 2–3 above).
