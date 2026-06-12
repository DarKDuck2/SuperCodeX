import { normalizeWhitespace, stripAnsi } from "../core/text.js";

export function formatFetchedPage(url: string, html: string) {
  const title = extractTagContent(html, "title");
  const description = extractMetaDescription(html);
  const text = htmlToReadableText(html);
  return [
    `URL: ${url}`,
    title ? `Title: ${title}` : "",
    description ? `Description: ${description}` : "",
    "",
    text.slice(0, 12_000)
  ].filter(Boolean).join("\n");
}

export function htmlToReadableText(html: string) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const withBreaks = withoutScripts.replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr)>/gi, "\n");
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "));
  return normalizeWhitespace(stripAnsi(text)).slice(0, 20_000);
}

export function looksLikeHtml(text: string) {
  return /<\/?[a-z][\s\S]*>/i.test(text) && /<(html|body|div|p|script|style|article|section|span|a)\b/i.test(text);
}

export function compactJsonText(text: string, limit: number) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, limit);
  } catch {
    return normalizeWhitespace(stripAnsi(text)).slice(0, limit);
  }
}

export function extractTagContent(html: string, tagName: string) {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? normalizeWhitespace(decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " "))).slice(0, 300) : "";
}

export function extractMetaDescription(html: string) {
  const match =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
  return match ? normalizeWhitespace(decodeHtmlEntities(match[1])).slice(0, 500) : "";
}

function decodeHtmlEntities(text: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : full;
    }
    return entities[entity.toLowerCase()] ?? full;
  });
}
