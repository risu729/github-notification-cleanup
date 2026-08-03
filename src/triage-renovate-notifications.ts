const apiOrigin = "https://api.github.com";

interface Notification {
  id: string;
  subject: {
    type: string;
    url: string | null;
  };
}

interface PullRequest {
  autoMergeEnabled: boolean;
  author: string;
  htmlUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNotification(value: unknown): Notification {
  if (!isRecord(value)) {
    throw new Error("GitHub returned an invalid notification");
  }

  const id = value["id"];
  if (typeof id !== "string" || !/^\d+$/.test(id)) {
    throw new Error("GitHub returned an invalid notification");
  }

  const subject = value["subject"];
  if (
    !isRecord(subject) ||
    typeof subject["type"] !== "string" ||
    !(typeof subject["url"] === "string" || subject["url"] === null)
  ) {
    throw new Error(`GitHub returned an invalid subject for notification ${id}`);
  }

  return {
    id,
    subject: {
      type: subject["type"],
      url: subject["url"],
    },
  };
}

function parsePullRequest(value: unknown): PullRequest {
  if (!isRecord(value)) {
    throw new Error("GitHub returned an invalid pull request");
  }

  const user = value["user"];
  const autoMerge = value["auto_merge"];
  const htmlUrl = value["html_url"];
  if (!isRecord(user) || typeof user["login"] !== "string") {
    throw new Error("GitHub returned a pull request without a valid author");
  }
  if (!("auto_merge" in value) || !(autoMerge === null || isRecord(autoMerge))) {
    throw new Error("GitHub returned an invalid auto-merge state");
  }
  if (typeof htmlUrl !== "string") {
    throw new Error("GitHub returned a pull request without a valid URL");
  }

  return {
    autoMergeEnabled: autoMerge !== null,
    author: user["login"],
    htmlUrl,
  };
}

function nextPage(linkHeader: string | null): string | undefined {
  if (linkHeader === null) {
    return undefined;
  }

  for (const link of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(link);
    if (match?.[2]?.split(" ").includes("next")) {
      return match[1];
    }
  }

  return undefined;
}

function apiUrl(pathOrUrl: string): URL {
  const url = new URL(pathOrUrl, apiOrigin);
  if (url.origin !== apiOrigin) {
    throw new Error(`Refusing to send credentials to ${url.origin}`);
  }
  return url;
}

async function request(pathOrUrl: string, token: string, method = "GET"): Promise<Response> {
  const response = await fetch(apiUrl(pathOrUrl), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-notification-cleanup",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    method,
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${method} ${response.url} (${response.status})`);
  }

  return response;
}

async function getUnreadNotifications(token: string): Promise<Notification[]> {
  const notifications: Notification[] = [];
  let page: string | undefined = "/notifications?all=false&per_page=100";

  while (page !== undefined) {
    const response = await request(page, token);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw new Error("GitHub returned an invalid notifications response");
    }
    notifications.push(...value.map(parseNotification));
    page = nextPage(response.headers.get("link"));
  }

  return notifications;
}

function validatePullRequestUrl(subjectUrl: string): string {
  const url = apiUrl(subjectUrl);
  if (!/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname)) {
    throw new Error(`Refusing unexpected pull request URL: ${url}`);
  }
  return url.href;
}

async function main(): Promise<void> {
  const token = Bun.env["GH_TOKEN"];
  if (!token) {
    throw new Error("GH_TOKEN is required");
  }

  for (const notification of await getUnreadNotifications(token)) {
    if (notification.subject.type !== "PullRequest" || notification.subject.url === null) {
      continue;
    }

    const pullRequestUrl = validatePullRequestUrl(notification.subject.url);
    const response = await request(pullRequestUrl, token);
    const pullRequest = parsePullRequest(await response.json());

    if (pullRequest.author !== "renovate[bot]" || !pullRequest.autoMergeEnabled) {
      continue;
    }

    await request(`/notifications/threads/${notification.id}`, token, "DELETE");
    console.log(`Marked done: ${pullRequest.htmlUrl}`);
  }
}

await main();
