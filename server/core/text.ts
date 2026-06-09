export function normalizeWhitespace(text: string) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function titleFromPrompt(prompt: string) {
  return prompt.length > 22 ? `${prompt.slice(0, 22)}...` : prompt;
}
