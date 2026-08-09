# Releasing vibrissa

Versioning and publishing are automated with [changesets](https://github.com/changesets/changesets)
and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC — no publish tokens
exist anywhere). This document covers the one-time setup and the day-to-day flow.

## One-time setup (manual, npm side)

1. **Harden the npm account**
   - Enable 2FA with a **passkey/FIDO** authenticator (TOTP is being phased out).
   - Do not create any long-lived automation tokens; none are needed.

2. **First publish must be local** — trusted publishing cannot bootstrap a package that does not
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
     equivalent — with trusted publishing configured, choose the option that disallows tokens.
   - Enable [staged publishing](https://docs.npmjs.com/staged-publishing/) — **GA since
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
   npm stage view vibrissa@<version>
   npm stage approve vibrissa@<version>
   ```

## Invariants

- No `NPM_TOKEN` secret exists in the repo — if a workflow ever asks for one, something is wrong.
- `files` in package.json whitelists what ships (`dist`, `bin`, `schema`, README, LICENSE);
  verify with `npm pack --dry-run` before big releases.
- Node ≥ 20 consumers only (`engines`), ESM only.

## Future: more packages

When a second package lands, convert to pnpm workspaces (`packages/*`). Changesets already
handles multi-package versioning and internal dependency bumps; each new package needs its own
first local publish + trusted publisher configuration (step 2–3 above).
