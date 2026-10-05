import { createReadStream, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { resolveAgentReadPath } from "../core/agent-paths.js";
import { safeResolvePath } from "../core/paths.js";
import type { Goal, GoalFile, GoalFileVersion } from "../domain/types.js";
import type { ToolResult } from "../tools/types.js";

const maxGoalFiles = 200;
const maxFilesPerResult = 20;
const maxSnapshotBytes = 100 * 1024 * 1024;
const maxHistory = 20;
const kinds = new Set<GoalFile["kind"]>(["image", "file", "code", "presentation", "table"]);

export async function captureGoalFiles(input: {
  goal: Goal;
  taskId: string;
  toolName: string;
  result: Pick<ToolResult, "ok" | "artifacts">;
  workspacePath: string;
  snapshotRoot: string;
  id: (prefix: string) => string;
  now: () => string;
}) {
  if (!input.result.ok || !input.result.artifacts?.length) return [];
  const captured: GoalFile[] = [];
  const createdSnapshots: string[] = [];
  const seenPaths = new Set<string>();
  try {
    for (const artifact of input.result.artifacts.slice(0, maxFilesPerResult)) {
      if (!artifact.path) continue;
      let absolutePath: string;
      let stat: import("node:fs").Stats;
      try {
        absolutePath = await resolveAgentReadPath(artifact.path, input.workspacePath);
        stat = await fs.stat(absolutePath);
        if (!stat.isFile()) continue;
      } catch { continue; }
      const relativePath = path.relative(input.workspacePath, absolutePath);
      if (seenPaths.has(relativePath)) continue;
      seenPaths.add(relativePath);
      const existing = input.goal.files?.find((file) => file.path === relativePath);
      const timestamp = input.now();
      const title = String(artifact.title || path.basename(absolutePath)).trim().slice(0, 160) || path.basename(absolutePath);
      const fileId = existing?.id || input.id("goal-file");
      const file: GoalFile = {
        id: fileId, title, path: relativePath,
        kind: artifact.kind && kinds.has(artifact.kind) ? artifact.kind : "file",
        size: stat.size, taskId: input.taskId, toolName: input.toolName,
        createdAt: existing?.createdAt || timestamp, updatedAt: timestamp,
        revision: existing?.revision, snapshotSha256: existing?.snapshotSha256,
        history: existing?.history
      };

      if (stat.size <= maxSnapshotBytes) {
        const nextRevision = (existing?.revision || 0) + 1;
        const destination = snapshotPath(input.snapshotRoot, input.goal.id, fileId, nextRevision);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const staging = `${destination}.${randomUUID()}.tmp`;
        try {
          await fs.copyFile(absolutePath, staging);
          const copiedStat = await fs.stat(staging);
          if (copiedStat.size <= maxSnapshotBytes) {
            const sha256 = await hashFile(staging);
            file.size = copiedStat.size;
            if (existing?.snapshotSha256 === sha256) {
              await fs.rm(staging, { force: true });
            } else {
              await fs.rename(staging, destination);
              createdSnapshots.push(destination);
              await fs.chmod(destination, 0o444);
              file.revision = nextRevision;
              file.snapshotSha256 = sha256;
              file.history = previousHistory(existing);
            }
          } else {
            await fs.rm(staging, { force: true });
            file.revision = nextRevision;
            file.snapshotSha256 = undefined;
            file.history = previousHistory(existing);
          }
        } catch (error) {
          await fs.rm(staging, { force: true });
          throw error;
        }
      } else {
        file.revision = (existing?.revision || 0) + 1;
        file.snapshotSha256 = undefined;
        file.history = previousHistory(existing);
      }
      captured.push(file);
    }
  } catch (error) {
    await Promise.allSettled(createdSnapshots.map((snapshot) => fs.rm(snapshot, { force: true })));
    throw error;
  }
  if (!captured.length) return [];
  const capturedPaths = new Set(captured.map((file) => file.path));
  input.goal.files = [...captured, ...(input.goal.files || []).filter((file) => !capturedPaths.has(file.path))].slice(0, maxGoalFiles);
  input.goal.updatedAt = input.now();
  return captured;
}

export async function resolveGoalFile(goal: Goal | undefined, fileId: string, workspacePath: string, snapshotRoot: string, revision?: number) {
  const file = goal?.files?.find((item) => item.id === fileId);
  if (!goal || !file) return undefined;
  const historical = revision === undefined || revision === file.revision ? undefined : file.history?.find((item) => item.revision === revision);
  if (revision !== undefined && revision !== file.revision && !historical) return undefined;
  const selected = historical || file;
  if (selected.snapshotSha256 && selected.revision) {
    try {
      const candidate = snapshotPath(snapshotRoot, goal.id, file.id, selected.revision);
      const root = await fs.realpath(snapshotRoot);
      const absolutePath = await fs.realpath(candidate);
      safeResolvePath(absolutePath, root);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size !== selected.size || await hashFile(absolutePath) !== selected.snapshotSha256) return undefined;
      return { file, selected, absolutePath, snapshot: true };
    } catch { return undefined; }
  }
  if (historical) return undefined;
  try {
    const absolutePath = await resolveAgentReadPath(file.path, workspacePath);
    const stat = await fs.stat(absolutePath);
    return stat.isFile() ? { file, selected, absolutePath, snapshot: false } : undefined;
  } catch { return undefined; }
}

export async function rollbackGoalFileSnapshots(goalId: string, previous: GoalFile[] | undefined, captured: GoalFile[], snapshotRoot: string) {
  const created = captured.filter((file) => file.snapshotSha256 && file.revision && !previous?.some((prior) => prior.id === file.id && prior.revision === file.revision && prior.snapshotSha256 === file.snapshotSha256));
  await Promise.allSettled(created.map((file) => fs.rm(snapshotPath(snapshotRoot, goalId, file.id, file.revision!), { force: true })));
}

export async function pruneGoalFileSnapshots(goalId: string, previous: GoalFile[] | undefined, current: GoalFile[] | undefined, snapshotRoot: string) {
  const currentKeys = new Set((current || []).flatMap((file) => versions(file).map((version) => `${file.id}:${version.revision}`)));
  const removed = (previous || []).flatMap((file) => versions(file)
    .filter((version) => !currentKeys.has(`${file.id}:${version.revision}`))
    .map((version) => snapshotPath(snapshotRoot, goalId, file.id, version.revision)));
  await Promise.allSettled(removed.map((snapshot) => fs.rm(snapshot, { force: true })));
}

function previousHistory(file: GoalFile | undefined): GoalFileVersion[] {
  const current: GoalFileVersion[] = file?.snapshotSha256 && file.revision ? [{
    revision: file.revision, title: file.title, size: file.size, taskId: file.taskId,
    toolName: file.toolName, updatedAt: file.updatedAt, snapshotSha256: file.snapshotSha256
  }] : [];
  return [...current, ...(file?.history || [])].slice(0, maxHistory);
}

function versions(file: GoalFile): GoalFileVersion[] {
  const current: GoalFileVersion[] = file.snapshotSha256 && file.revision ? [{
    revision: file.revision, title: file.title, size: file.size, taskId: file.taskId,
    toolName: file.toolName, updatedAt: file.updatedAt, snapshotSha256: file.snapshotSha256
  }] : [];
  return [...current, ...(file.history || [])];
}

function snapshotPath(root: string, goalId: string, fileId: string, revision: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(goalId) || !/^[A-Za-z0-9_-]+$/.test(fileId) || !Number.isInteger(revision) || revision < 1) {
    throw new Error("Invalid goal file snapshot identity");
  }
  return path.join(root, goalId, fileId, String(revision));
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
