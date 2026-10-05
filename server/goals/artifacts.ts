import type { Goal, GoalArtifact, GoalArtifactVersion } from "../domain/types.js";

const maxArtifacts = 12;
const maxContentChars = 30_000;
const maxHistory = 20;

export class GoalArtifactError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

export function createGoalArtifactService(deps: {
  goals: Map<string, Goal>;
  persistStore: () => Promise<void>;
  id: (prefix: string) => string;
  now: () => string;
}) {
  const locks = new Map<string, Promise<void>>();

  function getGoal(goalId: string) {
    const goal = deps.goals.get(goalId);
    if (!goal) throw new GoalArtifactError("目标不存在", 404);
    return goal;
  }

  function list(goalId: string) {
    return getGoal(goalId).artifacts || [];
  }

  async function create(goalId: string, input: { title: string; content: string; updatedBy: GoalArtifact["updatedBy"] }) {
    return serialize(goalId, async () => {
      const goal = getGoal(goalId);
      const title = validTitle(input.title);
      const content = validContent(input.content);
      if ((goal.artifacts?.length || 0) >= maxArtifacts) throw new GoalArtifactError(`每个目标最多保存 ${maxArtifacts} 份文稿`, 409);
      const previous = goal.artifacts;
      const previousUpdatedAt = goal.updatedAt;
      const artifact: GoalArtifact = { id: deps.id("artifact"), title, content, revision: 1, createdAt: deps.now(), updatedAt: deps.now(), updatedBy: input.updatedBy };
      goal.artifacts = [...(goal.artifacts || []), artifact];
      goal.updatedAt = artifact.updatedAt;
      try { await deps.persistStore(); }
      catch (error) { goal.artifacts = previous; goal.updatedAt = previousUpdatedAt; throw error; }
      return artifact;
    });
  }

  async function update(goalId: string, artifactId: string, input: { expectedRevision: number; title: string; content: string; updatedBy: GoalArtifact["updatedBy"] }) {
    return serialize(goalId, async () => {
      const goal = getGoal(goalId);
      const index = goal.artifacts?.findIndex((item) => item.id === artifactId) ?? -1;
      if (index < 0) throw new GoalArtifactError("目标文稿不存在", 404);
      const current = goal.artifacts![index];
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) throw new GoalArtifactError("文稿已被其他操作更新，请重新载入后再编辑", 409);
      const title = validTitle(input.title);
      const content = validContent(input.content);
      if (title === current.title && content === current.content) return current;
      return commitRevision(goal, index, { title, content, updatedBy: input.updatedBy });
    });
  }

  async function restore(goalId: string, artifactId: string, expectedRevision: number, sourceRevision: number) {
    return serialize(goalId, async () => {
      const goal = getGoal(goalId);
      const index = goal.artifacts?.findIndex((item) => item.id === artifactId) ?? -1;
      if (index < 0) throw new GoalArtifactError("目标文稿不存在", 404);
      const current = goal.artifacts![index];
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) throw new GoalArtifactError("文稿已被其他操作更新，请重新载入后再恢复", 409);
      const source = current.history?.find((item) => item.revision === sourceRevision);
      if (!source) throw new GoalArtifactError("所选历史版本不存在或已超出保留范围", 404);
      return commitRevision(goal, index, { title: source.title, content: source.content, updatedBy: "user", restoredFromRevision: sourceRevision });
    });
  }

  async function commitRevision(goal: Goal, index: number, input: { title: string; content: string; updatedBy: GoalArtifact["updatedBy"]; restoredFromRevision?: number }) {
    const current = goal.artifacts![index];
    const snapshot: GoalArtifactVersion = {
      revision: current.revision, title: current.title, content: current.content,
      updatedAt: current.updatedAt, updatedBy: current.updatedBy,
      restoredFromRevision: current.restoredFromRevision
    };
    const next: GoalArtifact = {
      ...current, title: input.title, content: input.content,
      revision: current.revision + 1, updatedAt: deps.now(), updatedBy: input.updatedBy,
      restoredFromRevision: input.restoredFromRevision,
      history: [snapshot, ...(current.history || [])].slice(0, maxHistory)
    };
    const previous = goal.artifacts;
    const previousUpdatedAt = goal.updatedAt;
    goal.artifacts = [...previous!];
    goal.artifacts[index] = next;
    goal.updatedAt = next.updatedAt;
    try { await deps.persistStore(); }
    catch (error) { goal.artifacts = previous; goal.updatedAt = previousUpdatedAt; throw error; }
    return next;
  }

  async function remove(goalId: string, artifactId: string, expectedRevision: number) {
    return serialize(goalId, async () => {
      const goal = getGoal(goalId);
      const current = goal.artifacts?.find((item) => item.id === artifactId);
      if (!current) throw new GoalArtifactError("目标文稿不存在", 404);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) throw new GoalArtifactError("文稿已被其他操作更新，请重新载入后再删除", 409);
      const previous = goal.artifacts;
      const previousUpdatedAt = goal.updatedAt;
      goal.artifacts = previous!.filter((item) => item.id !== artifactId);
      goal.updatedAt = deps.now();
      try { await deps.persistStore(); }
      catch (error) { goal.artifacts = previous; goal.updatedAt = previousUpdatedAt; throw error; }
    });
  }

  function serialize<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(goalId) || Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    locks.set(goalId, settled);
    void settled.then(() => { if (locks.get(goalId) === settled) locks.delete(goalId); });
    return run;
  }

  return { list, create, update, restore, remove };
}

function validTitle(value: string) {
  if (typeof value !== "string") throw new GoalArtifactError("文稿名称需为 1-120 字", 400);
  const title = value.trim();
  if (!title || title.length > 120) throw new GoalArtifactError("文稿名称需为 1-120 字", 400);
  return title;
}

function validContent(value: string) {
  if (typeof value !== "string" || value.length > maxContentChars) throw new GoalArtifactError(`文稿内容不能超过 ${maxContentChars} 字`, 400);
  return value;
}
