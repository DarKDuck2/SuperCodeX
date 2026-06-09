import path from "node:path";

export function safeResolvePath(inputPath: string, basePath: string) {
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, inputPath || ".");
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Path is outside workspace: ${inputPath}`);
  }
  return resolved;
}

export function normalizeLocalPath(inputPath: string, home = process.env.HOME || "") {
  const expanded =
    inputPath === "~" || inputPath.startsWith(`~${path.sep}`)
      ? path.join(home, inputPath.slice(2))
      : inputPath;
  return path.resolve(expanded);
}

export function sanitizeFileName(value: string) {
  return path
    .basename(value)
    .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
    .replace(/^_+/, "")
    .slice(0, 160) || "attachment";
}
