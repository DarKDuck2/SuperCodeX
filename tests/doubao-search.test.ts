import assert from "node:assert/strict";
import { it } from "node:test";
import { searchDoubao } from "../server/web/doubao-search.js";

it("uses a server-side key and normalizes Doubao results for the existing search tool", async () => {
  const previous = process.env.DOUBAO_SEARCH_API_KEY;
  process.env.DOUBAO_SEARCH_API_KEY = "test-secret";
  try {
    const payload = await searchDoubao("London travel", 3, { timeRange: "OneWeek", authLevel: 1, queryRewrite: true }, async (url, init) => {
      assert.equal(url, "https://open.feedcoopapi.com/search_api/web_search");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-secret");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        Query: "London travel", SearchType: "web", Count: 3, NeedSummary: true,
        TimeRange: "OneWeek", Filter: { AuthInfoLevel: 1 }, QueryControl: { QueryRewrite: true }
      });
      return new Response(JSON.stringify({ Result: { ResultCount: 1, WebResults: [{ Title: "Visit London", Url: "https://www.visitlondon.com", Summary: "Official guide", SiteName: "Visit London" }] } }), { status: 200 });
    });
    assert.equal(payload.engines[0], "doubao");
    assert.deepEqual(payload.results, [{ title: "Visit London", url: "https://www.visitlondon.com", description: "Official guide", source: "Visit London", engine: "doubao" }]);
    assert.ok(!JSON.stringify(payload).includes("test-secret"));
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_SEARCH_API_KEY;
    else process.env.DOUBAO_SEARCH_API_KEY = previous;
  }
});

it("surfaces provider errors without exposing the key", async () => {
  const previous = process.env.DOUBAO_SEARCH_API_KEY;
  process.env.DOUBAO_SEARCH_API_KEY = "test-secret";
  try {
    await assert.rejects(searchDoubao("London", 3, {}, async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: "10403", Message: "secret is invalid" } } }), { status: 200 })), /10403/);
    await assert.rejects(searchDoubao("London", 3, { timeRange: "2026-10-08..2026-10-06" }, async () => { throw new Error("should not call"); }), /时间范围/);
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_SEARCH_API_KEY;
    else process.env.DOUBAO_SEARCH_API_KEY = previous;
  }
});
