type InteractionInput = Record<string, unknown>;
type WebBridgeCall = (action: string, args: unknown, session: string) => Promise<unknown>;

export async function performApprovedWebInteraction(input: InteractionInput, call: WebBridgeCall) {
  const inspected = await inspectWebInteraction(input, call);
  if (input.verifiedElement !== inspected.element) {
    throw new Error("Browser element changed since inspection; take a fresh snapshot and retry");
  }
  return call(inspected.action, inspected.action === "fill" ? { selector: inspected.selector, value: input.value } : { selector: inspected.selector }, inspected.session);
}

export async function inspectWebInteraction(input: InteractionInput, call: WebBridgeCall) {
  const action = input.action;
  const session = input.session;
  const expectedUrl = input.expectedUrl;
  const selector = input.selector;
  const purpose = input.purpose;
  if (
    (action !== "fill" && action !== "click") ||
    typeof session !== "string" || !session.trim() ||
    typeof purpose !== "string" || !purpose.trim() ||
    typeof expectedUrl !== "string" || !/^https?:\/\//i.test(expectedUrl) ||
    typeof selector !== "string" || !/^@e\d+$/.test(selector)
  ) {
    throw new Error("Browser interaction requires fill/click, a session, purpose, HTTP(S) page URL, and snapshot @e reference");
  }
  if (action === "fill" && (typeof input.value !== "string" || input.value.length > 4000)) {
    throw new Error("Fill value must be text of at most 4000 characters");
  }
  const page = await call("snapshot", {}, session) as { url?: unknown; tree?: unknown };
  if (page.url !== expectedUrl) {
    throw new Error("Browser page changed since inspection; take a fresh snapshot and retry");
  }
  const element = findSnapshotElement(page.tree, selector);
  if (!element) {
    throw new Error("Browser element changed since inspection; take a fresh snapshot and retry");
  }
  if (action === "fill" && /password|passcode|credit.?card|cvv|security.?code|one.?time.?code|验证码|密码|银行卡/i.test(element)) {
    throw new Error("Filling credentials or payment fields requires a credential broker and is unavailable");
  }
  return { action, session, url: expectedUrl, selector, element };
}

function findSnapshotElement(tree: unknown, selector: string): string | undefined {
  if (typeof tree === "string") {
    const line = tree.split("\n").find((item) => new RegExp(`(^|\\W)${selector}(\\W|$)`).test(item));
    return line?.trim().slice(0, 300);
  }
  const pending: unknown[] = Array.isArray(tree) ? [...tree] : [tree];
  let inspected = 0;
  while (pending.length && inspected++ < 5000) {
    const node = pending.shift();
    if (!node || typeof node !== "object") continue;
    const item = node as { ref?: unknown; role?: unknown; name?: unknown; children?: unknown };
    if (item.ref === selector) {
      return `${String(item.role || "element")} ${String(item.name || "")} ${selector}`.trim().slice(0, 300);
    }
    if (Array.isArray(item.children)) pending.push(...item.children);
  }
  return undefined;
}
