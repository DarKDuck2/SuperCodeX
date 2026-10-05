import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectWebInteraction, performApprovedWebInteraction } from "../server/webbridge/interaction.js";

const input = {
  action: "fill",
  session: "goal-research",
  expectedUrl: "https://example.com/form",
  selector: "@e12",
  value: "报告草稿",
  purpose: "填写报告标题"
};

describe("approved browser interaction", () => {
  it("inspects the actual page and element before filling", async () => {
    const calls: string[] = [];
    const bridge = async (action: string, args: unknown, session: string) => {
      calls.push(action);
      assert.equal(session, input.session);
      if (action === "snapshot") return { url: input.expectedUrl, tree: [{ role: "textbox", name: "标题", ref: "@e12" }, { role: "button", name: "提交", ref: "@e13" }] };
      assert.deepEqual(args, { selector: "@e12", value: "报告草稿" });
      return { success: true };
    };
    const inspected = await inspectWebInteraction(input, bridge);
    assert.match(inspected.element, /标题/);
    assert.deepEqual(await performApprovedWebInteraction({ ...input, verifiedElement: inspected.element }, bridge), { success: true });
    assert.deepEqual(calls, ["snapshot", "snapshot", "fill"]);
  });

  it("blocks a changed page or element after approval", async () => {
    const calls: string[] = [];
    const changedPage = async (action: string) => {
      calls.push(action);
      return { url: "https://example.com/other", tree: "textbox 标题 @e12" };
    };
    await assert.rejects(performApprovedWebInteraction({ ...input, verifiedElement: "textbox 标题 @e12" }, changedPage), /page changed/);
    assert.deepEqual(calls, ["snapshot"]);
    await assert.rejects(
      performApprovedWebInteraction({ ...input, verifiedElement: "textbox 标题 @e12" }, async () => ({ url: input.expectedUrl, tree: "textbox 其他 @e20" })),
      /element changed/
    );
    await assert.rejects(
      performApprovedWebInteraction({ ...input, verifiedElement: "textbox 标题 @e12" }, async () => ({ url: input.expectedUrl, tree: [{ role: "button", name: "删除", ref: "@e12" }] })),
      /element changed/
    );
  });

  it("blocks credential fields and unsupported browser actions", async () => {
    const bridge = async () => ({ url: input.expectedUrl, tree: "textbox 密码 @e12" });
    await assert.rejects(performApprovedWebInteraction({ ...input, verifiedElement: "textbox 密码 @e12" }, bridge), /credential broker/);
    await assert.rejects(
      performApprovedWebInteraction({ ...input, action: "evaluate" }, bridge),
      /requires fill\/click/
    );
    await assert.rejects(
      performApprovedWebInteraction({ ...input, selector: "button.submit" }, bridge),
      /snapshot @e/
    );
  });
});
