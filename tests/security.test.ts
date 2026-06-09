import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertCommandAllowed, getBlockedCommandReason } from "../server/core/security.js";

describe("command safety", () => {
  it("allows ordinary read-only commands", () => {
    assert.equal(getBlockedCommandReason("npm run build"), "");
    assert.doesNotThrow(() => assertCommandAllowed("rg TODO src"));
  });

  it("blocks destructive shell commands", () => {
    assert.match(getBlockedCommandReason("rm -rf dist"), /deletion/);
    assert.match(getBlockedCommandReason("git reset --hard HEAD"), /reset/);
    assert.throws(() => assertCommandAllowed("sudo reboot"), /blocked/);
  });
});
