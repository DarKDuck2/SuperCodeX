import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWhitespace, stripAnsi } from "../core/text.js";
import {
  compactJsonText,
  extractMetaDescription,
  extractTagContent,
  htmlToReadableText,
  looksLikeHtml
} from "./readability.js";

const execFileAsync = promisify(execFile);

export type WebSearchResult = {
  title: string;
  url: string;
  description?: string;
  source?: string;
  engine?: string;
};

export type WebSearchPayload = {
  query: string;
  engines: string[];
  totalResults: number;
  results: WebSearchResult[];
  partialFailures?: unknown[];
};

export type WebSearchOptions = {
  engines?: string[];
  searchMode?: "request" | "auto" | "playwright";
};

export type RankedWebSearchResult = WebSearchResult & {
  rankScore: number;
  domain: string;
  matchedTerms: string[];
  qualitySignals: string[];
  fetched?: {
    title?: string;
    description?: string;
    excerpt: string;
  };
  fetchError?: string;
};

const supportedSearchEngines = new Set(["bing", "duckduckgo", "exa", "brave", "baidu", "csdn", "linuxdo", "juejin", "startpage", "sogou"]);
const defaultSearchEngines = ["bing", "duckduckgo", "brave"];

export async function openWebSearch(workspaceRoot: string, query: string, limit: number, options: WebSearchOptions = {}): Promise<WebSearchPayload> {
  const binPath = path.join(workspaceRoot, "node_modules", ".bin", "open-websearch");
  const args = ["search", query, "--limit", String(Math.max(1, Math.min(limit, 50))), "--json"];
  if (options.engines?.length) args.push("--engines", options.engines.join(","));
  if (options.searchMode && options.searchMode !== "auto") args.push("--search-mode", options.searchMode);
  const { stdout, stderr } = await execFileAsync(
    binPath,
    args,
    {
      cwd: workspaceRoot,
      timeout: 45_000,
      maxBuffer: 1024 * 1024 * 4,
      env: {
        ...process.env,
        OPEN_WEBSEARCH_DAEMON_ACTION_TIMEOUT_MS: "20000"
      }
    }
  );
  const envelope = parseOpenWebSearchJson(stdout || stderr);
  if (envelope.status !== "ok") {
    throw new Error(envelope.error?.message ?? "open-websearch failed");
  }
  return envelope.data as WebSearchPayload;
}

export function parseSearchEngines(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : process.env.SEARCH_WEB_ENGINES?.split(",");
  const engines = (raw || defaultSearchEngines)
    .map((engine) => String(engine).trim().toLowerCase())
    .filter((engine, index, array) => supportedSearchEngines.has(engine) && array.indexOf(engine) === index);
  return engines.length ? engines : defaultSearchEngines;
}

export function parseSearchMode(value: unknown): WebSearchOptions["searchMode"] {
  if (value === "request" || value === "auto" || value === "playwright") return value;
  const envValue = process.env.SEARCH_WEB_MODE;
  return envValue === "request" || envValue === "auto" || envValue === "playwright" ? envValue : undefined;
}

export function rankWebSearchResults(query: string, results: WebSearchResult[]): RankedWebSearchResult[] {
  const terms = tokenizeSearchQuery(query);
  const seen = new Set<string>();
  return results
    .map((result) => enrichSearchResult(result, terms))
    .filter((result) => {
      const key = canonicalResultKey(result.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}

export async function attachFetchedExcerpts(results: RankedWebSearchResult[], fetchTop: number) {
  const targets = results.slice(0, fetchTop);
  await Promise.all(
    targets.map(async (result) => {
      try {
        result.fetched = await fetchReadablePageExcerpt(result.url);
        result.rankScore += 6;
        result.qualitySignals.push("content-fetched");
      } catch (error) {
        result.fetchError = error instanceof Error ? error.message : String(error);
      }
    })
  );
}

function enrichSearchResult(result: WebSearchResult, terms: string[]): RankedWebSearchResult {
  const domain = domainFromUrl(result.url);
  const text = `${result.title} ${result.description || ""} ${domain}`.toLowerCase();
  const matchedTerms = terms.filter((term) => text.includes(term));
  const qualitySignals: string[] = [];
  let score = 10 + matchedTerms.length * 8;

  if (result.title && terms.some((term) => result.title.toLowerCase().includes(term))) score += 8;
  if (result.description && terms.some((term) => result.description!.toLowerCase().includes(term))) score += 4;
  if (/\.(gov|edu)(\.[a-z]{2})?$/i.test(domain)) {
    score += 18;
    qualitySignals.push("government-or-education-domain");
  }
  if (/(^|\.)((docs|developer|developers|support|help|learn)\.)/.test(domain) || /\/(docs|documentation|developer|developers|blog|news|press|releases)\b/i.test(result.url)) {
    score += 12;
    qualitySignals.push("documentation-or-official-section");
  }
  if (/\b(official|官网|官方|docs|documentation|release|announcement|公告|发布)\b/i.test(`${result.title} ${result.description || ""}`)) {
    score += 8;
    qualitySignals.push("official-or-announcement-language");
  }
  if (/\b(20[2-9][0-9]|today|yesterday|latest|最新|今天|昨日|昨天)\b/i.test(`${result.title} ${result.description || ""}`)) {
    score += 4;
    qualitySignals.push("freshness-language");
  }
  if (/(baike\.baidu\.com|wikipedia\.org|zhihu\.com|csdn\.net|blog\.csdn\.net|jianshu\.com|medium\.com|apifox\.com|openai\.ac\.cn)/i.test(domain)) {
    score -= 8;
    qualitySignals.push("secondary-or-seo-prone-domain");
  }
  if (/(utm_|spm=|ref=|source=)/i.test(result.url)) score -= 2;
  if (result.engine) qualitySignals.push(`engine:${result.engine}`);

  return {
    ...result,
    domain,
    matchedTerms,
    qualitySignals,
    rankScore: Math.max(0, Math.round(score))
  };
}

function tokenizeSearchQuery(query: string) {
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]+/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  return [...new Set(normalized.filter((term) => term.length > 1 && !/^(the|and|for|with|what|when|怎么|如何|什么|一个)$/.test(term)))].slice(0, 12);
}

function canonicalResultKey(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|spm|ref|source|fbclid|gclid)/i.test(key)) parsed.searchParams.delete(key);
    }
    const pathName = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${pathName}${parsed.search}`;
  } catch {
    return "";
  }
}

function domainFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function fetchReadablePageExcerpt(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("unsupported URL scheme");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "SuperCodex search verifier (+local research tool)"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (contentType.includes("application/json")) {
      return { excerpt: compactJsonText(text, 1800) };
    }
    if (!contentType.includes("text/html") && !looksLikeHtml(text)) {
      return { excerpt: normalizeWhitespace(stripAnsi(text)).slice(0, 1800) };
    }
    const title = extractTagContent(text, "title");
    const description = extractMetaDescription(text);
    const excerpt = htmlToReadableText(text).slice(0, 2200);
    if (!excerpt) throw new Error("no readable text extracted");
    return { title, description, excerpt };
  } finally {
    clearTimeout(timeout);
  }
}

function parseOpenWebSearchJson(output: string) {
  const start = output.lastIndexOf("\n{");
  const jsonText = (start >= 0 ? output.slice(start + 1) : output.slice(output.indexOf("{"))).trim();
  if (!jsonText) throw new Error("open-websearch returned no JSON");
  return JSON.parse(jsonText) as {
    status: "ok" | "error";
    data: unknown;
    error?: { message?: string };
  };
}
