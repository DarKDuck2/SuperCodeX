import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const scope = "https://www.googleapis.com/auth/calendar.events.readonly";
const tokenUrl = "https://oauth2.googleapis.com/token";
const revokeUrl = "https://oauth2.googleapis.com/revoke";

type Credentials = {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type PendingAuthorization = { state: string; verifier: string; redirectUri: string; expiresAt: number };

export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  updated?: string;
  location?: string;
  htmlLink?: string;
};

export function createGoogleCalendarService(options: {
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  initialClientId?: string;
  initialClientSecret?: string;
}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const credentialsPath = path.join(options.dataDir, "google-calendar.json");
  let credentials: Credentials = { clientId: options.initialClientId || "", clientSecret: options.initialClientSecret || "" };
  let pending: PendingAuthorization | undefined;

  async function persist() {
    await fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(options.dataDir, 0o700);
    const tempPath = `${credentialsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(credentials), { mode: 0o600 });
      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, credentialsPath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function initialize() {
    try {
      const parsed = JSON.parse(await fs.readFile(credentialsPath, "utf8")) as Partial<Credentials>;
      credentials = {
        clientId: typeof parsed.clientId === "string" ? parsed.clientId : credentials.clientId,
        clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret : credentials.clientSecret,
        accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : undefined,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined
      };
      await fs.chmod(credentialsPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  function status() {
    return { configured: Boolean(credentials.clientId), connected: Boolean(credentials.refreshToken || credentials.accessToken), clientId: credentials.clientId };
  }

  async function configure(clientId: string, clientSecret?: string) {
    const normalized = clientId.trim();
    if (!/^[a-zA-Z0-9._-]{10,300}\.apps\.googleusercontent\.com$/.test(normalized)) throw new Error("请输入有效的 Google 桌面应用 OAuth Client ID");
    if (credentials.clientId !== normalized && (credentials.refreshToken || credentials.accessToken)) throw new Error("请先断开现有日历连接，再更换 Client ID");
    if (credentials.clientId !== normalized) {
      credentials = { clientId: normalized, clientSecret: clientSecret?.trim() || "" };
      pending = undefined;
    } else if (clientSecret !== undefined) {
      credentials.clientSecret = clientSecret.trim();
    }
    await persist();
    return status();
  }

  function beginAuthorization(redirectUri: string) {
    if (!credentials.clientId) throw new Error("请先配置 Google 桌面应用 OAuth Client ID");
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(redirectUri)) throw new Error("OAuth 回调地址无效");
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    pending = { state, verifier, redirectUri, expiresAt: now() + 10 * 60_000 };
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  async function tokenRequest(body: URLSearchParams) {
    const response = await fetchImpl(tokenUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Google 授权令牌请求失败（HTTP ${response.status}）`);
    return await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  }

  async function completeAuthorization(input: { state?: string; code?: string; error?: string }) {
    const current = pending;
    pending = undefined;
    if (!current || !input.state || input.state !== current.state || current.expiresAt < now()) throw new Error("授权状态无效或已过期，请重新连接");
    if (input.error) throw new Error("Google 授权未完成");
    if (!input.code) throw new Error("授权回调缺少 code");
    const body = new URLSearchParams({
      client_id: credentials.clientId, code: input.code, code_verifier: current.verifier,
      redirect_uri: current.redirectUri, grant_type: "authorization_code"
    });
    if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);
    const token = await tokenRequest(body);
    if (!token.access_token || !token.scope?.split(" ").includes(scope)) throw new Error("Google 未授予日历事件只读权限");
    if (!token.refresh_token && !credentials.refreshToken) throw new Error("Google 未返回可续期的授权，请重新连接");
    credentials.accessToken = token.access_token;
    credentials.refreshToken = token.refresh_token || credentials.refreshToken;
    credentials.expiresAt = now() + Math.max(60, token.expires_in || 3600) * 1000;
    await persist();
    return status();
  }

  async function getAccessToken() {
    if (credentials.accessToken && (credentials.expiresAt || 0) > now() + 60_000) return credentials.accessToken;
    if (!credentials.refreshToken) throw new Error("Google 日历未连接或授权已失效");
    const body = new URLSearchParams({ client_id: credentials.clientId, refresh_token: credentials.refreshToken, grant_type: "refresh_token" });
    if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);
    const token = await tokenRequest(body);
    if (!token.access_token) throw new Error("Google 日历令牌刷新失败，请重新连接");
    credentials.accessToken = token.access_token;
    credentials.expiresAt = now() + Math.max(60, token.expires_in || 3600) * 1000;
    await persist();
    return credentials.accessToken;
  }

  async function listEvents(timeMin: string, timeMax: string, options: { maxEvents?: number; requireComplete?: boolean } = {}): Promise<CalendarEvent[]> {
    const start = Date.parse(timeMin);
    const end = Date.parse(timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 24 * 60 * 60_000) {
      throw new Error("请提供不超过 31 天的有效时间范围");
    }
    const token = await getAccessToken();
    const maxEvents = Math.max(1, Math.min(500, Math.floor(options.maxEvents || 50)));
    const rawItems: Array<Record<string, unknown>> = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      url.searchParams.set("timeMin", new Date(start).toISOString());
      url.searchParams.set("timeMax", new Date(end).toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(Math.min(250, maxEvents - rawItems.length)));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Google 日历读取失败（HTTP ${response.status}）`);
      const payload = await response.json() as { items?: Array<Record<string, unknown>>; nextPageToken?: string };
      rawItems.push(...(payload.items || []).slice(0, maxEvents - rawItems.length));
      pageToken = payload.nextPageToken;
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) throw new Error("Google 日历返回重复分页标记");
        seenPageTokens.add(pageToken);
      }
      if (rawItems.length >= maxEvents) {
        if (pageToken && options.requireComplete) throw new Error("近期日历事件超过 500 条，触发器未更新游标，请缩短监控范围");
        break;
      }
    } while (pageToken);
    return rawItems.map((item) => {
      const startValue = item.start as { dateTime?: string; date?: string } | undefined;
      const endValue = item.end as { dateTime?: string; date?: string } | undefined;
      return {
        id: String(item.id || "").slice(0, 256),
        summary: String(item.summary || "(无标题)").slice(0, 300),
        start: String(startValue?.dateTime || startValue?.date || ""),
        end: String(endValue?.dateTime || endValue?.date || ""),
        ...(typeof item.updated === "string" ? { updated: item.updated } : {}),
        ...(typeof item.location === "string" ? { location: item.location.slice(0, 300) } : {}),
        ...(typeof item.htmlLink === "string" && item.htmlLink.startsWith("https://calendar.google.com/") ? { htmlLink: item.htmlLink } : {})
      };
    });
  }

  async function disconnect() {
    const token = credentials.refreshToken || credentials.accessToken;
    credentials = { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
    pending = undefined;
    await persist();
    if (!token) return { revoked: true };
    try {
      const response = await fetchImpl(revokeUrl, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15_000)
      });
      return { revoked: response.ok };
    } catch { return { revoked: false }; }
  }

  return { initialize, status, configure, beginAuthorization, completeAuthorization, listEvents, disconnect };
}

export type GoogleCalendarService = ReturnType<typeof createGoogleCalendarService>;
