import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export type PublicPageResponse = { url: string; status: number; contentType: string; text: string };

export async function fetchPublicText(input: string, options: { timeoutMs?: number; maxBytes?: number; userAgent?: string } = {}): Promise<PublicPageResponse> {
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs || 15_000, 45_000));
  const maxBytes = Math.max(1024, Math.min(options.maxBytes || 1_000_000, 2_000_000));
  let current = input;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const url = parsePublicWebUrl(current);
    const response = await requestOnce(url, timeoutMs, maxBytes, options.userAgent);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      if (redirectCount === 3) throw new Error("网页重定向次数过多");
      current = new URL(response.location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`网页读取失败（HTTP ${response.status}）`);
    return { url: url.toString(), status: response.status, contentType: response.contentType, text: response.text };
  }
  throw new Error("网页重定向次数过多");
}

export function parsePublicWebUrl(input: string) {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("网页地址无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 HTTP/HTTPS 网页地址");
  if (url.username || url.password) throw new Error("网页地址不能包含账号或密码");
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) throw new Error("网页读取仅支持标准 HTTP/HTTPS 端口");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("网页读取不能访问本机或内网地址");
  }
  if (isIP(host) && !isPublicIp(host)) throw new Error("网页读取不能访问本机或内网地址");
  return url;
}

export function isPublicIp(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const words = ipv6Words(address);
    if (!words) return false;
    const [first, second] = words;
    return first >= 0x2000 && first < 0x4000 &&
      !(first === 0x2001 && (second === 0 || second === 0x0db8)) && first !== 0x2002;
  }
  return false;
}

function ipv6Words(address: string): number[] | undefined {
  if (address.includes("%") || address.includes(".")) return undefined;
  const parts = address.toLowerCase().split("::");
  if (parts.length > 2) return undefined;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return undefined;
  const words = [...head, ...Array(missing).fill("0"), ...tail].map((part) => Number.parseInt(part, 16));
  return words.length === 8 && words.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? words : undefined;
}

async function requestOnce(url: URL, timeoutMs: number, maxBytes: number, userAgent?: string) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lookup = (hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family?: number) => void) => {
    void dnsLookup(hostname, { all: true }).then((addresses) => {
      const selected = addresses.find((item) => isPublicIp(item.address));
      if (!selected) { callback(new Error("网页地址解析到了本机或内网") as NodeJS.ErrnoException, ""); return; }
      callback(null, selected.address, selected.family);
    }, (error) => callback(error as NodeJS.ErrnoException, ""));
  };
  if (isIP(host) && !isPublicIp(host)) throw new Error("网页读取不能访问本机或内网地址");
  return await new Promise<{ status: number; location?: string; contentType: string; text: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "GET",
      lookup,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "accept-encoding": "identity", "user-agent": userAgent || "SuperCodex public page reader" }
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new Error("网页内容超过读取上限")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        location: typeof response.headers.location === "string" ? response.headers.location : undefined,
        contentType: String(response.headers["content-type"] || ""),
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end();
  });
}
