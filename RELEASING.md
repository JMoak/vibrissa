# Releasing Vibrissa

Every merge or direct commit to `main` runs the Release workflow. It reuses the
Ubuntu/Windows, Node 20/22/24 CI matrix before publishing through npm trusted
publishing. Release jobs are serialized. PR checks have read-only repository
access; only the release job has `contents: write` and `id-token: write`.

The active release channel is **stable**, published to npm's `latest` tag.
The one-time stable bootstrap publishes `2.0.0`; subsequent conventional release
commits select the next stable version automatically. The existing `alpha` tag
remains at `2.0.0-alpha.0`.

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

## Stable v2: one-time bootstrap

The `stable` branch and `v0.1.0` tag anchor the actual published `0.1.0` commit,
`6367edc8d0095904739bc0cce699796716d23855`. They preserve the release history;
never create a version tag for an unpublished package to influence version math.

1. Review the [v2 release notes](docs/RELEASE_V2.md) and
   [migration guide](docs/MIGRATION.md). Confirm the CI matrix, package contents,
   and a real v1-suite migration are ready for stable users.
2. In GitHub Actions, choose **Release → Run workflow**, select `main`, and enable
   **`bootstrapStable`**. The equivalent dispatch input is `bootstrapStable: true`.
3. The workflow runs all CI checks, publishes **`2.0.0`** to npm's `latest`
   tag, verifies the published commit, then records its Git tag and stable GitHub release.
4. Confirm the registry and try the published CLI from a clean directory:

   ```sh
   npm view @jmoak/vibrissa dist-tags --json
   npx -y @jmoak/vibrissa@latest --version
   ```

   Expect `alpha: 2.0.0-alpha.0` and `latest: 2.0.0`. npm processing may take a few
   minutes. Check the provenance link on the package page.

Until this bootstrap is complete, ordinary main pushes finish verification and
report that automatic stable publishing is waiting. If upload succeeds but release
metadata is interrupted, rerun the original bootstrap workflow run. It retains the
published commit even if `main` has advanced, verifies the publication, and repairs
missing metadata. A new dispatch from a different commit cannot repair that version.
A version or commit mismatch requires investigation, not a new tag or forced overwrite.

## Subsequent releases

Once the stable baseline is recorded, semantic-release examines every commit since
the last release tag. `feat`, `fix`, `perf`, and conventional breaking-change
commits trigger a new release. From `2.0.0`, a `fix` or `perf` selects `2.0.1`,
a `feat` selects `2.1.0`, and a breaking change selects `3.0.0`. A history containing
only `docs`, `test`, `ci`, or `chore` commits does not publish. A regular merge
includes its underlying commits. For squash
merges, use a conventional PR title because the squash commit is what remains.

Do not manually bump the source manifest to trigger a release. The release job
assigns the version in its workspace, then `prepack` rebuilds the package. Published
versions and Git tags are the release record; no version-bump commit is pushed to
main. Release notes are generated from the commits. Dependabot's ordinary chore
commits do not publish; use a reviewed `fix(deps): ...` squash title when a runtime
dependency repair needs to ship.

A manual **Run workflow** with `bootstrapStable` left false uses this same normal
release path. It still runs CI and publishes only when unreleased commits warrant
it. Do not use the one-time bootstrap to publish later versions.

## Release history

The original v2 prerelease was published as `2.0.0-alpha.0`. Its artifact, tag,
release notes, and npm `alpha` tag remain available. The historical `stable` branch
is an anchor for `0.1.0`; only `main` is configured for future releases.

The explicit `2.0.0` bootstrap establishes the real stable baseline before
semantic-release takes over. Do not invent version tags to influence version math:
starting directly from the historical `0.1.0` baseline can select `1.0.0` instead.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [semantic-release on GitHub Actions](https://semantic-release.org/recipes/ci-configurations/github-actions/).
