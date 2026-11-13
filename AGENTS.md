# Agent Instructions

This repository is a Cloudflare Worker that marks GitHub notifications done when
they need no human attention. [README.md](README.md) describes its behavior and
setup; keep it accurate when behavior changes.

## Language

Use English for everything published to GitHub: repository files, code comments,
commit messages, branch names, and the titles, descriptions and comments of pull
requests and issues. Do not translate existing content only to change its
language. Preserve intentional localizations, locale-specific fixtures, quoted
source text, and data whose exact wording is required for correctness.

## Development

`mise install` installs the pinned tools, and mise installs Bun dependencies
automatically (`[deps.bun]` in [`mise.toml`](mise.toml)).

| Task | Command |
| --- | --- |
| Lint and format with fixes | `mise run check` |
| Lint without fixes | `mise run check --lint` |
| Unit tests | `mise run test` |
| Build the production Worker | `mise run worker:build` |
| Validate the build without uploading | `mise run worker:dry-run` |

`check` and `test` first generate Worker types with `cf workers types`.

## Deployment

Merging to `main` deploys production when the change touches the Worker.
[`worker-deploy.yml`](.github/workflows/worker-deploy.yml) runs on pushes to
`main` that touch one of its `paths` (sources, scripts, migrations, Worker
configuration, `tasks.toml`, `mise.toml`, `package.json`, `bun.lock` and the
workflow itself; not `mise.lock`). It repeats the checks and tests, validates
the build, creates missing Queues, applies pending D1 migrations from
[`migrations/`](migrations), and deploys. Migrations run before the new Worker,
so a migration must keep the currently deployed Worker working.

## Change Workflow

- Keep one scope per pull request.
- Branch from the latest `main`, or from a prerequisite PR's branch when
  stacking under the global agent rules. Do not push to `main` directly.
- Write commit messages and PR titles as Conventional Commits, for example
  `fix: retry notifications changed during evaluation` or
  `chore(deps): update dependency hk to v2.12.0`.
- Pull requests are squash-merged. GitHub uses the PR title as the squash commit
  subject only for multi-commit PRs; a single-commit PR keeps its commit
  subject, and the commit body is the concatenated commit messages, not the PR
  description. When merging, set the squash commit subject to the PR title.
- Every PR not opened by Renovate, including documentation-only PRs, needs a
  review by a reviewer that did not write the change (for an agent-authored PR,
  a separate review agent) before merging. Address each finding and summarize
  the review in the PR description.
- Before merging, wait until every CI job has finished. The required `CI Check`
  job runs only to fail when another job failed or was cancelled, so it shows as
  skipped when everything passed. CodeQL is also required. Never skip, disable
  or weaken a test or check to get CI green.
- Do not write an ADR, code or a PR for a design still under discussion with the
  owner. Propose it to the owner first and start only after explicit approval.
- Branches of merged PRs are deleted automatically. Delete branches of closed or
  abandoned PRs and other stale branches you created; leave `renovate/*`
  branches to Renovate.
- Merging to `main` can deploy production (see [Deployment](#deployment)).

## Design Decisions

Record every design decision in this repository. Nothing should live only in a
chat, an issue thread or agent memory.

- Large decisions get an ADR at `docs/adr/NNNN-kebab-case-title.md`, numbered
  from `0001`, with Status, Context, Decision and Consequences sections. The
  status of a new ADR is `Accepted (YYYY-MM-DD)`, since designs under discussion
  are not written down yet. A replaced ADR stays in place with its status set to
  `Superseded by NNNN`.
- Smaller decisions go in the `docs/` page, README section or AGENTS.md section
  that owns the behavior.
- Rules for agents live in this file only. Do not add `CLAUDE.md` or other
  agent-specific instruction files.
- Recorded decisions are the current design and stay in force until a change is
  approved. They are not proof that the design is right: when a better design
  exists, propose it with its reasoning.

## External Tools

This repository depends heavily on mise, hk, Renovate, Bun and Cloudflare's `cf`
and `wrangler` CLIs. When their behavior matters and is unclear, read their
source code at the version in use (`mise.toml`, `mise.lock`, `package.json` and
`bun.lock`) instead of guessing or relying on documentation alone. Cite the file
and line you relied on, as a permalink at the tag or commit of that version (or
the npm package version when there is no tag), in the PR or document that
depends on it.

## Related Repositories

These repositories are maintained together. The shared configuration
repositories release independently; consumers pin a released version, and
Renovate updates the pin.

- [renovate-config](https://github.com/risu729/renovate-config) provides the
  Renovate preset. Consumers extend it in `.github/renovate.json5`, for example
  `extends: ["github>risu729/renovate-config#3.23.2"]`.
- [hk-config](https://github.com/risu729/hk-config) provides hk `presets.pkl`
  and `helpers.pkl`. Consumers amend and import them in `hk.pkl` by tagged URL,
  for example
  `https://raw.githubusercontent.com/risu729/hk-config/v3.1.0/presets.pkl`.
- [tsconfigs](https://github.com/risu729/tsconfigs) provides the npm package
  `@risu729/tsconfigs`. Consumers pin it in `package.json`, for example
  `"@risu729/tsconfigs": "3.0.1"`, and extend it from `tsconfig.json`.

[dotfiles](https://github.com/risu729/dotfiles) and
[github-notification-cleanup](https://github.com/risu729/github-notification-cleanup)
consume all three. The shared repositories also consume each other:
renovate-config uses hk-config and tsconfigs, tsconfigs uses renovate-config and
hk-config, and hk-config uses renovate-config.

## Renovate Pull Requests

Monitoring open Renovate PRs in all five repositories listed above is part of
maintaining them.

The [shared preset][preset] (consumers pin a release of it, so check the pinned
tag when it differs from `main`) waits one day after a timestamped release
(`minimumReleaseAge`), except for `risu729/**` and `@risu729/**` packages. It
automerges minor, patch, pin, digest and lock file maintenance updates, and
every update of mise itself, including majors, since mise uses CalVer. Renovate
merges them itself after checks pass (`platformAutomerge: false`). A Renovate PR
that stays open usually has a failing check or is a major update.

When a Renovate PR fails, find the root cause instead of retrying. The same
update often lands in several of the repositories at once, for example a shared
dev tool such as hk, oxlint or mise. Check the same update in the other
repositories, fix the cause once, and apply the same fix to every affected
repository. When the cause is in a shared configuration repository, fix it there
with a `fix:` or `feat:` commit so that a release is published; consumers
receive it through the Renovate update of their pin.

[preset]: https://github.com/risu729/renovate-config/blob/main/src/default.json5
