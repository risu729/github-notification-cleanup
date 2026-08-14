# GitHub Notification Cleanup

Keeps the GitHub notification inbox focused on pull request activity that needs
human attention.

## Behavior

A Cloudflare Worker polls GitHub every 10 minutes and publishes pull request
notifications to a Cloudflare Queue. Queue consumers evaluate at most three
notifications per invocation with one concurrent consumer. This isolates the
external requests for each small batch under the Workers Free plan's
subrequest limit while allowing bursts to drain independently of the polling
schedule.

Each notification has a budget of 15 GitHub requests. An unusually large
timeline that reaches the budget is retained for manual attention instead of
risking the entire batch. Octokit does not retry inside an invocation. Transient
GitHub failures retry the individual Queue message with exponential backoff;
after seven retries, Cloudflare moves it to the dead-letter queue. Its consumer
records a final `retry_exhausted` audit before acknowledging the message.
Existing D1 retry rows are moved to the Queue as they become due after
deployment.

The Worker stores its checkpoint, append-only discovery and consumer runs, and
per-pull-request outcomes in Cloudflare D1. Runs are recorded as successful,
partial, or failed. Audit rows include the notification ID, repository, pull
request number, decision, and GitHub error diagnostics when applicable. This
history can support a read-only status UI later without depending on sampled
Worker logs. A partial consumer run means at least one message was scheduled
for another Queue delivery.

The checkpoint is only an optimization: a missing or invalid value causes the
Worker to safely inspect all read and unread notifications. Incremental scans
start 10 minutes before the previous checkpoint so notifications that appear
late in GitHub's API are still discovered even when their `updated_at` value is
older than the checkpoint. The D1 state also reserves a queued full-check flag
for a future control UI. Once requested, it remains queued after a systemic
failure and is consumed after a successful or partial scan.

A notification is marked done when any of these rules match:

- its pull request was opened by Renovate and either has GitHub auto-merge
  enabled or has already been merged; or
- its head branch begins with `release` in any `jdx/*` or `risu729/*`
  repository; or
- its pull request is open in `jdx/*` and was authored by someone other than
  the authenticated user; or
- every attributable activity in the notification window is otherwise ignorable
  and at least one is a `github-actions[bot]` PR auto-close warning in a `jdx/*`
  repository; or
- every attributable activity in the notification window is otherwise ignorable
  and at least one is a comment from `cloudflare-workers-and-pages[bot]`; or
- every attributable activity in the notification window is otherwise ignorable
  and at least one is a merge by `jdx` of the authenticated user's pull request
  in a `jdx/*` repository; or
- every attributable activity in the notification window is from the
  authenticated user or a configured bot, and at least one is a configured bot
  comment or review.

Release pull request suppression relies only on the head branch name. Titles,
labels, and authors vary across the supported repositories and are not checked.

Open pull requests in `jdx/*` are suppressed regardless of whether they are
drafts or ready for review when their known author ID differs from the
authenticated user's ID. Closed pull requests and pull requests with an unknown
author are retained by this rule.

The actor checks use immutable GitHub IDs. The current user ID is retrieved from
the authenticated `GH_TOKEN`; the automation and bot IDs are fixed.
The notification window covers the five minutes ending at the notification's
`updated_at` timestamp. This accounts for GitHub updating a notification shortly
after its causal event and keeps read notifications classifiable. Activity
outside that window is ignored. Within the window, activity attributed to the
authenticated user is ignored, while unattributable activity or activity from
anyone else retains the notification unless explicitly allowed. The thread is
fetched again immediately before it is marked done to reduce the chance of
hiding a concurrent update. GitHub does not provide a conditional mark-done
operation, so a narrow race remains between those two requests.

Comments and reviews by CodeRabbit, Greptile, Sourcery, `mise-en-dev`, and
`BrewTestBot` trigger bot-review suppression. Cross-references by those bots are
ignored as supporting activity but do not trigger suppression by themselves.
Commits must be attributable to the authenticated user; other timeline activity
retains the notification.

In `jdx/*`, a merge by `jdx` and a close by `jdx` with the exact same timestamp
are ignored as a pair only when the pull request was authored by the
authenticated user. Pull requests by other authors and closes without that
matching merge remain blocking.

Cloudflare deployment comments are recognized by the immutable
`cloudflare-workers-and-pages[bot]` ID. Other actors and non-comment events,
including merge and close events, retain the notification.

PR auto-close warnings are recognized by the `<!-- pr-closer-warning` marker
emitted by `jdx/pr-closer` and the immutable `github-actions[bot]` ID. The
unmarked auto-close comment and the subsequent `closed` event are retained.

Open Renovate pull requests without GitHub auto-merge, such as major updates
that need manual review, are only suppressed by the stricter bot-review rule.
Merged Renovate pull requests are suppressed regardless of who performed the
merge; merely closed Renovate pull requests are retained.
Marking a notification as done does not modify its pull request.

## Setup

Create a personal access token (classic) with the `notifications` scope and add
it as the `RENOVATE_NOTIFICATIONS_TOKEN` Actions secret. GitHub Actions remains
the source of truth for this credential and uploads it as the Worker's
`GH_TOKEN` secret with every deployment.

The `notifications` scope is sufficient when every referenced pull request is
public. Inspecting private pull requests requires the classic `repo` scope,
which grants broad repository access.

GitHub's notification endpoints do not support the built-in Actions
`GITHUB_TOKEN`, fine-grained personal access tokens, or GitHub App tokens.

Worker deployments also use the `CLOUDFLARE_ACCOUNT_ID` Actions variable and
the `CLOUDFLARE_API_TOKEN` Actions secret. The deployment creates the primary
and dead-letter queues when absent. Restrict the Cloudflare token to the target
account with these permissions:

- `Workers Scripts: Edit`
- `D1: Edit`

The D1 permission allows the deployment workflow to apply versioned database
migrations before deploying the Worker. The database binding gives the Worker
direct access without a separate API credential or network request.

## Development

Run the repository checks with:

```sh
mise run check --lint
```

Create `.dev.vars` with a suitable token for local Worker development:

```dotenv
GH_TOKEN=...
```

Then start Wrangler's local scheduled-handler environment:

```sh
bun run wrangler dev --test-scheduled
```

Invoke the local scheduled handler with:

```sh
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

The notification cleanup is implemented in TypeScript and runs on Cloudflare
Workers. Tests use Cloudflare's Vitest integration. The checks use
[hk](https://github.com/jdx/hk) to type-check, lint, and format the TypeScript
and to validate the workflows, YAML, Markdown, and repository hygiene.
