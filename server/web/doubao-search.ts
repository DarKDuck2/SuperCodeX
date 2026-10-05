import type { WebSearchPayload, WebSearchResult } from "./search.js";

const endpoint = "https://open.feedcoopapi.com/search_api/web_search";
const timeRanges = new Set(["OneDay", "OneWeek", "OneMonth", "OneYear"]);

export type DoubaoSearchOptions = {
  timeRange?: string;
  authLevel?: 0 | 1;
  queryRewrite?: boolean;
};

export async function searchDoubao(
  query: string,
  count: number,
  options: DoubaoSearchOptions = {},
  fetcher: typeof fetch = fetch
): Promise<WebSearchPayload> {
  const apiKey = process.env.DOUBAO_SEARCH_API_KEY || process.env.WEB_SEARCH_API_KEY;
  if (!apiKey) throw new Error("豆包搜索 API Key 未配置");
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery.length > 100) throw new Error("豆包搜索词须为 1–100 字符");
  const body: Record<string, unknown> = {
    Query: normalizedQuery,
    SearchType: "web",
    Count: Math.max(1, Math.min(Math.floor(count), 50)),
    NeedSummary: true
  };
  if (options.timeRange) body.TimeRange = validateTimeRange(options.timeRange);
  if (options.authLevel === 1) body.Filter = { AuthInfoLevel: 1 };
  if (options.queryRewrite) body.QueryControl = { QueryRewrite: true };

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-Traffic-Tag": "supercodex_search"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`豆包搜索请求失败（HTTP ${response.status}）`);
  const payload = await response.json() as {
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
    Result?: { ResultCount?: number; WebResults?: Array<Record<string, unknown>> };
  };
  const apiError = payload.ResponseMetadata?.Error;
  if (apiError) throw new Error(`豆包搜索失败（${String(apiError.Code || "unknown")}）`);
  const results: WebSearchResult[] = (payload.Result?.WebResults || [])
    .map((item) => ({
      title: String(item.Title || ""),
      url: String(item.Url || ""),
      description: String(item.Summary || item.Snippet || "").slice(0, 1200),
      source: String(item.SiteName || ""),
      engine: "doubao"
    }))
    .filter((item) => item.title && /^https?:\/\//i.test(item.url));
  return {
    query: normalizedQuery,
    engines: ["doubao"],
    totalResults: Number(payload.Result?.ResultCount ?? results.length),
    results
  };
}

function validateTimeRange(value: string) {
  if (timeRanges.has(value)) return value;
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(match[1])) || !Number.isFinite(Date.parse(match[2])) || match[1] > match[2]) {
    throw new Error("豆包搜索时间范围须为 OneDay/OneWeek/OneMonth/OneYear 或 YYYY-MM-DD..YYYY-MM-DD");
  }
  return value;
}
