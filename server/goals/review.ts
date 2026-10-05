export type GoalReviewDraft = {
  summary: string;
  suggestions: Array<{ title: string; instruction: string; reason: string }>;
};

export function parseGoalReviewResponse(content: string): GoalReviewDraft {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回目标复盘 JSON");
  const parsed = JSON.parse(content.slice(start, end + 1)) as {
    summary?: unknown;
    suggestions?: Array<{ title?: unknown; instruction?: unknown; reason?: unknown }>;
  };
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 2000) : "";
  if (!summary) throw new Error("目标复盘缺少总结");
  const seen = new Set<string>();
  const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
    .slice(0, 5)
    .map((item) => ({
      title: typeof item.title === "string" ? item.title.trim().slice(0, 120) : "",
      instruction: typeof item.instruction === "string" ? item.instruction.trim().slice(0, 5000) : "",
      reason: typeof item.reason === "string" ? item.reason.trim().slice(0, 500) : ""
    }))
    .filter((item) => {
      const key = item.title.toLocaleLowerCase();
      if (!item.title || !item.instruction || !item.reason || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
  return { summary, suggestions };
}
