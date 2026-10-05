import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWhitespace, stripAnsi } from "../core/text.js";
import { htmlToReadableText, looksLikeHtml } from "../web/readability.js";

const execFileAsync = promisify(execFile);

export function createWebBridgeService() {
  async function getWebBridgeStatus() {
    const binPath = path.join(process.env.HOME || "", ".kimi-webbridge", "bin", "kimi-webbridge");
    const { stdout } = await execFileAsync(binPath, ["status"], {
      timeout: 10_000,
      maxBuffer: 1024 * 256
    });
    return JSON.parse(stdout) as {
      running: boolean;
      extension_connected: boolean;
      port: number;
      version: string;
      extension_version?: string;
    };
  }
  
  async function callWebBridge(action: string, args: unknown, session: string) {
    const status = await getWebBridgeStatus();
    if (!status.running) {
      throw new Error("Kimi WebBridge daemon is not running");
    }
    if (!status.extension_connected && action !== "list_tabs") {
      throw new Error("Kimi WebBridge extension is not connected. Install/enable it at https://kimi.com/features/webbridge");
    }
    const response = await fetch(`http://127.0.0.1:${status.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, args: args || {}, session })
    });
    const payload = (await response.json()) as { ok?: boolean; data?: unknown; error?: string };
    if (!response.ok || payload.ok === false) {
      throw new Error(payload?.error || `WebBridge command failed: ${response.status}`);
    }
    return payload.ok === true && "data" in payload ? payload.data : payload;
  }
  
  function summarizeWebBridgePayload(action: string, payload: unknown) {
    const cleaned = cleanWebPayload(payload);
    if (typeof cleaned === "string") {
      return `WebBridge ${action} result:\n${cleaned.slice(0, 8000)}`;
    }
    return `WebBridge ${action} result:\n${JSON.stringify(cleaned, null, 2).slice(0, 9000)}`;
  }
  
  function cleanWebPayload(value: unknown, depth = 0): unknown {
    if (depth > 5) return "[truncated]";
    if (typeof value === "string") {
      if (looksLikeHtml(value)) return htmlToReadableText(value).slice(0, 4000);
      return normalizeWhitespace(stripAnsi(value)).slice(0, 4000);
    }
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => cleanWebPayload(item, depth + 1));
    if (value && typeof value === "object") {
      const input = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      const preferredKeys = [
        "action",
        "status",
        "title",
        "url",
        "text",
        "visibleText",
        "summary",
        "tabs",
        "result",
        "results",
        "error"
      ];
      const keys = Object.keys(input);
      const orderedKeys = [
        ...preferredKeys.filter((key) => key in input),
        ...keys.filter((key) => !preferredKeys.includes(key)).slice(0, 20)
      ];
      for (const key of orderedKeys) {
        if (/^(html|outerHTML|innerHTML|dom|snapshot|source|markup)$/i.test(key)) {
          const text = typeof input[key] === "string" ? htmlToReadableText(input[key] as string) : cleanWebPayload(input[key], depth + 1);
          output[`${key}Text`] = text;
          continue;
        }
        output[key] = cleanWebPayload(input[key], depth + 1);
      }
      return output;
    }
    return value;
  }

  return {
    getWebBridgeStatus,
    callWebBridge,
    summarizeWebBridgePayload
  };
}
