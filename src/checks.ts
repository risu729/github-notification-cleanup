import type { Octokit } from "@octokit/rest";

type CheckNotification = {
  repository: string;
  subjectTitle: string;
  subjectType: string;
  subjectUrl: string;
};

export const isCheckSubjectType = (value: string): value is "CheckRun" | "CheckSuite" => {
  return value === "CheckRun" || value === "CheckSuite";
};

const failedConclusions = new Set(["failure", "startup_failure", "timed_out"]);

export const isFailedCheckNotification = async (
  notification: CheckNotification,
  octokit: Octokit,
): Promise<boolean> => {
  if (!isCheckSubjectType(notification.subjectType)) {
    return false;
  }

  // Actions can omit the check URL. Its generated failure title identifies the notification.
  if (
    notification.subjectType === "CheckSuite" &&
    /^.+ workflow run(?:, Attempt #\d+)? failed for .+ branch$/.test(notification.subjectTitle)
  ) {
    return true;
  }

  const url = new URL(notification.subjectUrl);
  const match = /^\/repos\/([^/]+)\/([^/]+)\/(check-suites|check-runs)\/(\d+)$/.exec(url.pathname);
  if (url.origin !== "https://api.github.com" || match === null) {
    return false;
  }
  const [, owner, repo, resource, rawId] = match;
  const id = Number(rawId);
  if (
    owner === undefined ||
    repo === undefined ||
    `${owner}/${repo}`.toLowerCase() !== notification.repository.toLowerCase() ||
    !Number.isSafeInteger(id) ||
    id <= 0
  ) {
    return false;
  }
  const { data } =
    resource === "check-suites"
      ? await octokit.rest.checks.getSuite({ check_suite_id: id, owner, repo })
      : await octokit.rest.checks.get({ check_run_id: id, owner, repo });
  return (
    data.status === "completed" &&
    data.conclusion !== null &&
    failedConclusions.has(data.conclusion)
  );
};
