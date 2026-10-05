import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStateService } from "../server/state/store.js";
import { openSqliteState } from "../server/state/sqlite.js";
import { ToolRegistry } from "../server/tools/registry.js";
import type { Approval, Attachment, Automation, Conversation, Goal, MemoryCandidate, MemoryFact, Project, Skill, Store } from "../server/domain/types.js";

const emptyStore: Store = {
  settings: { baseUrl: "https://example.test/v1", model: "example-model" },
  projects: [], conversations: [], skills: [], automations: [], goals: [], approvals: [], memories: [], memoryCandidates: [], attachments: []
};

describe("SQLite state", () => {
  it("commits entity snapshots and prevents another live process from overwriting them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-sqlite-"));
    const file = path.join(dir, "state.sqlite");
    let first: ReturnType<typeof openSqliteState> | undefined;
    let reopened: ReturnType<typeof openSqliteState> | undefined;
    try {
      first = openSqliteState(file);
      assert.equal(first.loadSnapshot(), undefined);
      first.replaceSnapshot({ ...emptyStore, attention: { mode: "all", readIds: ["goal:event_1"] }, projects: [{ id: "project_1", name: "持久项目", conversations: [] }] });
      assert.equal(first.loadSnapshot()?.projects[0]?.name, "持久项目");
      assert.throws(() => first!.replaceSnapshot({
        ...emptyStore,
        projects: [{ id: "project_1", name: "不应提交", conversations: [] }],
        attachments: [{ id: "" } as Attachment]
      }), /Invalid attachments entity ID/);
      assert.equal(first.loadSnapshot()?.projects[0]?.name, "持久项目");
      assert.throws(() => openSqliteState(file), /already running/);
      first.close();
      first = undefined;
      reopened = openSqliteState(file);
      assert.equal(reopened.loadSnapshot()?.projects[0]?.id, "project_1");
      assert.deepEqual(reopened.loadSnapshot()?.attention, { mode: "all", readIds: ["goal:event_1"] });
      reopened.replaceSnapshot(emptyStore);
      assert.equal(reopened.loadSnapshot()?.projects.length, 0);
      reopened.close();
      reopened = undefined;
      const raw = new DatabaseSync(file);
      assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
      raw.prepare("INSERT INTO runtime_lease (name, owner, pid, host, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run("server", "expired-owner", process.pid, os.hostname(), Date.now() - 1);
      assert.throws(() => openSqliteState(file), /already running/);
      raw.prepare("UPDATE runtime_lease SET pid = ? WHERE name = ?").run(2147483647, "server");
      raw.close();
      reopened = openSqliteState(file);
      assert.equal(reopened.loadSnapshot()?.projects.length, 0);
    } finally {
      first?.close();
      reopened?.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("imports legacy JSON once and keeps the database authoritative thereafter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-legacy-import-"));
    const dataDir = path.join(dir, ".supercodex");
    await fs.mkdir(dataDir);
    const legacyFile = path.join(dataDir, "state.json");
    const legacy: Store = {
      ...emptyStore,
      settings: { baseUrl: "https://example.test/v1", model: "legacy-model", apiKey: "legacy-secret" },
      projects: [{ id: "legacy_project", name: "旧项目", conversations: [] }]
    };
    await fs.writeFile(legacyFile, JSON.stringify(legacy));
    let first: ReturnType<typeof createStateService> | undefined;
    let second: ReturnType<typeof createStateService> | undefined;
    try {
      const a = stateFixture(dir);
      first = a.service;
      await first.initializeStore();
      assert.equal(a.projects.get("legacy_project")?.name, "旧项目");
      assert.equal(a.settings.apiKey, "legacy-secret");
      assert.equal((await fs.stat(path.join(dataDir, "secrets.json"))).mode & 0o777, 0o600);
      assert.ok(await fs.readFile(legacyFile, "utf-8"));
      first.closeStore();
      first = undefined;
      await fs.writeFile(legacyFile, JSON.stringify({ ...legacy, projects: [{ id: "different", name: "被修改的旧索引", conversations: [] }] }));
      const b = stateFixture(dir);
      second = b.service;
      await second.initializeStore();
      assert.equal(b.projects.get("legacy_project")?.name, "旧项目");
      assert.equal(b.projects.has("different"), false);
      assert.equal(b.settings.apiKey, "legacy-secret");
    } finally {
      first?.closeStore();
      second?.closeStore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("captures each requested checkpoint before later in-memory changes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-snapshot-order-"));
    const fixture = stateFixture(dir);
    let reader: DatabaseSync | undefined;
    try {
      await fixture.service.initializeStore();
      const project: Project = { id: "project_1", name: "原始名称", conversations: [] };
      fixture.projects.set(project.id, project);
      const firstWrite = fixture.service.persistStore();
      project.name = "后续改动";
      project.conversations.push("conversation_later");
      await firstWrite;
      reader = new DatabaseSync(path.join(dir, ".supercodex", "state.sqlite"));
      const firstRow = reader.prepare("SELECT payload FROM entities WHERE kind = ? AND id = ?").get("projects", project.id) as { payload: string };
      assert.deepEqual(JSON.parse(firstRow.payload), { id: project.id, name: "原始名称", conversations: [] });
      await fixture.service.persistStore();
      const secondRow = reader.prepare("SELECT payload FROM entities WHERE kind = ? AND id = ?").get("projects", project.id) as { payload: string };
      assert.deepEqual(JSON.parse(secondRow.payload), { id: project.id, name: "后续改动", conversations: ["conversation_later"] });
    } finally {
      reader?.close();
      fixture.service.closeStore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function stateFixture(root: string) {
  const projects = new Map<string, Project>();
  const conversations = new Map<string, Conversation>();
  const skills = new Map<string, Skill>();
  const automations = new Map<string, Automation>();
  const goals = new Map<string, Goal>();
  const approvals = new Map<string, Approval>();
  const memories = new Map<string, MemoryFact>();
  const memoryCandidates = new Map<string, MemoryCandidate>();
  const attachments = new Map<string, Attachment>();
  const settings = { baseUrl: "https://api.example.test/v1", apiKey: "", model: "test-model" };
  const attention = { mode: "important" as const, readIds: [] as string[] };
  const dataDir = path.join(root, ".supercodex");
  const service = createStateService({
    settings, attention, workspaceRoot: root, workspaceFilesDirName: "supercodex-files",
    dataDir, dataFile: path.join(dataDir, "state.json"), conversationsDir: path.join(dataDir, "conversations"),
    projects, conversations, skills, automations, goals, approvals, memories, memoryCandidates, attachments,
    toolRegistry: new ToolRegistry(), maxContextToolChars: 1000, maxContextMessageChars: 1000,
    callLLM: async () => { throw new Error("Model not expected"); },
    normalizeSkill: (skill) => skill,
    createAutomationConversation: () => { throw new Error("Automation not expected"); },
    maskSettings: () => ({}), id: (prefix) => `${prefix}_test`, now: () => "2026-10-04T00:00:00.000Z"
  });
  return { service, projects, settings };
}
