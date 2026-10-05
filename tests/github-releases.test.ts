import assert from "node:assert/strict";
import { it } from "node:test";
import { fetchGitHubReleases, GitHubReleaseError, normalizeGitHubRepo } from "../server/connectors/github-releases.js";

it("reads a fixed GitHub API endpoint and validates release links", async () => {
  let requestedUrl = "";
  let requestHeaders: Headers | undefined;
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return Response.json([
      { id: 2, tag_name: "v2", name: "Release 2", html_url: "https://evil.example/steal" },
      { id: 1, tag_name: "v1", name: "Release 1", html_url: "https://github.com/Example/Repo/releases/tag/v1" }
    ], { headers: { etag: '"releases-v2"' } });
  };
  const result = await fetchGitHubReleases("Example/Repo", undefined, fakeFetch as typeof fetch);
  assert.equal(requestedUrl, "https://api.github.com/repos/example/repo/releases?per_page=20");
  assert.equal(requestHeaders?.get("accept"), "application/vnd.github+json");
  assert.equal(result.releases[0].url, "https://github.com/example/repo/releases/tag/v2");
  assert.equal(result.releases[1].url, "https://github.com/Example/Repo/releases/tag/v1");
  assert.equal(result.etag, '"releases-v2"');
  assert.throws(() => normalizeGitHubRepo("https://example.com/private"), /owner\/repo/);
});

it("uses ETag for unchanged releases", async () => {
  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("if-none-match"), '"old"');
    return new Response(null, { status: 304 });
  };
  const result = await fetchGitHubReleases("example/repo", '"old"', fakeFetch as typeof fetch);
  assert.deepEqual(result, { releases: [], etag: '"old"', notModified: true });
});

it("backs off when GitHub reports a rate limit", async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  const fakeFetch = async () => new Response(null, { status: 403, headers: { "x-ratelimit-reset": String(reset) } });
  await assert.rejects(fetchGitHubReleases("example/repo", undefined, fakeFetch as typeof fetch), (error: unknown) => {
    assert.ok(error instanceof GitHubReleaseError);
    assert.equal(error.retryAt, new Date(reset * 1000).toISOString());
    return true;
  });
});
