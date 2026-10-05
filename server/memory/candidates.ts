export type ProposedMemory = { content: string; quote: string; confidence: number };

const sensitive = /(?:password|passphrase|api[\s_-]*key|access[\s_-]*token|private[\s_-]*key|secret|verification[\s_-]*code|credit[\s_-]*card|cvv|密码|口令|密钥|令牌|验证码|银行卡|身份证号)/i;

export function parseMemoryCandidatesResponse(raw: string, userText: string): ProposedMemory[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); }
  catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];
  const items = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items.slice(0, 5).flatMap((item): ProposedMemory[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.content !== "string" || typeof value.quote !== "string" || typeof value.confidence !== "number") return [];
    const content = value.content.trim();
    const quote = value.quote.trim();
    if (!content || content.length > 500 || !quote || quote.length > 300 || !userText.includes(quote)) return [];
    if (value.confidence < 0.65 || value.confidence > 1 || sensitive.test(content) || sensitive.test(quote)) return [];
    const key = content.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ content, quote, confidence: value.confidence }];
  });
}
