import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isProtectedAgentPath, resolveAgentReadPath, resolveAgentWritePath } from "../server/core/agent-paths.js";
import { executeStructuredCommand, sanitizedChildEnvironment } from "../server/tools/command.js";
import { registerServerTools } from "../server/tools/register.js";
import { ToolRegistry } from "../server/tools/registry.js";

test("automatic workspace reads exclude runtime credentials and symlink escapes", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-agent-boundary-"));
  const workspacePath = path.join(parent, "workspace");
  const outsidePath = path.join(parent, "outside.txt");
  await fs.mkdir(path.join(workspacePath, ".supercodex"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, ".env"), "PRIVATE_MARKER_FROM_ENV");
  await fs.writeFile(path.join(workspacePath, ".supercodex", "secrets.json"), "PRIVATE_MARKER_FROM_STATE");
  await fs.writeFile(path.join(workspacePath, "readme.txt"), "ordinary project content");
  await fs.writeFile(outsidePath, "PRIVATE_MARKER_OUTSIDE");
  await fs.symlink(outsidePath, path.join(workspacePath, "outside-link"));
  await fs.symlink(parent, path.join(workspacePath, "outside-dir"));
  const context = { workspacePath, outputPath: workspacePath, attachments: [] };
  const registry = new ToolRegistry();
  registerServerTools({
    toolRegistry: registry,
    workspaceRoot: workspacePath,
    claudeCodeExecutable: "claude",
    claudeCodeArgs: [],
    claudeCodeTimeoutMs: 10_000,
    attachments: new Map(),
    persistStore: async () => {},
    searchSkillCatalog: () => [],
    loadSkillById: () => undefined,
    publicSkillSummary: () => ({}),
    resolveGeneratedFilePath: (inputPath) => path.resolve(workspacePath, inputPath),
    resolveCommandCwd: async () => workspacePath,
    buildClaudeCodePrompt: () => "",
    formatAttachmentLine: () => "",
    requireAttachment: () => { throw new Error("No attachments"); },
    getWebBridgeStatus: async () => ({ running: false, extension_connected: false, port: 0, version: "" }),
    callWebBridge: async () => ({}),
    summarizeWebBridgePayload: () => "",
    id: () => "id",
    now: () => new Date().toISOString()
  });
  try {
    const read = registry.get("read_file")!.handler;
    const search = registry.get("search_files")!.handler;
    const list = registry.get("list_directory")!.handler;
    const replace = registry.get("replace_in_file")!.handler;
    const write = registry.get("write_file")!.handler;
    assert.match(String(await read({ path: "readme.txt" }, context)), /ordinary project content/);
    await assert.rejects(read({ path: ".env" }, context), /credential or runtime state/);
    await assert.rejects(read({ path: ".supercodex\/secrets.json" }, context), /credential or runtime state/);
    await assert.rejects(read({ path: "outside-link" }, context), /outside workspace/);
    const names = String(await list({ path: "." }, context));
    assert.match(names, /readme.txt/);
    assert.doesNotMatch(names, /\.env|\.supercodex/);
    assert.equal(await search({ query: "PRIVATE_MARKER" }, context), "No matches found.");
    assert.equal(await search({ query: "--files" }, context), "No matches found.");
    await assert.rejects(search({ query: "PRIVATE_MARKER", path: ".env" }, context), /credential or runtime state/);
    await assert.rejects(replace({ path: "outside-link", search: "PRIVATE", replace: "CHANGED" }, context), /outside workspace/);
    await assert.rejects(write({ path: "outside-dir/new.txt", content: "bad" }, context), /outside workspace/);
    assert.equal(await fs.readFile(outsidePath, "utf8"), "PRIVATE_MARKER_OUTSIDE");
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test("agent path resolver blocks credential names and dangling symlinks", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "supercodex-agent-paths-"));
  try {
    assert.equal(isProtectedAgentPath(".env.example"), false);
    assert.equal(isProtectedAgentPath("sub/.env.production"), true);
    assert.equal(isProtectedAgentPath(".config/gcloud/auth.json"), true);
    await fs.writeFile(path.join(workspacePath, ".env.example"), "placeholder");
    assert.equal(await resolveAgentReadPath(".env.example", workspacePath), path.join(workspacePath, ".env.example"));
    await fs.symlink(path.join(workspacePath, "missing-target"), path.join(workspacePath, "dangling"));
    await assert.rejects(resolveAgentWritePath("dangling", workspacePath), /dangling symlink/);
  } finally { await fs.rm(workspacePath, { recursive: true, force: true }); }
});

test("approved child commands do not inherit credential environment variables", async () => {
  const clean = sanitizedChildEnvironment({ PATH: "/usr/bin", API_KEY: "secret", GOOGLE_OAUTH_CLIENT_SECRET: "secret", SSH_AUTH_SOCK: "/tmp/socket", CI: "true" });
  assert.equal(clean.API_KEY, undefined);
  assert.equal(clean.GOOGLE_OAUTH_CLIENT_SECRET, undefined);
  assert.equal(clean.SSH_AUTH_SOCK, undefined);
  assert.equal(clean.CI, "true");
  const previous = process.env.SUPERCODEX_BOUNDARY_TEST_TOKEN;
  process.env.SUPERCODEX_BOUNDARY_TEST_TOKEN = "must-not-inherit";
  try {
    const result = await executeStructuredCommand({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(String(process.env.SUPERCODEX_BOUNDARY_TEST_TOKEN || 'not-inherited'))"],
      display: "node -e <test>", source: "argv"
    }, { cwd: process.cwd(), timeout: 5000, maxBuffer: 1024 });
    assert.equal(result.stdout, "not-inherited");
  } finally {
    if (previous === undefined) delete process.env.SUPERCODEX_BOUNDARY_TEST_TOKEN;
    else process.env.SUPERCODEX_BOUNDARY_TEST_TOKEN = previous;
  }
});
