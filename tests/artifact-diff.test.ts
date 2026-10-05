import assert from "node:assert/strict";
import { test } from "node:test";
import { compareArtifactText } from "../src/lib/artifact-diff.js";

test("artifact comparison marks old and current lines while preserving context", () => {
  assert.deepEqual(compareArtifactText("标题\n旧结论\n来源", "标题\n新结论\n来源"), [
    { kind: "same", text: "标题" },
    { kind: "removed", text: "旧结论" },
    { kind: "added", text: "新结论" },
    { kind: "same", text: "来源" }
  ]);
  assert.equal(compareArtifactText(Array(401).fill("旧").join("\n"), "新"), undefined);
});
