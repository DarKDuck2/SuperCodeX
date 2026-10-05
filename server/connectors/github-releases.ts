export type GitHubRelease = { id: number; tag: string; title: string; url: string };
export type GitHubReleaseResult = { releases: GitHubRelease[]; etag?: string; notModified: boolean };

export class GitHubReleaseError extends Error {
  constructor(message: string, readonly retryAt?: string) { super(message); }
}

export function normalizeGitHubRepo(value: string) {
  const repo = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.includes("..")) {
    throw new Error("GitHub 仓库需填写 owner/repo，例如 openai/openai-node");
  }
  return repo.toLowerCase();
}

export async function fetchGitHubReleases(repo: string, etag?: string, fetcher: typeof fetch = fetch): Promise<GitHubReleaseResult> {
  const normalized = normalizeGitHubRepo(repo);
  const [owner, name] = normalized.split("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=20`;
  const response = await fetcher(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "SuperCodex",
      ...(etag ? { "If-None-Match": etag } : {})
    }
  });
  const nextEtag = response.headers.get("etag") || etag;
  if (response.status === 304) return { releases: [], etag: nextEtag, notModified: true };
  if (!response.ok) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const retryAt = (response.status === 403 || response.status === 429) && Number.isFinite(reset) && reset > Date.now() / 1000
      ? new Date(reset * 1000).toISOString() : undefined;
    throw new GitHubReleaseError(response.status === 404 ? "公开仓库不存在或没有访问权限" : `GitHub Release 请求失败（HTTP ${response.status}）`, retryAt);
  }
  const raw = await readLimitedBody(response, 2_000_000);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("GitHub Release 响应格式无效");
  const releases = parsed.flatMap((item): GitHubRelease[] => {
    if (!item || typeof item !== "object") return [];
    const release = item as Record<string, unknown>;
    if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || typeof release.tag_name !== "string") return [];
    const tag = release.tag_name.slice(0, 120);
    const fallbackUrl = `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(tag)}`;
    let releaseUrl = fallbackUrl;
    if (typeof release.html_url === "string") {
      try {
        const candidate = new URL(release.html_url);
        if (candidate.protocol === "https:" && candidate.hostname === "github.com" && candidate.pathname.toLowerCase().startsWith(`/${normalized}/releases/`)) releaseUrl = candidate.href;
      } catch { /* Use the canonical repository link. */ }
    }
    return [{ id: Number(release.id), tag, title: String(release.name || tag).replace(/\s+/g, " ").slice(0, 200), url: releaseUrl }];
  });
  return { releases, etag: nextEtag, notModified: false };
}

async function readLimitedBody(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("GitHub Release 响应过大");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf-8");
}
