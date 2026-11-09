# Dependency maintenance

Dependabot checks the root npm package every Tuesday at 09:15 and GitHub Actions
at 09:45, in `America/New_York`. The npm lockfile is authoritative; run `npm ci`
and commit manifest and lockfile changes together.

Routine npm patch and minor updates are grouped separately for runtime and
development dependencies. Actions patch and minor updates form their own group.
Major updates remain individual PRs so compatibility changes can be reviewed
explicitly. In particular, review the supported Node versions before accepting
an `@types/node` major, and keep Vitest and its coverage provider compatible.

New npm releases wait 3 days for patches, 7 days for minors, and 14 days for
majors. Action updates wait 7 days. These cooldowns apply only to version
updates: security updates are grouped separately and bypass the weekly schedule
and cooldown. The five npm and three Actions PR limits do not limit security
PRs, which have GitHub's separate limit.

PRs must pass the existing Ubuntu/Windows and Node 20/22/24 CI matrix, including
typecheck, formatting, build, unit tests, CLI e2e, and package dry run. Dependency
Review also rejects newly introduced high or critical vulnerabilities in runtime,
development, or unknown scopes. It uses a read-only token and does not comment on
PRs. Updates are reviewed before merging; there is no automatic merge workflow.

Dependabot uses `chore(deps)` / `chore(deps-dev)` commit messages. Dependency
updates do not implicitly request a package release. When a runtime dependency
repair should ship, use an explicitly reviewed `fix(deps): ...` squash title;
keep development-only and Actions maintenance as chores. After the one-time
`2.0.0` stable bootstrap, conventional release commits on `main` publish to
`latest` after the full CI matrix passes. The existing `alpha` tag stays at
`2.0.0-alpha.0`. There are no changesets or release PRs. Follow
[RELEASING.md](../RELEASING.md) for bootstrap and release recovery.

Repository settings must have the dependency graph, Dependabot alerts, and
Dependabot security updates enabled; the YAML config alone does not enable
security updates. Require the matrix checks and `Dependency Review / dependency-review`
in the repository's main-branch ruleset to enforce them before merges. Do not
use `pull_request_target` or provide publishing secrets to dependency PRs.

References: [Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[Dependency Review](https://github.com/actions/dependency-review-action).
