import { promises as fs } from "node:fs";
import path from "node:path";
import { safeResolvePath } from "./paths.js";

const protectedNames = new Set([
  ".supercodex", ".git", ".ssh", ".aws", ".config", ".gnupg", ".docker", ".kube",
  ".npmrc", ".netrc", ".pypirc", "secrets.json", "credentials.json", "google-calendar.json",
  "id_rsa", "id_ed25519"
]);
const harmlessEnvTemplates = new Set([".env.example", ".env.sample", ".env.template"]);

export function isProtectedAgentPath(relativePath: string) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return segments.some((raw) => {
    const name = raw.toLowerCase();
    if (protectedNames.has(name)) return true;
    if (name === ".env" || (name.startsWith(".env.") && !harmlessEnvTemplates.has(name))) return true;
    if (name.endsWith(".pem") || name.endsWith(".key")) return true;
    return false;
  });
}

export async function resolveAgentReadPath(inputPath: string, workspacePath: string) {
  const requested = safeResolvePath(inputPath, workspacePath);
  const root = await fs.realpath(workspacePath);
  const real = await fs.realpath(requested);
  assertAgentPath(requested, workspacePath);
  safeResolvePath(real, root);
  assertAgentPath(real, root);
  return requested;
}

export async function resolveAgentWritePath(inputPath: string, workspacePath: string) {
  const requested = safeResolvePath(inputPath, workspacePath);
  const root = await fs.realpath(workspacePath);
  assertAgentPath(requested, workspacePath);
  let ancestor = requested;
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      safeResolvePath(real, root);
      assertAgentPath(real, root);
      return requested;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const stat = await fs.lstat(ancestor);
        if (stat.isSymbolicLink()) throw new Error(`Path contains a dangling symlink: ${inputPath}`);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function assertAgentPath(candidate: string, root: string) {
  if (isProtectedAgentPath(path.relative(root, candidate))) {
    throw new Error("Agent tools cannot access credential or runtime state paths");
  }
}
