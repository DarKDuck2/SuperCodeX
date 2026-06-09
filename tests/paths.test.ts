import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { normalizeLocalPath, safeResolvePath, sanitizeFileName } from "../server/core/paths.js";

describe("path safety", () => {
  const root = path.resolve("/tmp/supercodex-workspace");

  it("resolves paths inside the workspace", () => {
    assert.equal(safeResolvePath("src/App.tsx", root), path.join(root, "src/App.tsx"));
  });

  it("rejects paths outside the workspace", () => {
    assert.throws(() => safeResolvePath("../secret.txt", root), /outside workspace/);
  });

  it("normalizes home-relative paths", () => {
    assert.equal(normalizeLocalPath("~/demo", "/Users/example"), path.resolve("/Users/example/demo"));
  });

  it("sanitizes file names without preserving parent directories", () => {
    assert.equal(sanitizeFileName("../hello world!.md"), "hello_world_.md");
  });
});
