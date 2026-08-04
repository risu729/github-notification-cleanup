# GitHub Notification Cleanup

Keeps the GitHub notification inbox focused on pull request activity that needs
human attention.

## Behavior

The workflow runs every 10 minutes and can also be started manually. It stores
the last successful check time in a JSON state file and requests only
notifications updated since then. Use the manual workflow's `force` option to
recheck every read and unread pull request notification.

A notification is marked done when either:

- its pull request was opened by Renovate and has GitHub auto-merge enabled; or
- every attributable timeline event at or after the notification's `last_read_at`
  timestamp is from `risu729`, CodeRabbit, Greptile, or Sourcery, and at least
  one of those events is an AI comment or review.

The actor checks use immutable GitHub IDs. The current user ID is retrieved from
the authenticated `GH_TOKEN`; the AI reviewer IDs are fixed. With no read
timestamp, the entire timeline is checked. An unknown event, unattributable
actor, or activity from anyone else retains the notification. The thread is
fetched again immediately before it is marked done to reduce the chance of
hiding a concurrent update. GitHub does not provide a conditional mark-done
operation, so a narrow race remains between those two requests.

Only comments, reviews, commits, and cross-references attributable to `risu729`
are eligible for AI-review suppression. Other timeline activity retains the
notification.

Renovate pull requests without GitHub auto-merge, such as major updates that
need manual review, are only suppressed by the stricter AI-review rule. Marking
a notification as done does not modify its pull request.

## Setup

Create a personal access token (classic) with the `notifications` scope and add
it as the `RENOVATE_NOTIFICATIONS_TOKEN` Actions secret.

The `notifications` scope is sufficient when every referenced pull request is
public. Inspecting private pull requests requires the classic `repo` scope,
which grants broad repository access.

GitHub's notification endpoints do not support the built-in Actions
`GITHUB_TOKEN`, fine-grained personal access tokens, or GitHub App tokens.

## Development

Run the repository checks with:

```sh
mise run check --lint
```

Run notification triage locally with a suitable token:

```sh
GH_TOKEN=... mise run triage
```

Pass `--force` to bypass the notification-state cache.

The notification cleanup is implemented in TypeScript and runs with Bun. The
checks use [hk](https://github.com/jdx/hk) to type-check, lint, and format the
TypeScript and to validate the workflows, YAML, Markdown, and repository
hygiene.
