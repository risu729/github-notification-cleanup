# GitHub Notification Cleanup

Keeps the GitHub notification inbox focused on Renovate pull requests that need
manual attention.

## Behavior

The workflow runs every 10 minutes and can also be started manually.
For each unread pull request notification, it:

1. fetches the referenced pull request;
2. confirms that its author is `renovate[bot]`;
3. checks that GitHub auto-merge is enabled; and
4. marks the notification as done.

Renovate pull requests without GitHub auto-merge, such as major updates that
need manual review, remain untouched. Marking a notification as done does not
modify its pull request.

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

The notification cleanup is implemented in TypeScript and runs with Bun. The
checks use [hk](https://github.com/jdx/hk) to type-check, lint, and format the
TypeScript and to validate the workflows, YAML, Markdown, and repository
hygiene.
