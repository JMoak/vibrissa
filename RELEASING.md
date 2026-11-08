# Releasing Vibrissa

Every merge or direct commit to `main` runs the Release workflow. It reuses the
Ubuntu/Windows, Node 20/22/24 CI matrix before publishing through npm trusted
publishing. Release jobs are serialized. PR checks have read-only repository
access; only the release job has `contents: write` and `id-token: write`.

The active release channel is **alpha**. The first release is explicitly
`2.0.0-alpha.0`; subsequent conventional release commits publish further alphas.
npm's `latest` remains `0.1.0` until a separately approved stable-v2 transition.

## Trusted publisher

The existing npm package is `@jmoak/vibrissa`. Its GitHub Actions trusted publisher
must use these exact values:

- Organization/user: `JMoak`
- Repository: `vibrissa`
- Workflow filename: `release.yml`
- Environment: empty
- Allowed action: **`npm publish`**

This workflow publishes directly through OIDC, with provenance. It does not use
`NPM_TOKEN`, staged-package approval, Changesets, or a release PR. GitHub's
"Allow GitHub Actions to create and approve pull requests" setting is not needed.

The package's registry is `https://registry.npmjs.org/`, including the trailing
slash. Let semantic-release manage npm authentication: do not add `registry-url`
to setup-node or supply a placeholder token. Release tooling is pinned to
semantic-release 25.0.9 and the conventional-commits preset 8.0.0; validate them
together when updating. The release runner uses Node 24; consumers remain Node 20+.

## First alpha: one-time bootstrap

The `stable` branch and `v0.1.0` tag anchor the actual published `0.1.0` commit,
`6367edc8d0095904739bc0cce699796716d23855`. They preserve the release history;
never create a version tag for an unpublished package to influence version math.

1. Review the [v2 release notes](docs/RELEASE_V2.md) and
   [migration guide](docs/MIGRATION.md). Confirm the CI matrix, package contents,
   and a real v1-suite migration are ready for alpha users.
2. In GitHub Actions, choose **Release → Run workflow**, select `main`, and enable
   **`bootstrapAlpha`**. The equivalent dispatch input is `bootstrapAlpha: true`.
3. The workflow runs all CI checks, publishes **`2.0.0-alpha.0`** to npm's `alpha`
   tag, verifies the published commit, then records its Git tag and GitHub prerelease.
4. Confirm the registry and try the published CLI from a clean directory:

   ```sh
   npm view @jmoak/vibrissa dist-tags --json
   npx -y @jmoak/vibrissa@alpha --version
   ```

   Expect `alpha: 2.0.0-alpha.0` and `latest: 0.1.0`. npm processing may take a few
   minutes. Check the provenance link on the package page.

Until this bootstrap is complete, ordinary main pushes finish verification and
report that automatic alpha publishing is waiting. If upload succeeds but release
metadata is interrupted, rerun the original bootstrap workflow run. It retains the
published commit even if `main` has advanced, verifies the publication, and repairs
missing metadata. A new dispatch from a different commit cannot repair that version.
A version or commit mismatch requires investigation, not a new tag or forced overwrite.

## Subsequent releases

Once the alpha baseline is recorded, semantic-release examines every commit since
the last release tag. `feat`, `fix`, `perf`, and conventional breaking-change
commits trigger a new alpha; a history containing only `docs`, `test`, or `chore`
commits does not. A regular merge includes its underlying commits. For squash
merges, use a conventional PR title because the squash commit is what remains.

Do not manually bump the source manifest to trigger a release. The release job
assigns the version in its workspace, then `prepack` rebuilds the package. Published
versions and Git tags are the release record; no version-bump commit is pushed to
main. Release notes are generated from the commits. Dependabot's ordinary chore
commits do not publish; use a reviewed `fix(deps): ...` squash title when a runtime
dependency repair needs to ship.

A manual **Run workflow** with `bootstrapAlpha` left false uses this same normal
release path. It still runs CI and publishes only when unreleased commits warrant
it. Do not use the one-time bootstrap to publish later alpha versions.

## Stable v2

Promoting v2 to `latest` is a separate, explicitly reviewed release transition.
It must publish a real **`2.0.0`**, verify that artifact, and record matching release
metadata before enabling normal stable-main releases. The alpha bootstrap does
not perform this transition.

Do not simply change `main` from prerelease to stable: conventional version math
from the historical `0.1.0` baseline can select `1.0.0`, not the intended `2.0.0`.
Keep alpha users on `@jmoak/vibrissa@alpha` and stable users on `latest` until the
stable transition is implemented and verified.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [semantic-release on GitHub Actions](https://semantic-release.org/recipes/ci-configurations/github-actions/).
