import type { MemoryFact } from "../domain/types.js";

type MemoryQuery = { query: string; goalId?: string; limit?: number; maxChars?: number };

export function selectRelevantMemories(memories: Iterable<MemoryFact>, input: MemoryQuery): MemoryFact[] {
  const visible = [...memories].filter((memory) =>
    memory.useMode !== "private" && (memory.scope === "personal" || (input.goalId && memory.goalId === input.goalId))
  );
  const queryTerms = terms(input.query.slice(0, 8000));
  const scored = visible.flatMap((memory) => {
    const mode = memory.useMode || "relevant";
    const memoryTerms = terms(memory.content);
    let overlap = 0;
    for (const term of memoryTerms) if (queryTerms.has(term)) overlap += term.length >= 3 ? 3 : 2;
    const score = mode === "always" ? 100 + overlap : memory.scope === "goal" ? 50 + overlap : overlap;
    return score > 0 ? [{ memory, score }] : [];
  });
  scored.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const selected: MemoryFact[] = [];
  const limit = Math.max(1, Math.min(input.limit || 12, 30));
  const maxChars = Math.max(100, Math.min(input.maxChars || 3000, 8000));
  let used = 0;
  for (const item of scored) {
    if (selected.length >= limit) break;
    if (used + item.memory.content.length > maxChars) continue;
    selected.push(item.memory);
    used += item.memory.content.length;
  }
  return selected;
}

function terms(value: string) {
  const result = new Set<string>();
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    const token = match[0];
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 2 && !/^(the|and|for|with|from|this|that|please|you|your|our|are|was)$/.test(token)) result.add(token);
      continue;
    }
    if (token.length === 2) result.add(token);
    for (let index = 0; index < token.length - 1; index++) result.add(token.slice(index, index + 2));
    for (let index = 0; index < token.length - 2; index++) result.add(token.slice(index, index + 3));
  }
  return result;
}
