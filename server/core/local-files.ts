import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Attachment } from "../domain/types.js";
import type { ToolContext } from "../tools/types.js";

const execFileAsync = promisify(execFile);

export function splitCommandArgs(input: string) {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "" = "";
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in CLAUDE_CODE_ARGS");
  if (current) args.push(current);
  return args;
}

export function formatCommandForDisplay(parts: string[]) {
  return parts.map((part) => (/^[A-Za-z0-9_./:=@%+<>-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)).join(" ");
}

export function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export type GeneratedFileSnapshot = Map<string, { mtimeMs: number; size: number }>;

export async function snapshotGeneratedFiles(rootPath: string): Promise<GeneratedFileSnapshot> {
  const snapshot: GeneratedFileSnapshot = new Map();
  const ignored = new Set(["node_modules", ".git", ".supercodex", "dist", "dist-server"]);

  async function walk(currentPath: string, depth: number) {
    if (depth > 6 || snapshot.size > 2000) return;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(entryPath);
        snapshot.set(entryPath, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // Files can disappear while a command is still settling.
      }
    }
  }

  await walk(rootPath, 0);
  return snapshot;
}

export function diffGeneratedFiles(
  before: GeneratedFileSnapshot,
  after: GeneratedFileSnapshot,
  context: ToolContext
) {
  return [...after.entries()]
    .filter(([filePath, meta]) => {
      const previous = before.get(filePath);
      return !previous || previous.size !== meta.size || meta.mtimeMs > previous.mtimeMs + 1;
    })
    .map(([filePath]) => path.relative(context.workspacePath, filePath))
    .filter((filePath) => filePath && !filePath.startsWith(".."))
    .sort();
}

export function getFileResponseMetadata(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".py": "text/x-python; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };

  return {
    contentType: contentTypes[extension] || "application/octet-stream"
  };
}

export async function openLocalFile(filePath: string, action: "open" | "reveal") {
  if (process.platform === "darwin") {
    if (action === "reveal") {
      await execFileAsync("open", ["-R", filePath]);
      return;
    }
    if (isTextLikeFile(filePath)) {
      try {
        await execFileAsync("open", ["-t", filePath]);
        return;
      } catch {
        // Fall through to the normal opener before revealing in Finder.
      }
    }
    try {
      await execFileAsync("open", [filePath]);
      return;
    } catch {
      await execFileAsync("open", ["-R", filePath]);
    }
    return;
  }

  if (process.platform === "win32") {
    if (action === "reveal") {
      await execFileAsync("explorer.exe", [`/select,${filePath}`]);
      return;
    }
    await execFileAsync("explorer.exe", [filePath]);
    return;
  }

  await execFileAsync("xdg-open", [action === "reveal" ? path.dirname(filePath) : filePath]);
}

export function isTextLikeFile(filePath: string) {
  return new Set([
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".csv",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml"
  ]).has(path.extname(filePath).toLowerCase());
}

export function inferAttachmentKind(mimeType: string, fileName: string): Attachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/")) return "text";
  if (/\.(md|txt|csv|json|xml|html|css|js|jsx|ts|tsx|py|java|go|rs|rb|php|sql|yaml|yml|toml|ini|log)$/i.test(fileName)) {
    return "text";
  }
  return "file";
}

export function normalizeImageFormat(value: string): "png" | "jpeg" | "webp" {
  const normalized = value.toLowerCase().replace("jpg", "jpeg");
  if (normalized === "png" || normalized === "jpeg" || normalized === "webp") return normalized;
  return "png";
}

export async function inferTestCommand(projectPath: string) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    if (packageJson.scripts?.test && !/no test specified/i.test(packageJson.scripts.test)) {
      return "npm test";
    }
    if (packageJson.scripts?.lint) return "npm run lint";
    if (packageJson.scripts?.build) return "npm run build";
  } catch {
    // Non-JavaScript projects can provide an explicit command.
  }
  return "npm run build";
}
